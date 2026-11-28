import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { register } from 'node:module';
import { signTestToken, API_URL, initTestAuth } from './helpers.ts';

// secret-box imports ./jwt-secret extensionless (correct for the compiled CJS,
// unresolvable by node's ESM loader) — see tests/ts-ext-resolve.mjs.
register(new URL('./ts-ext-resolve.mjs', import.meta.url).href);
const { isSealed, isLegacySealed, maskStored, openSecret, openSecretStrict, sealSecret } =
  await import('../src/services/secret-box.ts');

/**
 * ════════════════════════════════════════════════════════════════
 *  SECRET BOX — AES-256-GCM at-rest encryption for provider keys
 * ════════════════════════════════════════════════════════════════
 *  Part 1 — algorithm unit tests (always run; isolated temp data dir)
 *  Part 2 — end-to-end sealing through the real API (needs
 *           WSD_TEST_ACCOUNT_PASSWORD; asserts the on-disk file only
 *           when WSD_TEST_PROVIDERS_FILE points at the server's
 *           providers.json, e.g. an isolated-server scratch copy)
 */

const V2 = 'v2';
const LEGACY = 'enc1';
const SALT_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const LEGACY_MASTER = 'legacy-master-only-for-tests-0123456789';
const ENC_KEY = 'enc-key-override-for-tests-0123456789abcdef';
const MASK8 = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
const MASK4 = '\u2022\u2022\u2022\u2022';

interface SavedEnv {
  WSD_DATA_DIR?: string;
  WSD_ENC_KEY?: string;
  WSD_ENCRYPTION_KEY?: string;
  JWT_SECRET?: string;
}

function flipLastByte(b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  buf[buf.length - 1] ^= 0xff;
  return buf.toString('base64');
}

function legacySeal(plain: string, dataDir: string, master: string): string {
  const salt = Buffer.from(fs.readFileSync(path.join(dataDir, 'crypto.salt'), 'utf8').trim(), 'hex');
  const key = crypto.scryptSync(master, salt, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [
    LEGACY,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ct.toString('base64'),
    plain.slice(-4),
  ].join(':');
}

describe('secret-box · algorithm', () => {
  const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'madar-secret-box-'));
  let savedEnv: SavedEnv = {};

  before(() => {
    savedEnv = {
      WSD_DATA_DIR: process.env.WSD_DATA_DIR,
      WSD_ENC_KEY: process.env.WSD_ENC_KEY,
      WSD_ENCRYPTION_KEY: process.env.WSD_ENCRYPTION_KEY,
      JWT_SECRET: process.env.JWT_SECRET,
    };
    process.env.WSD_DATA_DIR = TMP_DIR;
    delete process.env.WSD_ENC_KEY;
    process.env.WSD_ENCRYPTION_KEY = LEGACY_MASTER;
    fs.writeFileSync(path.join(TMP_DIR, 'crypto.salt'), SALT_HEX + '\n', { mode: 0o600 });
  });

  after(() => {
    for (const key of Object.keys(savedEnv) as Array<keyof SavedEnv>) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  test('roundtrip seal → open preserves the secret', () => {
    const samples = [
      'sk-plain-latin-1234567890',
      'AIzaSyArabic-\u0645\u0641\u062a\u0627\u062d-9876',
      'x'.repeat(300),
      ' short ',
    ];
    for (const s of samples) {
      assert.strictEqual(openSecretStrict(sealSecret(s)), s);
      assert.strictEqual(openSecret(sealSecret(s)), s);
    }
  });

  test('ciphertext format: v2, five parts, 12-byte IV, 16-byte tag, trailing last4', () => {
    const secret = 'sk-format-check-abcd';
    const sealed = sealSecret(secret);
    assert.ok(isSealed(sealed));
    assert.ok(!isLegacySealed(sealed));
    const parts = sealed.split(':');
    assert.strictEqual(parts.length, 5);
    assert.strictEqual(parts[0], V2);
    assert.strictEqual(Buffer.from(parts[1], 'base64').length, 12);
    assert.strictEqual(Buffer.from(parts[2], 'base64').length, 16);
    assert.ok(Buffer.from(parts[3], 'base64').length > 0);
    assert.strictEqual(parts[4], 'abcd');
  });

  test('current key is a dedicated 0600 file, never jwt.secret', () => {
    const sealed = sealSecret('sk-dedicated-key-11aa');
    assert.ok(isSealed(sealed));
    const keyFile = path.join(TMP_DIR, 'enc.key');
    assert.ok(fs.existsSync(keyFile), 'enc.key was auto-generated');
    assert.match(fs.readFileSync(keyFile, 'utf8').trim(), /^[0-9a-fA-F]{64}$/);
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(keyFile).mode & 0o777, 0o600);
    }
    assert.ok(!fs.existsSync(path.join(TMP_DIR, 'jwt.secret')), 'provider key must not create jwt.secret');
    assert.strictEqual(openSecretStrict(sealed), 'sk-dedicated-key-11aa');
  });

  test('every seal uses a fresh IV — identical inputs differ', () => {
    const a = sealSecret('same-input');
    const b = sealSecret('same-input');
    assert.notStrictEqual(a, b);
    assert.notStrictEqual(a.split(':')[1], b.split(':')[1]);
    assert.strictEqual(openSecretStrict(a), 'same-input');
    assert.strictEqual(openSecretStrict(b), 'same-input');
  });

  test('sealing an already-current value is a no-op', () => {
    const once = sealSecret('sk-twice');
    assert.strictEqual(sealSecret(once), once);
  });

  test('empty strings pass through unsealed', () => {
    const out = sealSecret('');
    assert.strictEqual(out, '');
    assert.strictEqual(isSealed(out), false);
  });

  test('plaintext values open untouched (legacy rows)', () => {
    assert.strictEqual(openSecretStrict('sk-never-sealed'), 'sk-never-sealed');
    assert.strictEqual(openSecret(''), '');
  });

  test('tampered ciphertext or tag fails authentication: strict throws, lenient returns empty', () => {
    const sealed = sealSecret('sk-tamper-target-7777');
    const [p, iv, tag, ct, last4] = sealed.split(':');

    const badCt = [p, iv, tag, flipLastByte(ct), last4].join(':');
    const badTag = [p, iv, flipLastByte(tag), ct, last4].join(':');
    for (const tampered of [badCt, badTag]) {
      assert.throws(() => openSecretStrict(tampered));
      assert.strictEqual(openSecret(tampered), '');
    }
  });

  test('legacy enc1 blob still decrypts with the old derivation', () => {
    const plain = 'sk-legacy-secret-5678';
    const legacy = legacySeal(plain, TMP_DIR, LEGACY_MASTER);
    assert.ok(isLegacySealed(legacy));
    assert.ok(!isSealed(legacy));
    assert.strictEqual(openSecretStrict(legacy), plain);
    assert.strictEqual(maskStored(legacy), MASK8 + '5678');
  });

  test('wrong legacy master cannot open an enc1 blob', () => {
    const plain = 'sk-legacy-wrong-master-2468';
    const legacy = legacySeal(plain, TMP_DIR, LEGACY_MASTER);
    const previous = process.env.WSD_ENCRYPTION_KEY;
    process.env.WSD_ENCRYPTION_KEY = 'wrong-legacy-master-0123456789';
    try {
      assert.throws(() => openSecretStrict(legacy));
      assert.strictEqual(openSecret(legacy), '');
    } finally {
      process.env.WSD_ENCRYPTION_KEY = previous;
    }
  });

  test('legacy enc1 blob is re-sealed as v2 on save, preserving mask and plaintext', () => {
    const plain = 'sk-migrate-me-abcd';
    const legacy = legacySeal(plain, TMP_DIR, LEGACY_MASTER);
    const migrated = sealSecret(legacy);

    assert.ok(isSealed(migrated));
    assert.ok(!isLegacySealed(migrated));
    assert.strictEqual(migrated.split(':')[0], V2);
    assert.strictEqual(openSecretStrict(migrated), plain);
    assert.strictEqual(maskStored(migrated), maskStored(legacy));
    assert.strictEqual(sealSecret(migrated), migrated);
  });

  test('unreadable legacy blob is preserved byte-for-byte instead of being zeroed', () => {
    const legacy = legacySeal('sk-preserve-ff00', TMP_DIR, LEGACY_MASTER);
    const [p, iv, tag, ct, last4] = legacy.split(':');
    const damaged = [p, iv, flipLastByte(tag), ct, last4].join(':');
    assert.strictEqual(sealSecret(damaged), damaged);
  });

  test('v2 ciphertext is independent of JWT_SECRET and the legacy master', () => {
    const plain = 'sk-v2-independent-1357';
    const sealed = sealSecret(plain);
    const savedJwt = process.env.JWT_SECRET;
    const savedLegacy = process.env.WSD_ENCRYPTION_KEY;
    try {
      process.env.JWT_SECRET = 'jwt-secret-changed-for-test-0123456789abcdef';
      delete process.env.WSD_ENCRYPTION_KEY;
      assert.strictEqual(openSecretStrict(sealed), plain);
    } finally {
      if (savedJwt === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = savedJwt;
      process.env.WSD_ENCRYPTION_KEY = savedLegacy;
    }
  });

  test('WSD_ENC_KEY override is validated and never echoed', () => {
    const override = ENC_KEY;
    process.env.WSD_ENC_KEY = override;
    try {
      const plain = 'sk-env-override-4321';
      const sealed = sealSecret(plain);
      assert.ok(isSealed(sealed));
      assert.strictEqual(openSecretStrict(sealed), plain);
      assert.ok(!sealed.includes(override), 'raw override must not appear in ciphertext');

      process.env.WSD_ENC_KEY = 'different-override-0123456789abcdef';
      assert.throws(() => openSecretStrict(sealed));
      assert.strictEqual(openSecret(sealed), '');

      const invalid = 'short';
      process.env.WSD_ENC_KEY = invalid;
      assert.throws(
        () => sealSecret('sk-invalid-override'),
        (err: unknown) => {
          const message = (err as Error).message;
          assert.strictEqual(message, 'WSD_ENC_KEY must contain between 16 and 1024 non-blank characters');
          assert.ok(!message.includes(invalid), 'error must not echo the rejected value');
          return true;
        },
      );
    } finally {
      delete process.env.WSD_ENC_KEY;
    }
  });

  test('provider-store rewrites a legacy blob to v2 on next load; mask and duplicate lookup survive', async () => {
    const providersFile = path.join(TMP_DIR, 'providers.json');
    const plain = 'sk-provider-legacy-2468';
    const legacy = legacySeal(plain, TMP_DIR, LEGACY_MASTER);
    fs.writeFileSync(
      providersFile,
      JSON.stringify({
        legacy: {
          name: 'Legacy Provider',
          type: 'openai',
          host: 'https://api.openai.com/v1',
          apiKey: legacy,
          enabled: true,
        },
      }),
      { encoding: 'utf8', mode: 0o600 },
    );

    const store = await import('../src/services/provider-store.ts');
    store.resetProviderCache();

    const meta = store.listProviders().find((p) => p.id === 'legacy');
    assert.ok(meta, 'legacy provider is listed');
    assert.strictEqual(meta.apiKeyMasked, MASK8 + '2468');
    assert.strictEqual(store.getProviderConfig('legacy').apiKey, plain);
    assert.strictEqual(store.findDuplicateByKeyOrHost(plain)?.id, 'legacy');

    const rawAfter = fs.readFileSync(providersFile, 'utf8');
    const stored = (JSON.parse(rawAfter) as Record<string, { apiKey?: string }>).legacy?.apiKey;
    assert.ok(stored, 'apiKey persisted');
    assert.ok(isSealed(stored), 'next load rewrote the legacy blob as v2');
    assert.ok(!isLegacySealed(stored));
    assert.ok(!rawAfter.includes(legacy), 'old ciphertext no longer on disk');
    assert.strictEqual(openSecretStrict(stored), plain);
  });

  test('masking never decrypts and mirrors maskKey shape', () => {
    const secret = 'sk-visible-tail-9x2q';
    assert.strictEqual(maskStored(sealSecret(secret)), MASK8 + '9x2q');
    assert.strictEqual(maskStored(secret), MASK8 + '9x2q');
    assert.strictEqual(maskStored('abc'), MASK4);
    assert.strictEqual(maskStored(''), '');
    // damaged last4 segment degrades gracefully instead of throwing
    const broken = sealSecret(secret).replace(/:[^:]+$/, ':');
    assert.strictEqual(maskStored(broken), MASK4);
  });
});

test('startup banner describes v2 and legacy secret-box migration accurately', () => {
  const indexSource = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(indexSource, /without WSD_ENCRYPTION_KEY re-opens sealed keys/);
  assert.match(indexSource, /v2 provider keys/);
  assert.match(indexSource, /data\/enc\.key or WSD_ENC_KEY/);
  assert.match(indexSource, /Legacy enc1 keys need the old WSD_ENCRYPTION_KEY\/JWT/);
  assert.match(indexSource, /re-seal to v2 on the next provider save/);
});

// ── Part 2 · end-to-end through the HTTP API ────────────────────

const dockerEnabled = process.env.WSD_TEST_DOCKER === '1';
const LIVE_SKIP = 'requires WSD_TEST_DOCKER=1 (live providers API + on-disk assertions)';
const liveSkip = (why: string) => dockerEnabled ? why : `${LIVE_SKIP} — ${why}`;

describe('secret-box · providers.json sealed on disk', {
  skip: dockerEnabled ? false : LIVE_SKIP,
}, () => {
  const accountPassword = (process.env.WSD_TEST_ACCOUNT_PASSWORD || '').trim();
  const harnessDataDir = (process.env.WSD_DATA_DIR || '').trim();
  const PROVIDERS_FILE = (process.env.WSD_TEST_PROVIDERS_FILE || '').trim()
    || (harnessDataDir ? path.join(harnessDataDir, 'providers.json') : '');
  const KEY = `enc-e2e-${Date.now().toString(36)}-tail88`;
  let id = '';

  const h = () => ({ Authorization: `Bearer ${signTestToken()}`, 'Content-Type': 'application/json' });

  before(async () => {
    if (accountPassword) await initTestAuth();
  });

  test('created key exists ONLY as ciphertext everywhere', async (t) => {
    if (!accountPassword) return t.skip(liveSkip('WSD_TEST_ACCOUNT_PASSWORD not set'));
    const res = await fetch(`${API_URL}/providers`, {
      method: 'POST',
      headers: h(),
      body: JSON.stringify({ name: 'tstj-enc-roundtrip', host: 'https://api.openai.com/v1', type: 'openai', apiKey: KEY }),
    });
    assert.strictEqual(res.status, 201);
    id = (await res.json()).provider.id;

    const listJson = JSON.stringify(await (await fetch(`${API_URL}/providers`, { headers: h() })).json());
    assert.ok(!listJson.includes(KEY), 'raw key must never appear in any API response');
    assert.ok(!listJson.includes('enc1:'), 'legacy sealed blobs must not leak through the list');
    assert.ok(!listJson.includes('v2:'), 'current sealed blobs must not leak through the list either');

    if (!PROVIDERS_FILE) return t.skip(liveSkip('no providers.json path (WSD_TEST_PROVIDERS_FILE / harness WSD_DATA_DIR) — file assertions skipped'));
    const raw = fs.readFileSync(PROVIDERS_FILE, 'utf8');
    assert.ok(!raw.includes(KEY), 'plaintext must not be written to disk');
    const entry = JSON.parse(raw)[id];
    assert.ok(entry, 'provider persisted');
    assert.strictEqual(isSealed(entry.apiKey), true, 'stored apiKey carries the v2 prefix');
    assert.strictEqual(entry.apiKey.split(':')[0], 'v2');
    assert.strictEqual(openSecret(entry.apiKey), KEY, 'roundtrip against the live key');
  });

  test('key update re-seals; delete removes the blob', async (t) => {
    if (!accountPassword) return t.skip(liveSkip('WSD_TEST_ACCOUNT_PASSWORD not set'));
    const KEY2 = `${KEY}-v2`;
    await fetch(`${API_URL}/providers/${id}`, {
      method: 'PUT',
      headers: h(),
      body: JSON.stringify({ apiKey: KEY2 }),
    });

    if (PROVIDERS_FILE) {
      const entry = JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8'))[id];
      assert.strictEqual(isSealed(entry.apiKey), true);
      assert.strictEqual(entry.apiKey.split(':')[0], 'v2');
      assert.ok(!fs.readFileSync(PROVIDERS_FILE, 'utf8').includes(KEY2));
      assert.strictEqual(openSecret(entry.apiKey), KEY2);
    }

    await fetch(`${API_URL}/providers/${id}`, { method: 'DELETE', headers: h() });
    const list = await (await fetch(`${API_URL}/providers`, { headers: h() })).json();
    assert.ok(!(list.providers ?? []).some((p: any) => p.id === id), 'deleted provider gone');
  });
});
