/**
 * activity-core.test.ts
 * Pure unit coverage for the project activity feed rules — no server, no
 * Docker, no service imports (same pattern as alerts-core/serve-core).
 *
 * Contract under test:
 *  - The canonical 33-action vocabulary, unknown/junk rejected.
 *  - sanitizeDetails: numbers/strings/string-arrays only, 400-char cap,
 *    booleans/objects/null/nested dropped, empty → undefined.
 *  - appendActivity/capActivity: injectable ceiling, newest kept.
 *  - backfillFromLegacy: kebab→snake translation, unknown skipped, order
 *    preserved, timestamps defaulted, userId/details carried.
 *  - sliceActivity: newest-first + honest total + safe pagination clamps.
 *  - entryId shape a-<rand6>-<rand6>.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  ACTIVITY_ACTIONS,
  isActivityAction,
  sanitizeDetails,
  appendActivity,
  capActivity,
  sliceActivity,
  backfillFromLegacy,
  LEGACY_ACTION_MAP,
  entryId,
  type ActivityEntry,
} from '../src/services/activity-core.ts';

describe('activity vocabulary — the 33 canonical actions', () => {
  test('covers the full saladin action list', () => {
    const expected = [
      'created', 'recreated', 'duplicated', 'imported', 'restored', 'deleted',
      'started', 'stopped', 'cloned',
      'updated', 'env_updated', 'tags_updated', 'ports_updated', 'limits_updated',
      'notes_saved', 'canvas_saved',
      'member_added', 'member_removed', 'member_role_changed', 'ownership_transferred',
      'snapshot_captured', 'snapshot_deleted', 'snapshot_config', 'exported',
      'serve_started', 'serve_stopped',
      'crashed', 'crash_cleared',
      'review_opened', 'review_commented', 'review_resolved', 'review_reopened', 'review_deleted',
    ];
    assert.strictEqual(ACTIVITY_ACTIONS.length, 33);
    assert.deepStrictEqual([...ACTIVITY_ACTIONS].sort(), expected.sort());
  });

  test('isActivityAction accepts every canonical action', () => {
    for (const a of ACTIVITY_ACTIONS) assert.ok(isActivityAction(a), `expected ${a} to be valid`);
  });

  test('isActivityAction rejects unknown / junk / near-misses', () => {
    for (const bad of ['junk', '', 'CRASHED', 'crash', 'created!', 123, null, undefined, ['created'], 'member-added']) {
      assert.strictEqual(isActivityAction(bad), false, `expected ${JSON.stringify(bad)} to be rejected`);
    }
  });
});

describe('sanitizeDetails — field whitelist + cap', () => {
  test('keeps numbers, strings and string arrays; drops booleans/objects/null/nested', () => {
    const out = sanitizeDetails({ n: 42, s: 'hello', arr: ['a', 'b'], flag: true, obj: { x: 1 }, nested: [1, 2], nope: null, u: undefined });
    assert.deepStrictEqual(out, { n: 42, s: 'hello', arr: ['a', 'b'] });
  });

  test('junk input returns undefined', () => {
    assert.strictEqual(sanitizeDetails(null), undefined);
    assert.strictEqual(sanitizeDetails('x'), undefined);
    assert.strictEqual(sanitizeDetails(42), undefined);
    assert.strictEqual(sanitizeDetails(['a']), undefined);
    assert.strictEqual(sanitizeDetails({}), undefined);
  });

  test('serialized payload never exceeds 400 chars', () => {
    const huge = { long: 'x'.repeat(100_000), also: ['y'.repeat(1000), 'z'.repeat(1000)] };
    const out = sanitizeDetails(huge) || {};
    assert.ok(JSON.stringify(out).length <= 400, `payload too big: ${JSON.stringify(out).length}`);
    assert.ok('long' in out, 'a single large string is still representable (200-char slice)');
  });

  test('same-key strings and arrays are sliced but present; empty array kept', () => {
    assert.deepStrictEqual(sanitizeDetails({ a: [] }), { a: [] });
    const out = sanitizeDetails({ a: ['x'.repeat(300), 'y'] });
    assert.deepStrictEqual(out, { a: ['x'.repeat(100), 'y'] });
  });
});

describe('appendActivity / capActivity — the injectable ceiling', () => {
  const e = (i: number): ActivityEntry => ({ id: `e${i}`, action: 'created', at: `2026-09-0${i}T00:00:00.000Z` });

  test('appendActivity appends and trims to max', () => {
    const in1 = [e(1), e(2)];
    const out = appendActivity(in1, e(3), 2);
    assert.strictEqual(out.length, 2);
    assert.deepStrictEqual(out.map((x) => x.id), ['e2', 'e3']);
  });

  test('capActivity keeps the newest; junk max/empty input safe', () => {
    assert.deepStrictEqual(capActivity([e(1), e(2), e(3)], 1).map((x) => x.id), ['e3']);
    assert.deepStrictEqual(capActivity([], 5), []);
    assert.deepStrictEqual(capActivity([e(1), e(2)], 0), []);
    assert.deepStrictEqual(capActivity([e(1), e(2)], -3), []);
    assert.deepStrictEqual(capActivity(null as unknown as ActivityEntry[], 5), []);
    assert.deepStrictEqual(capActivity([e(1), e(2)], 90).map((x) => x.id), ['e1', 'e2']);
  });

  test('appendActivity ignores a null entry', () => {
    const out = appendActivity([e(1)], null, 5);
    assert.deepStrictEqual(out.map((x) => x.id), ['e1']);
  });
});

describe('backfillFromLegacy — meta.activity migration', () => {
  const NOW = '2026-09-10T08:00:00.000Z';
  const legacy = [
    { action: 'created', at: '2026-09-01T00:00:00.000Z', userId: 'u1' },
    { action: 'ownership-transferred', at: '2026-09-02T00:00:00.000Z', userId: 'uAdmin' },
    { action: 'started', at: '2026-09-03T00:00:00.000Z' },
    { action: 'mystery-action', at: '2026-09-04T00:00:00.000Z', userId: 'u2' },
    { action: 'crashed', details: { reason: 'oom', exitCode: 137 } },
  ];

  test('translates kebab-actions, skips unknown, preserves order and fields', () => {
    const out = backfillFromLegacy(legacy, NOW);
    assert.strictEqual(out.length, 4);
    assert.deepStrictEqual(out.map((x) => x.action), ['created', 'ownership_transferred', 'started', 'crashed']);
    assert.strictEqual(out[0].userId, 'u1');
    assert.strictEqual(out[1].userId, 'uAdmin');
    assert.strictEqual(out[2].userId, undefined);
    assert.deepStrictEqual(out[3].details, { reason: 'oom', exitCode: 137 });
    assert.ok(!out.some((x) => x.action === 'mystery-action'));
  });

  test('every mapped legacy action resolves to a canonical action', () => {
    for (const [k, v] of Object.entries(LEGACY_ACTION_MAP)) {
      assert.ok(isActivityAction(v), `map entry ${k}→${v} must be canonical`);
      assert.notStrictEqual(k, v, 'map must actually change the action');
    }
  });

  test('missing/bad timestamps default to now; junk rows skipped', () => {
    const out = backfillFromLegacy(
      [
        { action: 'created', at: 'not-a-date' },
        42,
        null,
        'x',
        { action: 'stopped', at: '2026-09-05T00:00:00.000Z' },
      ],
      NOW,
    );
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].at, NOW);
    assert.strictEqual(out[1].at, '2026-09-05T00:00:00.000Z');
  });

  test('non-array input yields an empty migration', () => {
    assert.deepStrictEqual(backfillFromLegacy(null, NOW), []);
    assert.deepStrictEqual(backfillFromLegacy({ action: 'created' }, NOW), []);
  });

  test('migrated entries carry unique stable ids', () => {
    const out = backfillFromLegacy(legacy, NOW);
    const ids = new Set(out.map((x) => x.id));
    assert.strictEqual(ids.size, out.length);
    for (const x of out) assert.match(x.id, /^a-[a-z0-9]{6}-[a-z0-9]{6}$/);
  });
});

describe('sliceActivity — API pagination', () => {
  const e = (i: number): ActivityEntry => ({ id: `e${i}`, action: 'started', at: `2026-09-0${i}T00:00:00.000Z` });
  const list = [e(1), e(2), e(3), e(4), e(5)];

  test('newest-first with an honest total', () => {
    const r = sliceActivity(list, 2, 0);
    assert.deepStrictEqual(r.entries.map((x) => x.id), ['e5', 'e4']);
    assert.strictEqual(r.total, 5);
  });

  test('offset + negative/junk normalization', () => {
    assert.deepStrictEqual(sliceActivity(list, 2, 2).entries.map((x) => x.id), ['e3', 'e2']);
    assert.strictEqual(sliceActivity(list, -5, 0).entries.length, 0);
    assert.strictEqual(sliceActivity(list, 0, 0).entries.length, 0);
    assert.strictEqual(sliceActivity(list, 50, 0).entries.length, 5);
    assert.deepStrictEqual(sliceActivity(list, 1, 99).entries, []);
    assert.strictEqual(sliceActivity(null as unknown as ActivityEntry[], 5, 0).total, 0);
  });

  test('default limit applies when absent', () => {
    assert.strictEqual(sliceActivity(list, NaN, NaN).entries.length, 5);
  });
});

describe('entryId — format and uniqueness', () => {
  test('matches the a-<6>-<6> pattern and never collides in a batch', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const id = entryId();
      assert.match(id, /^a-[a-z0-9]{6}-[a-z0-9]{6}$/);
      ids.add(id);
    }
    assert.strictEqual(ids.size, 500);
  });
});