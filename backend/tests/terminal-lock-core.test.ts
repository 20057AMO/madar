/**
 * terminal-lock-core.test.ts
 * Offline units for the terminal session reservation registry — the pure module
 * that replaced an advisory `Set<string>` which was filled AFTER the shell had
 * spawned (so two sockets could both pass the check and spawn two shells for one
 * project). No server, no Docker, no sockets, no timers: node --test loads
 * `terminal-lock-core.ts` directly (it has zero imports).
 *
 * Contract pinned here:
 *  - `reserve()` is synchronous and decides + writes in one tick → contention on
 *    the SAME `slug:mode` can only ever yield ONE winner, from any number of
 *    concurrent callers and any user id.
 *  - The key is `slug:mode`, system-wide (a second user on the same project
 *    terminal is refused too), and the slug is used verbatim — canonicalization
 *    belongs to `canonicalProjectSlug` upstream, not to the registry.
 *  - `busy` is checked before `capacity`, and a busy attempt consumes no slot.
 *  - `release()` is an OWNERSHIP check: only the reservation carrying that token
 *    is freed; a foreign/stale/empty token is a no-op returning false.
 *  - No TTL: nothing here expires a live slot on its own.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  createTerminalSlots,
  TERMINAL_MAX_SESSIONS,
  type TerminalSlots,
} from '../src/services/terminal-lock-core.ts';

const SLUG = 'demo';

function fresh(max?: number): TerminalSlots {
  return createTerminalSlots(max === undefined ? {} : { max });
}

describe('reserve — identity, key and capacity', () => {
  test('a first reserve succeeds and carries slug/mode/userId, a non-empty token and a numeric at', () => {
    const slots = fresh();
    const result = slots.reserve({ slug: SLUG, mode: 'project', userId: 'u-1' });
    assert.strictEqual(result.ok, true);
    assert.ok(result.ok);
    const r = result.reservation;
    assert.strictEqual(r.slug, SLUG);
    assert.strictEqual(r.mode, 'project');
    assert.strictEqual(r.userId, 'u-1');
    assert.strictEqual(typeof r.token, 'string');
    assert.ok(r.token.length > 0, 'the ownership token must never be empty');
    assert.strictEqual(typeof r.at, 'number');
    assert.ok(Number.isFinite(r.at) && r.at > 0);
    assert.strictEqual(slots.size(), 1);
  });

  test('a second reserve on the same slug:mode from ANOTHER user is busy (the cross-user block)', () => {
    const slots = fresh();
    const first = slots.reserve({ slug: SLUG, mode: 'project', userId: 'u-1' });
    assert.strictEqual(first.ok, true);
    assert.deepStrictEqual(
      slots.reserve({ slug: SLUG, mode: 'project', userId: 'u-2' }),
      { ok: false, reason: 'busy' }
    );
    assert.strictEqual(slots.size(), 1, 'a refused reserve must not consume a slot');
    // The holder is unchanged — the refusal is not a silent takeover.
    assert.strictEqual(slots.slotOf(SLUG, 'project')?.userId, 'u-1');
  });

  test('the same slug in the other mode is an independent slot', () => {
    const slots = fresh();
    assert.strictEqual(slots.reserve({ slug: SLUG, mode: 'project', userId: 'u-1' }).ok, true);
    const control = slots.reserve({ slug: SLUG, mode: 'control', userId: 'u-1' });
    assert.strictEqual(control.ok, true);
    assert.strictEqual(slots.size(), 2);
    assert.strictEqual(slots.slotOf(SLUG, 'project')?.mode, 'project');
    assert.strictEqual(slots.slotOf(SLUG, 'control')?.mode, 'control');
  });

  test('the slug is a verbatim key — case/whitespace variants are DIFFERENT slots', () => {
    // The registry deliberately does not fold: `canonicalProjectSlug` (project-slug-core)
    // folds exactly once, BEFORE the access gate, and ws-server.ts passes that one
    // canonical value here. A second fold would be a second source of truth and would
    // let two distinct stored projects collide on one contention key.
    const slots = fresh();
    assert.strictEqual(slots.reserve({ slug: 'demo', mode: 'project', userId: 'u-1' }).ok, true);
    assert.strictEqual(slots.reserve({ slug: 'Demo', mode: 'project', userId: 'u-2' }).ok, true);
    assert.strictEqual(slots.reserve({ slug: ' demo ', mode: 'project', userId: 'u-3' }).ok, true);
    assert.strictEqual(slots.size(), 3);
    // …and the exact original string is still the contended one.
    assert.deepStrictEqual(
      slots.reserve({ slug: 'demo', mode: 'project', userId: 'u-4' }),
      { ok: false, reason: 'busy' }
    );
  });

  test('capacity: max distinct pairs succeed, the next is refused, busy attempts consume none', () => {
    const slots = fresh(2);
    assert.strictEqual(slots.reserve({ slug: 'a', mode: 'project', userId: 'u-1' }).ok, true);
    assert.strictEqual(slots.reserve({ slug: 'b', mode: 'project', userId: 'u-1' }).ok, true);
    assert.deepStrictEqual(
      slots.reserve({ slug: 'c', mode: 'project', userId: 'u-1' }),
      { ok: false, reason: 'capacity' }
    );
    // The other mode of an already-served slug is still a NEW pair → capacity.
    assert.deepStrictEqual(
      slots.reserve({ slug: 'a', mode: 'control', userId: 'u-1' }),
      { ok: false, reason: 'capacity' }
    );
    assert.strictEqual(slots.size(), 2);

    // Repeated busy attempts on an existing pair never eat capacity: after them a
    // freed pair is reusable (and, before them, nothing changed either).
    for (let i = 0; i < 25; i += 1) {
      assert.deepStrictEqual(
        slots.reserve({ slug: 'a', mode: 'project', userId: `u-x${i}` }),
        { ok: false, reason: 'busy' }
      );
    }
    assert.strictEqual(slots.size(), 2, 'busy attempts must never change the occupancy');

    assert.strictEqual(slots.release(slots.slotOf('b', 'project')!.token), true);
    assert.strictEqual(slots.reserve({ slug: 'c', mode: 'project', userId: 'u-1' }).ok, true);
    assert.strictEqual(slots.size(), 2);
  });

  test('busy wins over capacity — an occupied pair is never reported as "too many"', () => {
    const slots = fresh(1);
    assert.strictEqual(slots.reserve({ slug: SLUG, mode: 'project', userId: 'u-1' }).ok, true);
    // Both conditions hold here (the pair is taken AND size === max); the honest
    // answer is busy, because closing this terminal is what actually helps.
    assert.deepStrictEqual(
      slots.reserve({ slug: SLUG, mode: 'project', userId: 'u-2' }),
      { ok: false, reason: 'busy' }
    );
    assert.deepStrictEqual(
      slots.reserve({ slug: 'other', mode: 'project', userId: 'u-2' }),
      { ok: false, reason: 'capacity' }
    );
  });

  test('an empty userId (the honest ws-server fallback) still reserves', () => {
    const slots = fresh();
    const result = slots.reserve({ slug: SLUG, mode: 'control', userId: '' });
    assert.strictEqual(result.ok, true);
    assert.ok(result.ok);
    assert.strictEqual(result.reservation.userId, '');
  });

  test('a junk/zero/negative max falls back to the pinned global cap', () => {
    for (const max of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const slots = createTerminalSlots({ max });
      for (let i = 0; i < TERMINAL_MAX_SESSIONS; i += 1) {
        assert.strictEqual(slots.reserve({ slug: `s${i}`, mode: 'project', userId: 'u' }).ok, true);
      }
      assert.deepStrictEqual(
        slots.reserve({ slug: 'over', mode: 'project', userId: 'u' }),
        { ok: false, reason: 'capacity' }
      );
    }
  });
});

describe('release — the ownership proof', () => {
  test('the owning token frees the slot and a new reserve then succeeds', () => {
    const slots = fresh();
    const first = slots.reserve({ slug: SLUG, mode: 'project', userId: 'u-1' });
    assert.ok(first.ok);
    assert.strictEqual(slots.release(first.reservation.token), true);
    assert.strictEqual(slots.size(), 0);
    assert.strictEqual(slots.slotOf(SLUG, 'project'), undefined);
    assert.strictEqual(slots.reserve({ slug: SLUG, mode: 'project', userId: 'u-2' }).ok, true);
  });

  test('a DIFFERENT token returns false and the original reservation survives', () => {
    const slots = fresh();
    const first = slots.reserve({ slug: SLUG, mode: 'project', userId: 'u-1' });
    assert.ok(first.ok);
    const holder = first.reservation;

    assert.strictEqual(slots.release('not-the-owner-token'), false);
    assert.strictEqual(slots.size(), 1, 'a foreign token must not free the slot');
    assert.deepStrictEqual(slots.slotOf(SLUG, 'project'), holder);

    // A second socket's own token cannot evict the first socket either.
    assert.strictEqual(slots.release(''), false);
    assert.strictEqual(slots.size(), 1);
    assert.strictEqual(slots.release(holder.token), true);
    assert.strictEqual(slots.size(), 0);
  });

  test('releasing twice answers true then false and never throws', () => {
    const slots = fresh();
    const first = slots.reserve({ slug: SLUG, mode: 'project', userId: 'u-1' });
    assert.ok(first.ok);
    assert.strictEqual(slots.release(first.reservation.token), true);
    assert.strictEqual(slots.release(first.reservation.token), false);
    assert.strictEqual(slots.size(), 0);
  });

  test('an empty or unknown token on an empty registry is a harmless false', () => {
    const slots = fresh();
    assert.strictEqual(slots.release(''), false);
    assert.strictEqual(slots.release('unknown'), false);
    assert.strictEqual(slots.release(undefined as unknown as string), false);
    assert.strictEqual(slots.release(null as unknown as string), false);
    assert.strictEqual(slots.size(), 0);
  });

  test('release frees only ITS pair — a sibling mode keeps its slot', () => {
    const slots = fresh();
    const project = slots.reserve({ slug: SLUG, mode: 'project', userId: 'u-1' });
    const control = slots.reserve({ slug: SLUG, mode: 'control', userId: 'u-1' });
    assert.ok(project.ok && control.ok);
    assert.strictEqual(slots.release(project.reservation.token), true);
    assert.strictEqual(slots.size(), 1);
    assert.strictEqual(slots.slotOf(SLUG, 'project'), undefined);
    assert.strictEqual(slots.slotOf(SLUG, 'control')?.token, control.reservation.token);
  });
});

describe('tokenFactory / now injection', () => {
  test('an injected tokenFactory is honoured for the token', () => {
    let n = 0;
    const slots = createTerminalSlots({ tokenFactory: () => `tok-${++n}` });
    const first = slots.reserve({ slug: SLUG, mode: 'project', userId: 'u-1' });
    const second = slots.reserve({ slug: SLUG, mode: 'control', userId: 'u-1' });
    assert.ok(first.ok && second.ok);
    assert.strictEqual(first.reservation.token, 'tok-1');
    assert.strictEqual(second.reservation.token, 'tok-2');
    assert.strictEqual(slots.release('tok-2'), true);
    assert.strictEqual(slots.size(), 1);
  });

  test('an explicit token argument overrides the factory', () => {
    const slots = createTerminalSlots({ tokenFactory: () => 'factory-token' });
    const first = slots.reserve({ slug: SLUG, mode: 'project', userId: 'u-1' }, 'injected');
    assert.ok(first.ok);
    assert.strictEqual(first.reservation.token, 'injected');
    assert.strictEqual(slots.release('injected'), true);
    assert.strictEqual(slots.size(), 0);
  });

  test('the default factory yields distinct tokens across 200 distinct pairs', () => {
    const slots = createTerminalSlots({ max: 200 });
    const tokens = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const result = slots.reserve({ slug: `s${i}`, mode: 'project', userId: 'u' });
      assert.ok(result.ok, `reserve ${i} should fit under max 200`);
      assert.ok(!tokens.has(result.reservation.token), `duplicate token at ${i}`);
      tokens.add(result.reservation.token);
    }
    assert.strictEqual(tokens.size, 200);
    assert.strictEqual(slots.size(), 200);
  });

  test('an injected now() stamps at', () => {
    const slots = createTerminalSlots({ now: () => 1_700_000_000_000 });
    const result = slots.reserve({ slug: SLUG, mode: 'project', userId: 'u-1' });
    assert.ok(result.ok);
    assert.strictEqual(result.reservation.at, 1_700_000_000_000);
  });
});

describe('read and utility helpers', () => {
  test('size() tracks reservations and releases', () => {
    const slots = fresh();
    assert.strictEqual(slots.size(), 0);
    const a = slots.reserve({ slug: 'a', mode: 'project', userId: 'u' });
    assert.ok(a.ok);
    assert.strictEqual(slots.size(), 1);
    const b = slots.reserve({ slug: 'b', mode: 'control', userId: 'u' });
    assert.ok(b.ok);
    assert.strictEqual(slots.size(), 2);
    assert.strictEqual(slots.release(a.reservation.token), true);
    assert.strictEqual(slots.size(), 1);
    assert.strictEqual(slots.slotOf('a', 'project'), undefined);
    assert.strictEqual(slots.release(b.reservation.token), true);
    assert.strictEqual(slots.size(), 0);
  });

  test('slotOf is a snapshot — mutating it cannot corrupt the registry', () => {
    const slots = fresh();
    const result = slots.reserve({ slug: SLUG, mode: 'project', userId: 'u-1' });
    assert.ok(result.ok);
    const snapshot = slots.slotOf(SLUG, 'project');
    assert.ok(snapshot);
    snapshot.userId = 'hacker';
    snapshot.token = 'swapped';
    assert.strictEqual(slots.slotOf(SLUG, 'project')?.userId, 'u-1');
    // The real token still works, and the swapped one is not accepted.
    assert.strictEqual(slots.release('swapped'), false);
    assert.strictEqual(slots.release(result.reservation.token), true);
  });

  test('clear() empties everything, including the token index', () => {
    const slots = fresh();
    const a = slots.reserve({ slug: 'a', mode: 'project', userId: 'u' });
    const b = slots.reserve({ slug: 'b', mode: 'control', userId: 'u' });
    assert.ok(a.ok && b.ok);
    slots.clear();
    assert.strictEqual(slots.size(), 0);
    assert.strictEqual(slots.slotOf('a', 'project'), undefined);
    // A token from before the clear is stale — it must not free anything new.
    assert.strictEqual(slots.release(a.reservation.token), false);
    const again = slots.reserve({ slug: 'a', mode: 'project', userId: 'u' });
    assert.ok(again.ok);
    assert.strictEqual(slots.size(), 1);
  });
});

describe('atomicity witness — the two-shells-for-one-project regression guard', () => {
  test('50 synchronous reserves on one pair from 50 users: exactly one wins, size() is 1', () => {
    const slots = createTerminalSlots({ max: 100 });
    const results = [];
    for (let i = 0; i < 50; i += 1) {
      results.push(slots.reserve({ slug: SLUG, mode: 'project', userId: `u-${i}` }));
    }
    const winners = results.filter((r) => r.ok);
    assert.strictEqual(winners.length, 1, 'a check-then-set across a tick would let several shells spawn');
    assert.strictEqual(results.filter((r) => !r.ok && r.reason === 'busy').length, 49);
    assert.strictEqual(slots.size(), 1);
  });

  test('the same loop driven from an async function with no awaits between calls yields one winner', async () => {
    // The registry needs no internal locking: `reserve` never yields, so an async
    // caller cannot interleave inside it. Any remaining window can only live in the
    // caller (that is why ws-terminal.ts reserves before its first await).
    const slots = createTerminalSlots({ max: 100 });
    const winners: string[] = [];
    await (async () => {
      for (let i = 0; i < 50; i += 1) {
        const result = slots.reserve({ slug: SLUG, mode: 'control', userId: `u-${i}` });
        if (result.ok) winners.push(result.reservation.userId);
      }
    })();
    assert.deepStrictEqual(winners, ['u-0']);
    assert.strictEqual(slots.size(), 1);
    // And each loser's token (none exists) cannot free the winner's slot.
    assert.strictEqual(slots.release('u-1'), false);
    assert.strictEqual(slots.size(), 1);
  });
});

describe('TERMINAL_MAX_SESSIONS — pinned global cap', () => {
  test('the cap stays 16', () => {
    assert.strictEqual(TERMINAL_MAX_SESSIONS, 16);
    const slots = fresh();
    for (let i = 0; i < 16; i += 1) {
      assert.strictEqual(slots.reserve({ slug: `s${i}`, mode: 'project', userId: 'u' }).ok, true);
    }
    assert.deepStrictEqual(
      slots.reserve({ slug: 's17', mode: 'project', userId: 'u' }),
      { ok: false, reason: 'capacity' }
    );
    assert.strictEqual(slots.size(), 16);
  });
});
