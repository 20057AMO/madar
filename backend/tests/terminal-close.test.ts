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

describe('ws-terminal.ts — session-slot structural guards (the spawn race)', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../src/ws/ws-terminal.ts', import.meta.url)), 'utf8');
  const serverSrc = fs.readFileSync(fileURLToPath(new URL('../src/ws/ws-server.ts', import.meta.url)), 'utf8');
  /** Whitespace-insensitive view, so reformatting cannot make a guard vacuous. */
  const flat = src.replace(/\s+/g, ' ');
  const serverFlat = serverSrc.replace(/\s+/g, ' ');

  test('the reservation registry is imported and used, and the advisory Set is gone', () => {
    assert.match(
      src,
      /from '\.\.\/services\/terminal-lock-core'/,
      'ws-terminal.ts must take its session lock from services/terminal-lock-core.ts'
    );
    assert.match(flat, /createTerminalSlots\(/, 'the registry must actually be constructed');
    assert.match(flat, /slots\.reserve\(/, 'the socket must reserve through the registry');
    assert.doesNotMatch(
      flat,
      /const active = new Set/,
      'the old advisory `active` Set is the defect (check before the spawn, write after it) — it must not come back'
    );
  });

  test('there is no `active` set left to mutate — no add/delete/has anywhere', () => {
    for (const call of ['active.add(', 'active.delete(', 'active.has(']) {
      assert.ok(
        !flat.includes(call),
        `${call} is the unchecked, ownership-blind path this stage removed; a slot may only be reserved and released through the registry`
      );
    }
  });

  test('the reservation is taken BEFORE anything async — subdir resolution, handlers, and the spawn', () => {
    const reserveAt = src.indexOf('slots.reserve(');
    assert.ok(reserveAt >= 0, 'slots.reserve( must appear in ws-terminal.ts');

    const anchors: Array<[string, RegExp]> = [
      ['resolveProjectSubdir(', /resolveProjectSubdir\(/],
      ["ws.on('message'", /ws\.on\(\s*'message'/],
      ['the start IIFE', /const start = \(async/],
      ['startProjectExec(', /startProjectExec\(/],
      ['startControlShell(', /startControlShell\(/],
    ];
    for (const [label, re] of anchors) {
      const at = src.search(re);
      assert.ok(at >= 0, `${label} not found — the guard would be vacuous`);
      assert.ok(
        reserveAt < at,
        `the slug:mode slot must be reserved before ${label}; reserving later reopens the window where two sockets both spawn a shell`
      );
    }
  });

  test('release is the owner-only path and carries the reservation token', () => {
    assert.match(flat, /const myToken\b/, 'the socket must hold its own ownership token');
    assert.match(
      flat,
      /slots\.release\(\s*myToken\s*\)/,
      'release() must free the slot through the token it reserved, never by slug:mode'
    );
  });

  test('handleTerminalSocket takes a userId, and ws-server passes the authenticated id', () => {
    assert.match(
      flat,
      /export function handleTerminalSocket\(\s*ws: WebSocket, slug: string, mode: 'project' \| 'control', userId: string,/,
      'the handler must receive the identity that holds the slot (honest messaging + a per-user policy seam)'
    );
    assert.match(
      serverFlat,
      /handleTerminalSocket\(\s*ws, slug, mode, authUser\?\.id \?\? '', releaseRoom\(room\)\s*\)/,
      "ws-server.ts must forward the already-verified authUser id into handleTerminalSocket"
    );
  });

  test('busy and capacity both close through TERMINAL_CLOSE.capacity, and the refusal names no user', () => {
    assert.match(flat, /ws\.close\(\s*TERMINAL_CLOSE\.capacity, 'session busy'\s*\)/);
    assert.match(flat, /ws\.close\(\s*TERMINAL_CLOSE\.capacity, 'too many sessions'\s*\)/);
    assert.doesNotMatch(
      flat,
      /ws\.close\(\s*1008/,
      '1008 is ws-server.ts project-access denial — the terminal handler must never emit it'
    );
    assert.doesNotMatch(
      flat,
      /is already open[^'`]*\$\{userId\}/,
      'the busy refusal must not name the holder (anti-oracle: same message whoever holds the slot)'
    );
    assert.match(
      flat,
      /A \$\{mode\} terminal for '\$\{slug\}' is already open\. Close it first\./,
      'the busy message shape is part of the contract the client shows'
    );
  });
});

describe('ws-terminal.ts — runtime failure honesty', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../src/ws/ws-terminal.ts', import.meta.url)), 'utf8');
  const flat = src.replace(/\s+/g, ' ');

  test('a stream error is reported through failSession, never disguised as a clean finish', () => {
    assert.match(flat, /stream\.on\(\s*'error'\s*,\s*\(err: unknown\)\s*=>\s*failSession\(err\)\s*\)/);
    assert.match(flat, /stream\.on\(\s*'close'\s*,\s*\(\)\s*=>\s*finish\(\)\s*\)/);
    assert.match(flat, /stream\.on\(\s*'end'\s*,\s*\(\)\s*=>\s*finish\(\)\s*\)/);
    assert.doesNotMatch(flat, /stream\.on\(\s*'error'\s*,\s*\(\)\s*=>\s*finish\(\)\s*\)/);
  });

  test('a pty exit carries exitCode and signal into the socket', () => {
    assert.match(flat, /ptyProcess\.onExit\(\s*\(\s*\{\s*exitCode,\s*signal\s*\}\s*\)/);
    assert.match(flat, /onExit\(\{\s*exitCode,\s*signal\s*\}\)/);
  });

  test('failSession sends an error frame before closing through the mapped failure', () => {
    const at = src.indexOf('const failSession');
    assert.ok(at >= 0, 'failSession must exist beside finish');
    const body = src.slice(at, at + 400);
    assert.match(body, /if \(closed\) return;/);
    assert.match(body, /const f = mapTerminalStartError\(err, slug, mode\)/);
    assert.match(body, /sendJson\(\s*ws,\s*\{\s*type: 'error',\s*message: f\.message\s*\}\s*\)/);
    assert.match(body, /finish\(f\.code, f\.reason\)/);
    assert.ok(
      body.indexOf("type: 'error'") < body.indexOf('finish(f.code, f.reason)'),
      'the error frame must be sent before the socket is closed'
    );
  });

  test('finish still defaults to the pinned 4000 clean-exit close', () => {
    assert.match(
      flat,
      /const finish = \(code: number = TERMINAL_CLOSE\.sessionEnded, reason: string = 'session ended'\)/
    );
  });

  test('a non-zero pty exit or a signal goes through failSession, not the clean finish', () => {
    const at = flat.indexOf('const notifyExit');
    assert.ok(at >= 0, 'notifyExit must decide how a process exit is reported');
    const body = flat.slice(at, at + 400);
    assert.match(body, /exitCode !== 0 \|\| info\.signal/);
    assert.match(body, /failSession\(/);
    assert.match(body, /else \{ finish\(\); \}/);
  });
});
