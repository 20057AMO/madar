import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import { register } from 'node:module';
import { signTestToken, API_URL, initTestAuth } from './helpers.ts';

// secret-box imports ./jwt-secret extensionless (correct for the compiled CJS,
// unresolvable by node's ESM loader) — see tests/ts-ext-resolve.mjs.
register(new URL('./ts-ext-resolve.mjs', import.meta.url).href);
const { isSealed, maskStored, openSecret, sealSecret } = await import('../src/services/secret-box.ts');

/**
 * ════════════════════════════════════════════════════════════════
 *  SECRET BOX — AES-256-GCM at-rest encryption for provider keys
 * ════════════════════════════════════════════════════════════════
 *  Part 1 — algorithm unit tests (always run)
 *  Part 2 — end-to-end sealing through the real API (needs
 *           WSD_TEST_ACCOUNT_PASSWORD; asserts the on-disk file only
 *           when WSD_TEST_PROVIDERS_FILE points at the server's
 *           providers.json, e.g. an isolated-server scratch copy)
 */

describe('secret-box · algorithm', () => {
  before(async () => { await initTestAuth(); });

  test('roundtrip seal → open preserves the secret', () => {
    const samples = [
      'sk-plain-latin-1234567890',
      'AIzaSyArabic-\u0645\u0641\u062a\u0627\u062d-9876',
      'x'.repeat(300),
      ' short ',
    ];
    for (const s of samples) {
      assert.strictEqual(openSecret(sealSecret(s)), s);
    }
  });

  test('ciphertext format: prefix, five parts, trailing last4', () => {
    const secret = 'sk-format-check-abcd';
    const sealed = sealSecret(secret);
    assert.ok(isSealed(sealed));
    const parts = sealed.split(':');
    assert.strictEqual(parts.length, 5);
    assert.strictEqual(parts[0], 'enc1');
    assert.ok(parts[1] && parts[2] && parts[3]);
    assert.strictEqual(parts[4], 'abcd');
  });

  test('every seal uses a fresh IV — identical inputs differ', () => {
    assert.notStrictEqual(sealSecret('same-input'), sealSecret('same-input'));
  });

  test('sealing an already-sealed value is a no-op', () => {
    const once = sealSecret('sk-twice');
    assert.strictEqual(sealSecret(once), once);
  });

  test('empty strings pass through unsealed', () => {
    const out = sealSecret('');
    assert.strictEqual(out, '');
    assert.strictEqual(isSealed(out), false);
  });

  test('plaintext values open untouched (legacy rows)', () => {
    assert.strictEqual(openSecret('sk-never-sealed'), 'sk-never-sealed');
    assert.strictEqual(openSecret(''), '');
  });

  test('tampered ciphertext or tag refuses to open (returns empty)', () => {
    const sealed = sealSecret('sk-tamper-target-7777');
    const [p, iv, tag, ct, last4] = sealed.split(':');

    const flipLastByte = (b64: string) => {
      const buf = Buffer.from(b64, 'base64');
      buf[buf.length - 1] ^= 0xff;
      return buf.toString('base64');
    };
    assert.strictEqual(openSecret([p, iv, tag, flipLastByte(ct), last4].join(':')), '');
    assert.strictEqual(openSecret([p, iv, flipLastByte(tag), ct, last4].join(':')), '');
  });

  test('masking never decrypts and mirrors maskKey shape', () => {
    const secret = 'sk-visible-tail-9x2q';
    assert.strictEqual(maskStored(sealSecret(secret)), '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u20229x2q');
    assert.strictEqual(maskStored(secret), '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u20229x2q');
    assert.strictEqual(maskStored('abc'), '\u2022\u2022\u2022\u2022');
    assert.strictEqual(maskStored(''), '');
    // damaged last4 segment degrades gracefully instead of throwing
    const broken = sealSecret(secret).replace(/:[^:]+$/, ':');
    assert.strictEqual(maskStored(broken), '\u2022\u2022\u2022\u2022');
  });
});

// ── Part 2 · end-to-end through the HTTP API ────────────────────

describe('secret-box · providers.json sealed on disk', () => {
  const accountPassword = process.env.WSD_TEST_ACCOUNT_PASSWORD || '';
  const PROVIDERS_FILE = process.env.WSD_TEST_PROVIDERS_FILE || '';
  const KEY = `enc-e2e-${Date.now().toString(36)}-tail88`;
  let id = '';

  const h = () => ({ Authorization: `Bearer ${signTestToken()}`, 'Content-Type': 'application/json' });

  test('created key exists ONLY as ciphertext everywhere', async (t) => {
    if (!accountPassword) return t.skip('WSD_TEST_ACCOUNT_PASSWORD not set');
    const res = await fetch(`${API_URL}/providers`, {
      method: 'POST',
      headers: h(),
      body: JSON.stringify({ name: 'tstj-enc-roundtrip', host: 'https://api.openai.com/v1', type: 'openai', apiKey: KEY }),
    });
    assert.strictEqual(res.status, 201);
    id = (await res.json()).provider.id;

    const listJson = JSON.stringify(await (await fetch(`${API_URL}/providers`, { headers: h() })).json());
    assert.ok(!listJson.includes(KEY), 'raw key must never appear in any API response');
    assert.ok(!listJson.includes('enc1:'), 'sealed blobs must not leak through the list either');

    if (!PROVIDERS_FILE) return t.skip('WSD_TEST_PROVIDERS_FILE not set — file assertions skipped');
    const raw = fs.readFileSync(PROVIDERS_FILE, 'utf8');
    assert.ok(!raw.includes(KEY), 'plaintext must not be written to disk');
    const entry = JSON.parse(raw)[id];
    assert.ok(entry, 'provider persisted');
    assert.strictEqual(isSealed(entry.apiKey), true, 'stored apiKey carries the enc1 prefix');
    assert.strictEqual(openSecret(entry.apiKey), KEY, 'roundtrip against the live salt+key');
  });

  test('key update re-seals; delete removes the blob', async (t) => {
    if (!accountPassword) return t.skip('WSD_TEST_ACCOUNT_PASSWORD not set');
    const KEY2 = `${KEY}-v2`;
    await fetch(`${API_URL}/providers/${id}`, {
      method: 'PUT',
      headers: h(),
      body: JSON.stringify({ apiKey: KEY2 }),
    });

    if (PROVIDERS_FILE) {
      const entry = JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8'))[id];
      assert.strictEqual(isSealed(entry.apiKey), true);
      assert.ok(!fs.readFileSync(PROVIDERS_FILE, 'utf8').includes(KEY2));
      assert.strictEqual(openSecret(entry.apiKey), KEY2);
    }

    await fetch(`${API_URL}/providers/${id}`, { method: 'DELETE', headers: h() });
    const list = await (await fetch(`${API_URL}/providers`, { headers: h() })).json();
    assert.ok(!(list.providers ?? []).some((p: any) => p.id === id), 'deleted provider gone');
  });
});
