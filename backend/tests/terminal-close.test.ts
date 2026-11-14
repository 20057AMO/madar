/**
 * terminal-close.test.ts
 * Offline units for the terminal WebSocket close-code contract — the pure
 * module the terminal socket uses to tell "shell ended / container gone /
 * container stopped / try later" apart. No server, no Docker, no sockets.
 *
 * Contract:
 *  - 4000 session-ended · 4404 container-missing · 4409 container-stopped ·
 *    4503 capacity · 4500 internal (1008 is ws-server's access refusal).
 *  - Docker's 404/409 (and a status-less message carrying the same meaning)
 *    classify; everything else is the retryable 4500. An explicit (finite,
 *    non-zero) status always wins — the message text is only a fallback.
 *  - 4404/4409 name the PROJECT container, so control mode (a pty in the app
 *    container) can never produce them: it answers the retryable 4500 with
 *    control-shell wording.
 *  - Hostile inputs (null, a string, a number, circular objects) never throw.
 *  - The message is always one non-empty line, capped and stack-free.
 *  - ws-terminal.ts has no bare ws.close() and no 1011/1013 left.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  TERMINAL_CLOSE,
  mapTerminalStartError,
  type TerminalMode,
  type TerminalStartFailure,
} from '../src/services/terminal-close.ts';

const SLUG = 'demo';
const MAX_REASON_BYTES = 123;

function map(err: unknown, slug = SLUG): TerminalStartFailure {
  return mapTerminalStartError(err, slug);
}

describe('TERMINAL_CLOSE — pinned contract', () => {
  test('the five close codes are exactly what the client expects', () => {
    assert.deepStrictEqual(TERMINAL_CLOSE, {
      sessionEnded: 4000,
      containerMissing: 4404,
      containerStopped: 4409,
      capacity: 4503,
      internal: 4500,
    });
    assert.strictEqual(TERMINAL_CLOSE.sessionEnded, 4000);
    assert.strictEqual(TERMINAL_CLOSE.containerMissing, 4404);
    assert.strictEqual(TERMINAL_CLOSE.containerStopped, 4409);
    assert.strictEqual(TERMINAL_CLOSE.capacity, 4503);
    assert.strictEqual(TERMINAL_CLOSE.internal, 4500);
  });
});

describe('mapTerminalStartError — Docker status classification', () => {
  test('statusCode 404 → 4404 container-missing with the exact user-facing text', () => {
    const failure = map({ statusCode: 404, message: 'no such container' });
    assert.strictEqual(failure.code, 4404);
    assert.strictEqual(failure.code, TERMINAL_CLOSE.containerMissing);
    assert.strictEqual(failure.reason, 'container-missing');
    assert.strictEqual(failure.message, `Project container 'wsd-${SLUG}' not found. Start the project first.`);
  });

  test('legacy `status` key still classifies a 404', () => {
    const failure = map({ status: 404 });
    assert.strictEqual(failure.code, 4404);
    assert.strictEqual(failure.reason, 'container-missing');
    assert.match(failure.message, /wsd-demo' not found/);
  });

  test('a string status (proxied error) is coerced, not ignored', () => {
    const failure = map({ status: '404', message: 'nope' });
    assert.strictEqual(failure.code, 4404);
    const stopped = map({ status: '409' });
    assert.strictEqual(stopped.code, 4409);
  });

  test('statusCode 409 → 4409 container-stopped with the exact user-facing text', () => {
    const failure = map({ statusCode: 409, message: 'container is not running' });
    assert.strictEqual(failure.code, 4409);
    assert.strictEqual(failure.code, TERMINAL_CLOSE.containerStopped);
    assert.strictEqual(failure.reason, 'container-stopped');
    assert.strictEqual(
      failure.message,
      `Project container 'wsd-${SLUG}' is not running. Start the project, then reconnect.`
    );
  });

  test('status-less "is not running" message still classifies as stopped', () => {
    const failure = map({ message: 'Container abc is not running' });
    assert.strictEqual(failure.code, 4409);
    assert.strictEqual(failure.reason, 'container-stopped');
  });

  test('status-less "is stopped" message still classifies as stopped', () => {
    assert.strictEqual(map(new Error('container wsd-demo is stopped')).code, 4409);
  });

  test('a thrown Error carrying "No such container" text classifies as missing', () => {
    const failure = map(new Error('No such container: wsd-x'));
    assert.strictEqual(failure.code, 4404);
    assert.strictEqual(failure.reason, 'container-missing');
  });

  test('an unrelated status (500) → 4500 internal, keeping its message', () => {
    const failure = map({ statusCode: 500, message: 'boom' });
    assert.strictEqual(failure.code, 4500);
    assert.strictEqual(failure.code, TERMINAL_CLOSE.internal);
    assert.strictEqual(failure.reason, 'terminal-failed');
    assert.strictEqual(failure.message, 'boom');
  });

  test('a status-code-shaped string that is not 404/409 stays internal', () => {
    assert.strictEqual(map({ statusCode: 503, message: 'service unavailable' }).code, 4500);
    assert.strictEqual(map({ statusCode: 'junk', message: 'weird' }).code, 4500);
  });
});

describe('mapTerminalStartError — hostile inputs never throw', () => {
  test('null → 4500 with the fallback message', () => {
    const failure = map(null);
    assert.strictEqual(failure.code, 4500);
    assert.strictEqual(failure.message, 'Terminal failed to start.');
  });

  test('undefined → 4500 with the fallback message', () => {
    const failure = map(undefined);
    assert.strictEqual(failure.code, 4500);
    assert.strictEqual(failure.message, 'Terminal failed to start.');
  });

  test('a bare thrown string is surfaced as the message', () => {
    const failure = map('plain string');
    assert.strictEqual(failure.code, 4500);
    assert.strictEqual(failure.message, 'plain string');
  });

  test('a bare thrown number is coerced, not crashed on', () => {
    const failure = map(42);
    assert.strictEqual(failure.code, 4500);
    assert.strictEqual(failure.message, '42');
  });

  test('a circular object is handled without throwing', () => {
    const circular: Record<string, unknown> = { statusCode: 500 };
    circular.self = circular;
    const failure = map(circular);
    assert.strictEqual(failure.code, 4500);
    assert.strictEqual(failure.message, 'Terminal failed to start.');
  });

  test('an error carrying only a stack never leaks the stack', () => {
    const withStack = new Error('');
    withStack.stack = 'Error: at /app/data/jwt.secret';
    const failure = map(withStack);
    assert.strictEqual(failure.code, 4500);
    assert.strictEqual(failure.message, 'Terminal failed to start.');
    assert.ok(!failure.message.includes('jwt.secret'));
    assert.ok(!failure.message.includes('\n'));
  });
});

describe('mapTerminalStartError — message hygiene', () => {
  test('embedded newlines/tabs collapse into a single line', () => {
    const failure = map({ statusCode: 500, message: 'boom\n\t  bang   here\n' });
    assert.strictEqual(failure.message, 'boom bang here');
    assert.ok(!failure.message.includes('\n'));
    assert.ok(!failure.message.includes('\t'));
  });

  test('a 5000-char message is capped at 300 chars, ellipsis included', () => {
    const failure = map({ statusCode: 500, message: 'x'.repeat(5000) });
    assert.strictEqual(failure.message.length, 300);
    assert.ok(failure.message.endsWith('…'));
  });

  test('an empty message falls back instead of going blank', () => {
    assert.strictEqual(map({ statusCode: 500, message: '' }).message, 'Terminal failed to start.');
    assert.strictEqual(map({ statusCode: 500, message: '   \n\t ' }).message, 'Terminal failed to start.');
  });

  test('every reason stays within the 123-byte close-reason limit', () => {
    const reasons = [
      map({ statusCode: 404 }).reason,
      map({ statusCode: 409 }).reason,
      map({ statusCode: 500, message: 'boom' }).reason,
    ];
    for (const reason of reasons) {
      assert.ok(reason.length > 0, 'reason must not be empty');
      assert.ok(Buffer.byteLength(reason, 'utf8') <= MAX_REASON_BYTES, `${reason} exceeds ${MAX_REASON_BYTES} bytes`);
    }
  });
});

describe('mapTerminalStartError — an explicit status always beats the message text', () => {
  test('a 500 whose text says "not found" is internal, never a missing container', () => {
    const failure = map({
      statusCode: 500,
      message: 'exec: "bash": executable file not found in $PATH',
    });
    assert.strictEqual(failure.code, 4500);
    assert.strictEqual(failure.code, TERMINAL_CLOSE.internal);
    assert.strictEqual(failure.reason, 'terminal-failed');
    assert.strictEqual(failure.message, 'exec: "bash": executable file not found in $PATH');
    assert.ok(!failure.message.includes('wsd-'));
  });

  test('a 500 whose text says "is not running" is internal, never container-stopped', () => {
    const failure = map({ statusCode: 500, message: 'session broke: the worker is not running' });
    assert.strictEqual(failure.code, 4500);
    assert.strictEqual(failure.reason, 'terminal-failed');
    assert.strictEqual(failure.message, 'session broke: the worker is not running');
    assert.ok(!failure.message.includes('Start the project'));
  });

  test('an explicit 404 wins even when the text is misleading', () => {
    const failure = map({ statusCode: 404, message: 'exec: "bash": executable file not found in $PATH' });
    assert.strictEqual(failure.code, 4404);
    assert.strictEqual(failure.reason, 'container-missing');
    assert.strictEqual(failure.message, `Project container 'wsd-${SLUG}' not found. Start the project first.`);
  });

  test('an explicit 409 wins even when the text is misleading', () => {
    const failure = map({ status: '409', message: 'exec: "bash": executable file not found in $PATH' });
    assert.strictEqual(failure.code, 4409);
    assert.strictEqual(failure.reason, 'container-stopped');
  });

  test('a zero status counts as NO status, so the text may still classify', () => {
    const missing = map({ statusCode: 0, message: 'No such container: wsd-x' });
    assert.strictEqual(missing.code, 4404);
    assert.strictEqual(missing.reason, 'container-missing');

    const stopped = map({ status: 0, message: 'container wsd-x is not running' });
    assert.strictEqual(stopped.code, 4409);
    assert.strictEqual(stopped.reason, 'container-stopped');

    const neither = map({ statusCode: 0, message: 'boom' });
    assert.strictEqual(neither.code, 4500);
    assert.strictEqual(neither.message, 'boom');
  });
});

describe('mapTerminalStartError — control mode never blames a project container', () => {
  const CONTROL: TerminalMode = 'control';

  function projectWordsIn(message: string): string[] {
    return ['Project container', 'wsd-', 'start the project', 'Start the project'].filter((word) =>
      message.includes(word)
    );
  }

  test('a "no such container" text is retryable 4500, worded for the control shell', () => {
    const failure = mapTerminalStartError(new Error('No such container: whatever'), 'x', CONTROL);
    assert.strictEqual(failure.code, 4500);
    assert.strictEqual(failure.code, TERMINAL_CLOSE.internal);
    assert.strictEqual(failure.reason, 'terminal-failed');
    assert.deepStrictEqual(projectWordsIn(failure.message), []);
    assert.ok(!/not running/i.test(failure.message), 'must not claim anything is stopped');
    assert.match(failure.message, /control container/i);
    assert.ok(Buffer.byteLength(failure.reason, 'utf8') <= MAX_REASON_BYTES);
  });

  test('explicit 404/409 statuses cannot reach 4404/4409 in control mode', () => {
    assert.strictEqual(mapTerminalStartError({ statusCode: 404 }, SLUG, CONTROL).code, 4500);
    assert.strictEqual(mapTerminalStartError({ status: '404' }, SLUG, CONTROL).code, 4500);
    assert.strictEqual(
      mapTerminalStartError({ statusCode: 409, message: 'container is not running' }, SLUG, CONTROL).code,
      4500
    );
    assert.strictEqual(mapTerminalStartError({ status: 409 }, SLUG, CONTROL).code, 4500);
  });

  test('a pty spawn "File not found" (the real control failure) is 4500, not container-missing', () => {
    const failure = mapTerminalStartError(new Error('File not found: /bin/bash'), SLUG, CONTROL);
    assert.strictEqual(failure.code, 4500);
    assert.strictEqual(failure.reason, 'terminal-failed');
    assert.deepStrictEqual(projectWordsIn(failure.message), []);
  });

  test('an unrelated control failure keeps its own text', () => {
    const failure = mapTerminalStartError({ statusCode: 500, message: 'spawn EAGAIN' }, SLUG, CONTROL);
    assert.strictEqual(failure.code, 4500);
    assert.strictEqual(failure.message, 'spawn EAGAIN');
  });

  test('an omitted mode behaves exactly like project mode', () => {
    for (const err of [{ statusCode: 404 }, { status: 404 }, new Error('No such container: wsd-x')]) {
      assert.deepStrictEqual(mapTerminalStartError(err, SLUG), mapTerminalStartError(err, SLUG, 'project'));
    }
    assert.strictEqual(
      mapTerminalStartError({ statusCode: 404 }, SLUG).message,
      `Project container 'wsd-${SLUG}' not found. Start the project first.`
    );
    assert.strictEqual(
      mapTerminalStartError({ statusCode: 409 }, SLUG).message,
      `Project container 'wsd-${SLUG}' is not running. Start the project, then reconnect.`
    );
  });
});

describe('ws-terminal.ts — structural guards', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../src/ws/ws-terminal.ts', import.meta.url)), 'utf8');

  test('no bare ws.close() — every close carries a code and a reason', () => {
    assert.doesNotMatch(src, /ws\.close\(\s*\)/);
  });

  test('the ambiguous 1011/1013 codes are gone', () => {
    assert.ok(!src.includes('1011'), 'ws-terminal.ts must not close with 1011 any more');
    assert.ok(!src.includes('1013'), 'ws-terminal.ts must not close with 1013 any more');
  });

  test('the mapped contract is wired in, not re-implemented locally', () => {
    assert.match(src, /TERMINAL_CLOSE\.capacity/);
    assert.match(src, /TERMINAL_CLOSE\.sessionEnded/);
    assert.match(src, /mapTerminalStartError/);
    assert.match(src, /ws\.close\(failure\.code, failure\.reason\)/);
  });

  test('the terminal mode is forwarded to the mapper, not just available', () => {
    assert.match(src, /mapTerminalStartError\(err, slug, mode\)/);
  });
});
