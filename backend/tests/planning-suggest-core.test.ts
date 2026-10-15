/**
 * planning-suggest-core.test.ts
 * Pure unit coverage for the rule-based planning-suggestion engine (six rules,
 * stable keys, orchestration, dismissals, ids) — no server, no Docker, no
 * service imports (same pattern as digest-core / serve-core / alerts-core).
 *
 * Contract under test:
 *  - ruleGoalWithoutTask: OPEN goal with no matching CARD fires (high); a
 *    matching card (case/whitespace-insensitive) or a done goal suppresses it;
 *    a matching STICKY does not (cards only).
 *  - ruleUntrackedIdea: OPEN idea absent from the board fires (med); any node
 *    type counts as tracked; done ideas never fire.
 *  - ruleStaleBug: OPEN bug older than STALE_BUG_DAYS fires (high); exact
 *    boundary is NOT stale, +1ms is; fresh/done/unparseable-createdAt never.
 *  - ruleOrphanCard: a CARD with no edges fires (low); connected cards and a
 *    lone sticky do not; a lone done card still does (cards regardless).
 *  - ruleDuplicateItem: note↔note and note↔card equal-normalized pairs fire
 *    (med); distinct or empty texts do not.
 *  - ruleEmptyBoard: notes + zero nodes fires (med); any node or no notes do
 *    not.
 *  - computeSuggestions: all rules, dedupe by key, severity high→low, id +
 *    createdAt stamped, MAX_SUGGESTIONS cap, junk/null → [] never throws.
 *  - normalizeText / contentKey stability; sanitizeDismissed /
 *    applyDismissals; suggestEntryId s-<6>-<6> uniqueness across 500.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  MAX_SUGGESTIONS,
  STALE_BUG_DAYS,
  DISMISSED_MAX,
  SUGGEST_PROMPT_MAX,
  SUGGEST_OUTPUT_MAX,
  MAX_SUGGEST_ITEMS,
  SUGGEST_KINDS,
  SUGGEST_SEVERITY,
  MIN_CONTAINMENT_LEN,
  normalizeText,
  contentKey,
  suggestEntryId,
  ruleGoalWithoutTask,
  ruleUntrackedIdea,
  ruleStaleBug,
  ruleOrphanCard,
  ruleDuplicateItem,
  ruleEmptyBoard,
  computeSuggestions,
  sanitizeDismissed,
  applyDismissals,
  type Suggestion,
} from '../src/services/planning-suggest-core.ts';

const NOW = Date.parse('2026-10-15T00:00:00.000Z');
const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const OPTS = { now: NOW };

function note(
  id: string,
  text: string,
  kind: 'idea' | 'bug' | 'goal',
  extra: { done?: boolean; createdAt?: string } = {},
) {
  return { id, text, kind, done: extra.done === true, createdAt: extra.createdAt ?? '2026-10-01T00:00:00.000Z' };
}

function notes(items: unknown[]) {
  return { items };
}

function card(id: string, text: string, done = false) {
  return { id, type: 'card', text, x: 0, y: 0, w: 220, h: 120, color: 'yellow', done };
}

function sticky(id: string, text: string) {
  return { id, type: 'note', text, x: 0, y: 0, w: 220, h: 100, color: 'yellow', done: false };
}

function edge(from: string, to: string) {
  return { id: `e-${from}-${to}`, from, to };
}

function canvas(nodes: unknown[] = [], edges: unknown[] = []) {
  return { version: 1, nodes, edges, updatedAt: null };
}

function fakeSug(id: string, key: string): Suggestion {
  return {
    id,
    key,
    kind: 'untracked_idea',
    severity: 'med',
    title: 't',
    rationale: 'r',
    source: 'rule',
    target: 'canvas',
    payload: { text: 'x' },
    refs: [],
    createdAt: '2026-10-01T00:00:00.000Z',
  };
}

describe('normalizeText / contentKey — stable comparison keys', () => {
  test('normalizeText trims, collapses whitespace and lowercases', () => {
    assert.strictEqual(normalizeText('  Hello   World \n\t!  '), 'hello world !');
    assert.strictEqual(normalizeText('SHIP'), 'ship');
    assert.strictEqual(normalizeText('already normalized'), 'already normalized');
  });

  test('normalizeText tolerates junk without throwing', () => {
    assert.strictEqual(normalizeText(null), '');
    assert.strictEqual(normalizeText(undefined), '');
    assert.strictEqual(normalizeText(42), '');
    assert.strictEqual(normalizeText({}), '');
    assert.strictEqual(normalizeText(''), '');
    assert.strictEqual(normalizeText('   '), '');
  });

  test('contentKey: same text → same key regardless of case/spacing; different kind → different key', () => {
    const a = contentKey('stale_bug', 'Fix the LOGIN   bug');
    assert.strictEqual(a, contentKey('stale_bug', '  fix the login bug '));
    assert.notStrictEqual(a, contentKey('orphan_card', 'Fix the LOGIN   bug'));
    assert.notStrictEqual(contentKey('goal_without_task', 'ship'), contentKey('untracked_idea', 'ship'));
    assert.strictEqual(a, 'stale_bug::fix the login bug');
  });
});

describe('ruleGoalWithoutTask', () => {
  test('positive: open goal with no matching card fires (high, canvas, goal payload)', () => {
    const out = ruleGoalWithoutTask(canvas([card('c1', 'Unrelated work')]), notes([note('g1', 'Ship the beta release', 'goal')]), OPTS);
    assert.strictEqual(out.length, 1);
    const s = out[0];
    assert.strictEqual(s.kind, 'goal_without_task');
    assert.strictEqual(s.severity, 'high');
    assert.strictEqual(s.target, 'canvas');
    assert.strictEqual(s.source, 'rule');
    assert.deepStrictEqual(s.payload, { text: 'Ship the beta release', kind: 'goal' });
    assert.deepStrictEqual(s.refs, ['g1']);
    assert.strictEqual(s.key, contentKey('goal_without_task', 'Ship the beta release'));
  });

  test('negative: a matching card (case/whitespace-insensitive) suppresses the goal', () => {
    const out = ruleGoalWithoutTask(canvas([card('c1', '  ship   THE beta release ')]), notes([note('g1', 'Ship the beta release', 'goal')]), OPTS);
    assert.deepStrictEqual(out, []);
  });

  test('negative: a done goal never fires', () => {
    const out = ruleGoalWithoutTask(canvas(), notes([note('g1', 'Ship the beta release', 'goal', { done: true })]), OPTS);
    assert.deepStrictEqual(out, []);
  });

  test('a matching sticky does NOT suppress — only cards count as task cards', () => {
    const out = ruleGoalWithoutTask(canvas([sticky('s1', 'Ship the beta release')]), notes([note('g1', 'Ship the beta release', 'goal')]), OPTS);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].kind, 'goal_without_task');
  });
});

describe('ruleUntrackedIdea', () => {
  test('positive: open idea absent from the board fires (med, idea payload)', () => {
    const out = ruleUntrackedIdea(canvas([card('c1', 'Unrelated work')]), notes([note('i1', 'Consider dark theme', 'idea')]), OPTS);
    assert.strictEqual(out.length, 1);
    const s = out[0];
    assert.strictEqual(s.kind, 'untracked_idea');
    assert.strictEqual(s.severity, 'med');
    assert.strictEqual(s.target, 'canvas');
    assert.deepStrictEqual(s.payload, { text: 'Consider dark theme', kind: 'idea' });
    assert.deepStrictEqual(s.refs, ['i1']);
  });

  test('negative: an idea present as a sticky is tracked', () => {
    const out = ruleUntrackedIdea(canvas([sticky('s1', 'consider DARK   theme')]), notes([note('i1', 'Consider dark theme', 'idea')]), OPTS);
    assert.deepStrictEqual(out, []);
  });

  test('negative: a done idea never fires', () => {
    const out = ruleUntrackedIdea(canvas(), notes([note('i1', 'Consider dark theme', 'idea', { done: true })]), OPTS);
    assert.deepStrictEqual(out, []);
  });
});

describe('ruleStaleBug', () => {
  test('positive: open bug older than STALE_BUG_DAYS fires (high, note, bug payload)', () => {
    const createdAt = iso(NOW - 20 * DAY);
    const out = ruleStaleBug(canvas(), notes([note('b1', 'Crash on save', 'bug', { createdAt })]), OPTS);
    assert.strictEqual(out.length, 1);
    const s = out[0];
    assert.strictEqual(s.kind, 'stale_bug');
    assert.strictEqual(s.severity, 'high');
    assert.strictEqual(s.target, 'note');
    assert.deepStrictEqual(s.payload, { text: 'Crash on save', kind: 'bug' });
    assert.deepStrictEqual(s.refs, ['b1']);
    assert.ok(s.rationale.includes(iso(NOW - 20 * DAY).slice(0, 10)), 'rationale carries the open date');
  });

  test('boundary: exactly STALE_BUG_DAYS old is NOT stale; one ms older is', () => {
    const exact = iso(NOW - STALE_BUG_DAYS * DAY);
    assert.deepStrictEqual(ruleStaleBug(canvas(), notes([note('b1', 'Exact boundary', 'bug', { createdAt: exact })]), OPTS), []);
    const older = iso(NOW - STALE_BUG_DAYS * DAY - 1);
    assert.strictEqual(ruleStaleBug(canvas(), notes([note('b1', 'Exact boundary', 'bug', { createdAt: older })]), OPTS).length, 1);
  });

  test('negative: fresh bug, done bug and unparseable createdAt never fire', () => {
    assert.deepStrictEqual(ruleStaleBug(canvas(), notes([note('b1', 'Fresh', 'bug', { createdAt: iso(NOW - DAY) })]), OPTS), []);
    assert.deepStrictEqual(ruleStaleBug(canvas(), notes([note('b1', 'Old but done', 'bug', { done: true, createdAt: iso(NOW - 20 * DAY) })]), OPTS), []);
    assert.deepStrictEqual(ruleStaleBug(canvas(), notes([note('b1', 'Unknown date', 'bug', { createdAt: 'not-a-date' })]), OPTS), []);
  });
});

describe('ruleOrphanCard', () => {
  test('positive: a card with no edges fires (low, canvas, refs the card id)', () => {
    const c = canvas([card('a', 'Card A'), card('b', 'Card B'), card('c', 'Card C')], [edge('a', 'b')]);
    const out = ruleOrphanCard(c, notes([]), OPTS);
    assert.strictEqual(out.length, 1);
    const s = out[0];
    assert.strictEqual(s.kind, 'orphan_card');
    assert.strictEqual(s.severity, 'low');
    assert.strictEqual(s.target, 'canvas');
    assert.deepStrictEqual(s.payload, { text: 'Card C' });
    assert.deepStrictEqual(s.refs, ['c']);
  });

  test('negative: connected cards do not fire', () => {
    const c = canvas([card('a', 'Card A'), card('b', 'Card B'), card('c', 'Card C')], [edge('a', 'b'), edge('b', 'c')]);
    assert.deepStrictEqual(ruleOrphanCard(c, notes([]), OPTS), []);
  });

  test('negative: a lone sticky note is not a card', () => {
    assert.deepStrictEqual(ruleOrphanCard(canvas([sticky('s1', 'Just a sticky')]), notes([]), OPTS), []);
  });

  test('a lone DONE card still fires — cards are checked regardless of done (spec-literal)', () => {
    const out = ruleOrphanCard(canvas([card('a', 'Done card', true)]), notes([]), OPTS);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].kind, 'orphan_card');
  });
});

describe('containment matching (MIN_CONTAINMENT_LEN)', () => {
  test('a longer card covering the goal suppresses it (containment still applies at/above the floor)', () => {
    assert.ok(MIN_CONTAINMENT_LEN <= 'add dark mode'.length);
    const out = ruleGoalWithoutTask(
      canvas([card('c1', 'Add dark mode toggle for the settings page')]),
      notes([note('g1', 'Add dark mode', 'goal')]),
      OPTS,
    );
    assert.deepStrictEqual(out, [], 'the broader card tracks the goal');
  });

  test('a subject shorter than the floor is only matched by equality, never containment', () => {
    assert.ok('ui'.length < MIN_CONTAINMENT_LEN);
    // 'ui' ⊂ 'build ui kit' by containment, but that is exactly the false
    // positive the floor refuses — the idea must still fire.
    const out = ruleUntrackedIdea(canvas([card('c1', 'Build ui kit')]), notes([note('i1', 'ui', 'idea')]), OPTS);
    assert.strictEqual(out.length, 1, 'a 2-char subject must not be silenced by an unrelated longer card');
    assert.strictEqual(out[0].kind, 'untracked_idea');
  });

  test('a short subject still matches by EQUALITY', () => {
    const out = ruleUntrackedIdea(canvas([card('c1', 'UI')]), notes([note('i1', 'ui', 'idea')]), OPTS);
    assert.deepStrictEqual(out, [], 'equal normalized text is tracked regardless of length');
  });
});

describe('ruleDuplicateItem', () => {
  test('positive: two notes with equal normalized text fire once (med, note, both refs)', () => {
    const n = notes([note('n1', 'Fix login bug', 'bug'), note('n2', '  fix   LOGIN  bug ', 'idea')]);
    const out = ruleDuplicateItem(canvas(), n, OPTS);
    assert.strictEqual(out.length, 1);
    const s = out[0];
    assert.strictEqual(s.kind, 'duplicate_item');
    assert.strictEqual(s.severity, 'med');
    assert.strictEqual(s.target, 'note');
    assert.deepStrictEqual(s.payload, { text: 'Fix login bug', kind: 'bug' });
    assert.deepStrictEqual(s.refs, ['n1', 'n2']);
    assert.strictEqual(s.key, contentKey('duplicate_item', 'fix login bug'));
  });

  test('positive: a note duplicating a card fires with target canvas + both refs', () => {
    const out = ruleDuplicateItem(canvas([card('c1', 'api   DESIGN')]), notes([note('n1', 'API design', 'idea')]), OPTS);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].target, 'canvas');
    assert.deepStrictEqual(out[0].refs, ['n1', 'c1']);
  });

  test('negative: distinct texts do not fire', () => {
    const out = ruleDuplicateItem(canvas(), notes([note('n1', 'Fix login bug', 'bug'), note('n2', 'Write API docs', 'idea')]), OPTS);
    assert.deepStrictEqual(out, []);
  });

  test('negative: whitespace-only note text is dropped before matching', () => {
    const out = ruleDuplicateItem(canvas(), notes([note('n1', '   ', 'idea'), note('n2', '   ', 'bug')]), OPTS);
    assert.deepStrictEqual(out, []);
  });
});

describe('ruleEmptyBoard', () => {
  test('positive: notes exist with zero canvas nodes fires (med, canvas, note refs)', () => {
    const out = ruleEmptyBoard(canvas(), notes([note('n1', 'First thought', 'idea'), note('n2', 'Ship goal', 'goal')]), OPTS);
    assert.strictEqual(out.length, 1);
    const s = out[0];
    assert.strictEqual(s.kind, 'empty_board');
    assert.strictEqual(s.severity, 'med');
    assert.strictEqual(s.target, 'canvas');
    assert.strictEqual(s.payload.text, '');
    assert.deepStrictEqual(s.refs, ['n1', 'n2']);
    assert.ok(s.rationale.includes('2 note(s)'), 'rationale carries the note count');
  });

  test('negative: a board with any node does not fire', () => {
    const out = ruleEmptyBoard(canvas([sticky('s1', 'Anything')]), notes([note('n1', 'First thought', 'idea')]), OPTS);
    assert.deepStrictEqual(out, []);
  });

  test('negative: no notes does not fire', () => {
    assert.deepStrictEqual(ruleEmptyBoard(canvas(), notes([]), OPTS), []);
  });
});

describe('computeSuggestions — orchestration', () => {
  test('runs all rules, stamps ids + shared createdAt, sorts high→med→low', () => {
    const c = canvas([card('c1', 'Unrelated work item')]);
    const n = notes([note('g1', 'Ship the beta release', 'goal'), note('i1', 'Consider dark theme', 'idea')]);
    const out = computeSuggestions(c, n, OPTS);
    assert.strictEqual(out.length, 3);
    assert.deepStrictEqual(out.map((s) => s.kind), ['goal_without_task', 'untracked_idea', 'orphan_card']);
    assert.deepStrictEqual(out.map((s) => s.severity), ['high', 'med', 'low']);
    for (const s of out) {
      assert.match(s.id, /^s-[a-z0-9]{6}-[a-z0-9]{6}$/);
      assert.strictEqual(s.createdAt, iso(NOW));
    }
  });

  test('dedupes by key: note↔note and note↔card duplicates of the same text collapse to one row', () => {
    const c = canvas([card('c1', 'DUP A')]);
    const n = notes([note('n1', 'Dup A', 'idea'), note('n2', 'dup   a', 'idea')]);
    const out = computeSuggestions(c, n, OPTS);
    const dups = out.filter((s) => s.kind === 'duplicate_item');
    assert.strictEqual(dups.length, 1);
    assert.strictEqual(out.filter((s) => s.key === dups[0].key).length, 1, 'the collapsed key appears exactly once');
  });

  test('caps at MAX_SUGGESTIONS', () => {
    const n = notes(Array.from({ length: 60 }, (_, i) => note(`i${i}`, `Untracked idea number ${i}`, 'idea')));
    const out = computeSuggestions(canvas(), n, OPTS);
    assert.strictEqual(out.length, MAX_SUGGESTIONS);
    assert.strictEqual(MAX_SUGGESTIONS, 50);
  });

  test('junk/null canvas, notes or clock return [] / sane defaults and never throw', () => {
    const junkPairs: [unknown, unknown][] = [
      [null, null],
      [undefined, undefined],
      ['junk', 42],
      [{ nodes: 'x', edges: null }, { items: 'y' }],
      [{ nodes: [null, 42, { id: 1, text: 7, type: 'card' }, { id: 'n1', type: 'card', text: '' }], edges: [null] }, { items: [null, 'x', { text: 7, id: 'a' }] }],
    ];
    for (const [c, n] of junkPairs) {
      assert.deepStrictEqual(computeSuggestions(c, n, OPTS), []);
    }
    assert.deepStrictEqual(computeSuggestions(null, null), []);

    const real = computeSuggestions(canvas([card('c1', 'Only card')]), notes([note('g1', 'Ship', 'goal')]), { now: NaN });
    assert.strictEqual(real.length, 2);
    assert.ok(!Number.isNaN(Date.parse(real[0].createdAt)));
    assert.doesNotThrow(() => computeSuggestions(canvas([card('c1', 'Only card')]), notes([]), { now: 1e30 }));
  });
});

describe('sanitizeDismissed / applyDismissals', () => {
  test('sanitizeDismissed keeps strings only, trimmed, deduped, capped', () => {
    assert.deepStrictEqual(sanitizeDismissed([1, null, 'a', ' b ', {}, '', 'a', '  ']), ['a', 'b']);
    assert.deepStrictEqual(sanitizeDismissed('junk'), []);
    assert.deepStrictEqual(sanitizeDismissed(null), []);
    assert.deepStrictEqual(sanitizeDismissed({}), []);
    assert.deepStrictEqual(sanitizeDismissed(undefined), []);
    const many = Array.from({ length: DISMISSED_MAX + 50 }, (_, i) => `k${i}`);
    const capped = sanitizeDismissed(many);
    assert.strictEqual(capped.length, DISMISSED_MAX);
    assert.strictEqual(capped[0], 'k0');
  });

  test('applyDismissals drops rows by key and tolerates junk', () => {
    const list = [fakeSug('s-aaaaaa-aaaaaa', 'k1'), fakeSug('s-bbbbbb-bbbbbb', 'k2'), fakeSug('s-cccccc-cccccc', 'k3')];
    assert.deepStrictEqual(applyDismissals(list, ['k2', 5, null]).map((s) => s.key), ['k1', 'k3']);
    assert.strictEqual(applyDismissals(list, []).length, 3);
    assert.strictEqual(applyDismissals(list, 'junk').length, 3);
    assert.strictEqual(applyDismissals(list, null).length, 3);
    assert.deepStrictEqual(applyDismissals(null, ['k1']), []);
    assert.deepStrictEqual(applyDismissals(undefined, undefined), []);
  });
});

describe('suggestEntryId / constants', () => {
  test('suggestEntryId matches s-<6>-<6> and stays unique across 500', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const id = suggestEntryId();
      assert.match(id, /^s-[a-z0-9]{6}-[a-z0-9]{6}$/);
      ids.add(id);
    }
    assert.strictEqual(ids.size, 500);
  });

  test('constants are pinned', () => {
    assert.strictEqual(MAX_SUGGESTIONS, 50);
    assert.strictEqual(STALE_BUG_DAYS, 14);
    assert.strictEqual(DISMISSED_MAX, 200);
    assert.strictEqual(SUGGEST_PROMPT_MAX, 20_000);
    assert.strictEqual(SUGGEST_OUTPUT_MAX, 8_000);
    assert.strictEqual(MAX_SUGGEST_ITEMS, 8);
    assert.strictEqual(SUGGEST_KINDS.length, 6);
    assert.deepStrictEqual(
      SUGGEST_KINDS.map((k) => SUGGEST_SEVERITY[k]),
      ['high', 'med', 'high', 'low', 'med', 'med'],
    );
  });
});
