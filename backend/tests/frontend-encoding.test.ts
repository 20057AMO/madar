/**
 * frontend-encoding.test.ts
 * Offline guard against mojibake in the frontend source tree.
 *
 * Why this exists: a corrupted Arabic aria-label shipped once as U+FFFD
 * replacement characters (mojibake) and nothing failed — a visually broken
 * string is still valid TypeScript. This suite scans every `frontend/src`
 * source file and refuses:
 *   - U+FFFD (REPLACEMENT CHARACTER) — the fingerprint of a decode that lost
 *     bytes, and of a literal U+FFFD pasted into a string;
 *   - C0 control characters below 0x20 other than \t, \n and \r — invisible
 *     bytes that render as nothing (or as a broken glyph) inside UI copy.
 *
 * Reading as UTF-8 is part of the check: bytes that are NOT valid UTF-8 decode
 * to U+FFFD, so a file written in the wrong encoding is caught even if it
 * never contained a literal replacement character.
 *
 * Pure fs scan — no server, no Docker, no network.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = fileURLToPath(new URL('../../frontend/src', import.meta.url));
const SOURCE_EXT = new Set(['.ts', '.tsx', '.css']);

interface Offender {
  index: number;
  code: number;
  context: string;
}

/**
 * The rule under test. `null` means the text is clean; a hit carries the
 * offending code unit and a short context so a failure names the spot.
 */
function findOffenders(text: string): Offender[] {
  const hits: Offender[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const isReplacement = code === 0xfffd;
    const isControl = code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
    if (!isReplacement && !isControl) continue;
    hits.push({
      index: i,
      code,
      context: JSON.stringify(text.slice(Math.max(0, i - 40), i + 40)),
    });
  }
  return hits;
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        // Only hand-written source lives under these trees; node_modules is
        // never vendored into frontend/src, but stay explicit anyway.
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(p);
      } else if (SOURCE_EXT.has(path.extname(entry.name))) {
        out.push(p);
      }
    }
  };
  walk(dir);
  return out.sort();
}

describe('frontend source encoding (offline, no server)', () => {
  test('the detector flags U+FFFD and control characters (non-vacuity of the rule)', () => {
    assert.ok(findOffenders('ok text').length === 0, 'clean text produces no hit');
    assert.strictEqual(findOffenders('تغيير دور').length, 0, 'Arabic text is not a hit');

    const repl = findOffenders('role=\uFFFD\uFFFD\uFFFD');
    assert.strictEqual(repl.length, 3, 'U+FFFD is flagged once per character');
    assert.strictEqual(repl[0].code, 0xfffd);

    const soh = findOffenders('aria-label="a\u0001b"');
    assert.strictEqual(soh.length, 1, '0x01 is flagged');
    assert.strictEqual(soh[0].code, 0x01);

    const nul = findOffenders('x\u0000y');
    assert.strictEqual(nul.length, 1, 'NUL is flagged');
    assert.strictEqual(nul[0].code, 0x00);

    assert.strictEqual(findOffenders('tab\there\nline\r\nnext').length, 0, '\\t \\n \\r are allowed');
    assert.ok(findOffenders('a\uFFFD').length > 0, 'replacement char inside Arabic copy is still a hit');
    // A hit knows where it is, so a failure can name the location.
    assert.strictEqual(findOffenders('ab\u0002cd')[0].index, 2);
    assert.match(findOffenders('ab\u0002cd')[0].context, /ab/);
  });

  test('the detector flags a string that is NOT valid UTF-8 (decode-loss fingerprint)', () => {
    // Bytes that are not valid UTF-8 decode to U+FFFD through the same
    // readFileSync(path, 'utf8') path the real scan uses.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-guard-'));
    const file = path.join(dir, 'broken.ts');
    try {
      fs.writeFileSync(file, Buffer.from([0x61, 0xff, 0xfe, 0x62, 0x22, 0x3b]));
      const decoded = fs.readFileSync(file, 'utf8');
      const hits = findOffenders(decoded);
      assert.ok(hits.length > 0, 'invalid UTF-8 bytes surface as U+FFFD and are flagged');
      assert.ok(hits.some((h) => h.code === 0xfffd));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('frontend/src has no U+FFFD and no stray control characters', () => {
    assert.ok(fs.existsSync(SRC_DIR), `frontend/src must exist at ${SRC_DIR}`);
    const files = listSourceFiles(SRC_DIR);
    assert.ok(files.length > 0, 'the scan must actually find source files (not silently scan nothing)');

    const failures: string[] = [];
    for (const file of files) {
      // utf8 decode: invalid byte sequences become U+FFFD and are caught too.
      const text = fs.readFileSync(file, 'utf8');
      for (const hit of findOffenders(text)) {
        const line = text.slice(0, hit.index).split('\n').length;
        failures.push(
          `${path.relative(path.dirname(SRC_DIR), file)}:${line} ` +
          `U+${hit.code.toString(16).toUpperCase().padStart(4, '0')} …${hit.context}…`
        );
      }
    }
    assert.deepStrictEqual(
      failures, [],
      `mojibake / control characters found in the frontend source:\n${failures.join('\n')}`
    );
  });
});
