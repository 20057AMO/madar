/**
 * chat-format.test.ts
 * Offline unit coverage for the pure team-chat UX formatting helpers
 * (frontend/src/lib/chat-format.ts) — no server, no Docker.
 *
 * Loading note: the module is import-free TS (`export type`/functions only —
 * no enums/namespaces, mirrors the *-core.ts purity rule), so a direct import
 * from backend/tests works under `node --test` with Node >=22.6 native type
 * stripping (verified: no copy of the logic into this file was needed).
 *
 * Contract:
 *  - daySeparatorKey buckets an ISO string into 'today' | 'yesterday' | a
 *    YYYY-MM-DD local-date key; `now` is injectable.
 *  - formatDayLabel renders the human label; junk keys pass through.
 *  - shouldGroup only groups same-sender messages within maxGapMs (default
 *    10 min); negative gaps and invalid timestamps never group.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { daySeparatorKey, formatDayLabel, shouldGroup } from '../../frontend/src/lib/chat-format.ts';

// Local-calendar fixture: every ISO below is built from a local Date so the
// local-midnight day math in daySeparatorKey is timezone-proof.
const REF = new Date(2026, 8, 16, 14, 30, 0); // Sep 16 2026, 14:30 local
const todayIso = new Date(2026, 8, 16, 9, 0, 0).toISOString();
const todayMidnightIso = new Date(2026, 8, 16, 0, 0, 0).toISOString();
const yesterdayIso = new Date(2026, 8, 15, 23, 0, 0).toISOString();
const olderIso = new Date(2026, 8, 14, 10, 0, 0).toISOString();
const olderPadIso = new Date(2026, 8, 4, 10, 0, 0).toISOString();
const futureSameDayIso = new Date(2026, 8, 16, 20, 0, 0).toISOString();
const futureNextDayIso = new Date(2026, 8, 17, 8, 0, 0).toISOString();

describe('daySeparatorKey', () => {
  test('same local day → today', () => {
    assert.strictEqual(daySeparatorKey(todayIso, REF), 'today');
    assert.strictEqual(daySeparatorKey(todayMidnightIso, REF), 'today');
  });
  test('yesterday → yesterday', () => {
    assert.strictEqual(daySeparatorKey(yesterdayIso, REF), 'yesterday');
  });
  test('older days → their own YYYY-MM-DD local key', () => {
    assert.strictEqual(daySeparatorKey(olderIso, REF), '2026-09-14');
    assert.strictEqual(daySeparatorKey(olderPadIso, REF), '2026-09-04'); // zero-padded
  });
  test('future same-day message → today (calendar bucket, not wall-clock gap)', () => {
    assert.strictEqual(daySeparatorKey(futureSameDayIso, REF), 'today');
  });
  test('future NEXT day → its own date key, never yesterday (negative gap must not mislabel)', () => {
    assert.strictEqual(daySeparatorKey(futureNextDayIso, REF), '2026-09-17');
  });
  test('`now` accepts a numeric epoch identically to a Date', () => {
    assert.strictEqual(daySeparatorKey(todayIso, REF.getTime()), daySeparatorKey(todayIso, REF));
    assert.strictEqual(daySeparatorKey(yesterdayIso, REF.getTime()), 'yesterday');
  });
  test('invalid ISO → unknown, never throws', () => {
    assert.doesNotThrow(() => daySeparatorKey('garbage', REF));
    assert.strictEqual(daySeparatorKey('garbage', REF), 'unknown');
    assert.strictEqual(daySeparatorKey('', REF), 'unknown');
    assert.strictEqual(daySeparatorKey('not an iso date at all', REF), 'unknown');
    assert.strictEqual(daySeparatorKey(undefined as any, REF), 'unknown');
  });
});

describe('formatDayLabel', () => {
  test('fixed keywords map to fixed labels', () => {
    assert.strictEqual(formatDayLabel('today'), 'Today');
    assert.strictEqual(formatDayLabel('yesterday'), 'Yesterday');
    assert.strictEqual(formatDayLabel('unknown'), 'Unknown');
  });
  test('older date key renders a short local date label', () => {
    const label = formatDayLabel('2026-09-14');
    const expected = new Date(2026, 8, 14).toLocaleDateString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    assert.strictEqual(label, expected);
    assert.ok(label.length > 0);
    assert.ok(label.includes('14'), `label must carry the day number: ${label}`);
  });
  test('junk / malformed keys pass through unchanged (never throw)', () => {
    assert.strictEqual(formatDayLabel('random-key'), 'random-key');
    assert.strictEqual(formatDayLabel('0-0-0'), '0-0-0');
    assert.doesNotThrow(() => formatDayLabel('...' as any));
  });
  test('round-trips the key a separator produced', () => {
    const key = daySeparatorKey(olderIso, REF);
    const label = formatDayLabel(key);
    assert.strictEqual(
      label,
      new Date(2026, 8, 14).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
    );
  });
});

describe('shouldGroup', () => {
  const t0 = '2026-09-16T10:00:00.000Z';
  const tPlus5 = '2026-09-16T10:05:00.000Z';
  const tPlus10 = '2026-09-16T10:10:00.000Z';
  const tPlus11 = '2026-09-16T10:11:00.000Z';

  test('same user under 10 min → true', () => {
    assert.strictEqual(shouldGroup(t0, tPlus5, 600_000, true), true);
  });
  test('exactly at the 10-min boundary → true', () => {
    assert.strictEqual(shouldGroup(t0, tPlus10, 600_000, true), true);
  });
  test('over 10 min → false', () => {
    assert.strictEqual(shouldGroup(t0, tPlus11, 600_000, true), false);
  });
  test('different user → false even when adjacent', () => {
    assert.strictEqual(shouldGroup(t0, tPlus5, 600_000, false), false);
  });
  test('negative gap (older message follows newer) → false', () => {
    assert.strictEqual(shouldGroup(tPlus5, t0, 600_000, true), false);
  });
  test('custom maxGapMs respected', () => {
    const after2s = new Date(Date.parse(t0) + 2000).toISOString();
    assert.strictEqual(shouldGroup(t0, after2s, 5000, true), true);
    assert.strictEqual(shouldGroup(t0, after2s, 1000, true), false);
  });
  test('identical timestamps → true (zero gap)', () => {
    assert.strictEqual(shouldGroup(t0, t0, 600_000, true), true);
  });
  test('invalid timestamps → false, never throws', () => {
    assert.strictEqual(shouldGroup('bogus', t0, 600_000, true), false);
    assert.strictEqual(shouldGroup(t0, 'bogus', 600_000, true), false);
    assert.strictEqual(shouldGroup('bogus', 'bogus', 600_000, true), false);
    assert.doesNotThrow(() => shouldGroup(null as any, t0, 600_000, true));
  });
});