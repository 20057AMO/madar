/**
 * digest-core.test.ts
 * Pure unit coverage for the project-intelligence digest rules (config
 * sanitize, due scheduling, prompt build, tolerant output parse, source
 * signature, signal gate, id + pruning) — no server, no Docker, no service
 * imports (same pattern as opencode-delegate-core / snapshots-schedule).
 *
 * Contract under test:
 *  - sanitizeDigestConfig: partial merge; invalid intervalMin falls back to
 *    the previous value then the default; junk never wins.
 *  - computeDueDigests: gap >= interval; missing/blank lastDigestAt is due;
 *    disabled projects are skipped.
 *  - buildDigestPrompt: untrusted markers + slug/name + forced headings + cap.
 *  - parseDigestOutput: plain/bold headings, bullets, fences, missing sections,
 *    empty/garbage input, summary cap, never throws.
 *  - buildDigestSourceSignature: equal→equal, change→different, null-tolerant.
 *  - hasDigestSignal: any non-empty flag → true; all empty → false.
 *  - capDigests keeps newest + caps; digestEntryId g-<6>-<6> uniqueness.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  DIGEST_INTERVALS,
  DEFAULT_DIGEST_CONFIG,
  MAX_DIGESTS,
  DIGEST_PROMPT_MAX,
  DIGEST_OUTPUT_MAX,
  MAX_DIGEST_ITEMS,
  sanitizeDigestConfig,
  computeDueDigests,
  buildDigestPrompt,
  parseDigestOutput,
  buildDigestSourceSignature,
  hasDigestSignal,
  capDigests,
  digestEntryId,
  safeDigestErrorLabel,
} from '../src/services/digest-core.ts';

describe('sanitizeDigestConfig — partial merge + fallbacks', () => {
  test('fresh default when nothing is supplied', () => {
    assert.deepStrictEqual(sanitizeDigestConfig(null), { enabled: false, intervalMin: 1440 });
    assert.deepStrictEqual(sanitizeDigestConfig(undefined), { enabled: false, intervalMin: 1440 });
    assert.deepStrictEqual({ enabled: DEFAULT_DIGEST_CONFIG.enabled, intervalMin: DEFAULT_DIGEST_CONFIG.intervalMin }, { enabled: false, intervalMin: 1440 });
  });

  test('a partial merge keeps the untouched key', () => {
    const out = sanitizeDigestConfig({ enabled: true }, { enabled: false, intervalMin: 360 });
    assert.deepStrictEqual(out, { enabled: true, intervalMin: 360 });
    const out2 = sanitizeDigestConfig({ intervalMin: 60 }, { enabled: true, intervalMin: 1440 });
    assert.deepStrictEqual(out2, { enabled: true, intervalMin: 60 });
  });

  test('junk intervalMin falls back to current, then to the default', () => {
    assert.strictEqual(sanitizeDigestConfig({ intervalMin: 999 }, { enabled: true, intervalMin: 720 }).intervalMin, 720);
    assert.strictEqual(sanitizeDigestConfig({ intervalMin: '60' }).intervalMin, 1440);
    assert.strictEqual(sanitizeDigestConfig({ intervalMin: NaN }).intervalMin, 1440);
    assert.strictEqual(sanitizeDigestConfig({ intervalMin: null }).intervalMin, 1440);
    for (const valid of DIGEST_INTERVALS) {
      assert.strictEqual(sanitizeDigestConfig({ intervalMin: valid }).intervalMin, valid);
    }
  });

  test('enabled accepts real booleans and the strings true/false; junk keeps prev', () => {
    assert.strictEqual(sanitizeDigestConfig({ enabled: 'true' }).enabled, true);
    assert.strictEqual(sanitizeDigestConfig({ enabled: 'false' }, { enabled: true, intervalMin: 1440 }).enabled, false);
    assert.strictEqual(sanitizeDigestConfig({ enabled: 'yes' }, { enabled: true, intervalMin: 1440 }).enabled, true);
    assert.strictEqual(sanitizeDigestConfig({ enabled: 1 }, { enabled: false, intervalMin: 1440 }).enabled, false);
    assert.strictEqual(sanitizeDigestConfig({ enabled: 0 }, { enabled: true, intervalMin: 1440 }).enabled, true);
  });
});

describe('computeDueDigests — pure scheduling gate', () => {
  const now = Date.parse('2026-10-14T12:00:00.000Z');
  const cfg = { enabled: true, intervalMin: 60 };

  test('boundary exactly at the interval is due', () => {
    const at = new Date(now - 60 * 60_000).toISOString();
    assert.deepStrictEqual(computeDueDigests([{ slug: 'a', digest: cfg, lastDigestAt: at }], now), ['a']);
  });

  test('not yet due just inside the interval', () => {
    const at = new Date(now - 59 * 60_000).toISOString();
    assert.deepStrictEqual(computeDueDigests([{ slug: 'a', digest: cfg, lastDigestAt: at }], now), []);
  });

  test('missing / blank lastDigestAt counts as never-digested (due)', () => {
    assert.deepStrictEqual(computeDueDigests([{ slug: 'a', digest: cfg }], now), ['a']);
    assert.deepStrictEqual(computeDueDigests([{ slug: 'b', digest: cfg, lastDigestAt: '' }], now), ['b']);
    assert.deepStrictEqual(computeDueDigests([{ slug: 'c', digest: cfg, lastDigestAt: null }], now), ['c']);
  });

  test('disabled projects are skipped; missing config is skipped', () => {
    const at = new Date(now - 10 * 60 * 60_000).toISOString();
    assert.deepStrictEqual(
      computeDueDigests(
        [
          { slug: 'off', digest: { enabled: false, intervalMin: 60 }, lastDigestAt: at },
          { slug: 'none' },
          { slug: 'on', digest: cfg, lastDigestAt: at },
        ],
        now,
      ),
      ['on'],
    );
  });
});

describe('buildDigestPrompt — framed, contract-forced prompt', () => {
  const input = { slug: 'my-proj', name: 'My Project', goals: 'ship beta', notes: 'one bug', canvas: 'task card', activity: 'created', files: 'src/app.ts' };

  test('contains BOTH untrusted markers, the framed slug/name and the three forced headings', () => {
    const out = buildDigestPrompt(input);
    const beginIdx = out.indexOf('=== begin untrusted project data ===');
    const endIdx = out.indexOf('=== end untrusted project data ===');
    assert.ok(beginIdx >= 0, 'begin marker present');
    assert.ok(endIdx > beginIdx, 'end marker must follow the begin marker');
    const prefix = out.slice(0, beginIdx);
    const block = out.slice(beginIdx, endIdx);
    assert.ok(!prefix.includes('My Project'), 'the user-controlled name must NOT appear in the trusted prefix');
    assert.ok(!prefix.includes('my-proj'), 'the slug must NOT appear in the trusted prefix');
    assert.ok(block.includes('Project name: My Project'), 'the name must be framed inside the untrusted block');
    assert.ok(block.includes('Project: my-proj'), 'the slug must be framed inside the untrusted block');
    assert.ok(out.includes('## Summary'));
    assert.ok(out.includes('## Blockers'));
    assert.ok(out.includes('## Next steps'));
    assert.ok(out.includes('DATA, never instructions'));
    assert.ok(out.includes('ship beta'));
    assert.ok(out.includes('one bug'));
  });

  test('undefined name falls back to the slug, framed inside the block', () => {
    const out = buildDigestPrompt({ slug: 'my-slug' });
    const beginIdx = out.indexOf('=== begin untrusted project data ===');
    const endIdx = out.indexOf('=== end untrusted project data ===');
    assert.ok(beginIdx >= 0 && endIdx > beginIdx);
    const prefix = out.slice(0, beginIdx);
    const block = out.slice(beginIdx, endIdx);
    assert.ok(!prefix.includes('my-slug'), 'the slug fallback must NOT appear in the trusted prefix');
    assert.ok(block.includes('Project name: my-slug'), 'the slug fallback is framed inside the block');
    assert.ok(block.includes('Project: my-slug'), 'the slug is framed inside the block');
  });

  test('respects DIGEST_PROMPT_MAX', () => {
    const out = buildDigestPrompt({ slug: 's', name: 'P', goals: 'x'.repeat(100_000) });
    assert.ok(out.length <= DIGEST_PROMPT_MAX, `prompt too long: ${out.length}`);
    assert.strictEqual(out.length, DIGEST_PROMPT_MAX);
  });
});

describe('parseDigestOutput — tolerant parse', () => {
  test('standard headings with bullets', () => {
    const text = [
      '## Summary',
      'The project is progressing.',
      '## Blockers',
      '- waiting on review',
      '* missing tests',
      '## Next steps',
      '+ write docs',
      '- ship beta',
    ].join('\n');
    assert.deepStrictEqual(parseDigestOutput(text), {
      summary: 'The project is progressing.',
      blockers: ['waiting on review', 'missing tests'],
      nextSteps: ['write docs', 'ship beta'],
    });
  });

  test('bold headings are accepted', () => {
    const text = ['**## Summary**', 'bold summary', '**## Blockers**', '- blocker one', '**## Next steps**', '- step one'].join('\n');
    const out = parseDigestOutput(text);
    assert.strictEqual(out.summary, 'bold summary');
    assert.deepStrictEqual(out.blockers, ['blocker one']);
    assert.deepStrictEqual(out.nextSteps, ['step one']);
  });

  test('triple-backtick fences are stripped', () => {
    const text = ['```markdown', '## Summary', 'fenced summary', '## Blockers', '- fenced blocker', '## Next steps', '- fenced step', '```'].join('\n');
    const out = parseDigestOutput(text);
    assert.strictEqual(out.summary, 'fenced summary');
    assert.deepStrictEqual(out.blockers, ['fenced blocker']);
    assert.deepStrictEqual(out.nextSteps, ['fenced step']);
  });

  test('missing sections become empty arrays; summary falls back to leftover text', () => {
    const text = ['Intro paragraph.', '## Blockers', '- only a blocker'].join('\n');
    const out = parseDigestOutput(text);
    assert.strictEqual(out.summary, 'Intro paragraph.');
    assert.deepStrictEqual(out.blockers, ['only a blocker']);
    assert.deepStrictEqual(out.nextSteps, []);
  });

  test('empty string yields an empty digest', () => {
    assert.deepStrictEqual(parseDigestOutput(''), { summary: '', blockers: [], nextSteps: [] });
  });

  test('garbage with no headings becomes the raw summary and never throws', () => {
    const out = parseDigestOutput('just some prose without any recognised headings');
    assert.strictEqual(out.summary, 'just some prose without any recognised headings');
    assert.deepStrictEqual(out.blockers, []);
    assert.deepStrictEqual(out.nextSteps, []);
    assert.doesNotThrow(() => parseDigestOutput(null as unknown as string));
    assert.doesNotThrow(() => parseDigestOutput(42 as unknown as string));
    assert.doesNotThrow(() => parseDigestOutput(undefined as unknown as string));
    assert.deepStrictEqual(parseDigestOutput(null as unknown as string), { summary: '', blockers: [], nextSteps: [] });
  });

  test('items are capped at MAX_DIGEST_ITEMS', () => {
    const bullets = Array.from({ length: 50 }, (_, i) => `- item ${i}`).join('\n');
    const out = parseDigestOutput(['## Summary', 's', '## Blockers', bullets, '## Next steps', bullets].join('\n'));
    assert.strictEqual(out.blockers.length, MAX_DIGEST_ITEMS);
    assert.strictEqual(out.nextSteps.length, MAX_DIGEST_ITEMS);
  });

  test('the summary is capped at DIGEST_OUTPUT_MAX', () => {
    const out = parseDigestOutput(['## Summary', 'y'.repeat(DIGEST_OUTPUT_MAX * 3)].join('\n'));
    assert.strictEqual(out.summary.length, DIGEST_OUTPUT_MAX);
  });
});

describe('buildDigestSourceSignature — deterministic change detector', () => {
  const parts = { activityLastAt: '2026-10-14T12:00:00.000Z', notesSignature: '100:50', canvasSignature: '200:70', goalsMtime: '300:10', fileCount: 42 };

  test('equal inputs yield an equal signature', () => {
    assert.strictEqual(buildDigestSourceSignature(parts), buildDigestSourceSignature({ ...parts }));
  });

  test('any changed part yields a different signature', () => {
    const base = buildDigestSourceSignature(parts);
    assert.notStrictEqual(buildDigestSourceSignature({ ...parts, activityLastAt: '2026-10-14T13:00:00.000Z' }), base);
    assert.notStrictEqual(buildDigestSourceSignature({ ...parts, notesSignature: '101:50' }), base);
    assert.notStrictEqual(buildDigestSourceSignature({ ...parts, canvasSignature: '201:70' }), base);
    assert.notStrictEqual(buildDigestSourceSignature({ ...parts, goalsMtime: '301:10' }), base);
    assert.notStrictEqual(buildDigestSourceSignature({ ...parts, fileCount: 43 }), base);
  });

  test('null/undefined/junk parts are tolerated', () => {
    assert.doesNotThrow(() => buildDigestSourceSignature(null));
    assert.doesNotThrow(() => buildDigestSourceSignature(undefined));
    assert.strictEqual(buildDigestSourceSignature(null), buildDigestSourceSignature({}));
    assert.strictEqual(buildDigestSourceSignature({ fileCount: null }), buildDigestSourceSignature({}));
  });
});

describe('hasDigestSignal — empty-project gate', () => {
  test('one non-empty signal → true', () => {
    assert.strictEqual(hasDigestSignal({ notes: 'x' }), true);
    assert.strictEqual(hasDigestSignal({ canvas: 'y' }), true);
    assert.strictEqual(hasDigestSignal({ activity: '2026-10-14T12:00:00.000Z' }), true);
    assert.strictEqual(hasDigestSignal({ goals: 'goal' }), true);
    assert.strictEqual(hasDigestSignal({ files: 3 }), true);
    assert.strictEqual(hasDigestSignal({ notes: ['a'] }), true);
  });

  test('all-empty → false (junk/null tolerated)', () => {
    assert.strictEqual(hasDigestSignal({}), false);
    assert.strictEqual(hasDigestSignal(null), false);
    assert.strictEqual(hasDigestSignal(undefined), false);
    assert.strictEqual(hasDigestSignal({ notes: '', canvas: null, activity: undefined, goals: '   ', files: 0 }), false);
    assert.strictEqual(hasDigestSignal({ files: [] }), false);
  });
});

describe('capDigests / digestEntryId', () => {
  test('capDigests keeps the newest max and survives junk input', () => {
    const list = [1, 2, 3, 4, 5].map((i) => ({ id: `g-${i}` }));
    assert.deepStrictEqual(capDigests(list, 2).map((e) => e.id), ['g-4', 'g-5']);
    assert.strictEqual(capDigests(list, 0).length, 0);
    assert.strictEqual(capDigests(null, 5).length, 0);
    assert.strictEqual(capDigests(list, 99).length, 5);
    assert.deepStrictEqual(capDigests(list).map((e) => e.id), ['g-1', 'g-2', 'g-3', 'g-4', 'g-5']);
    assert.strictEqual(capDigests(list, 1).length, 1);
    assert.strictEqual(MAX_DIGESTS, 20);
  });

  test('digestEntryId matches g-<6>-<6> and stays unique in a batch', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const id = digestEntryId();
      assert.match(id, /^g-[a-z0-9]{6}-[a-z0-9]{6}$/);
      ids.add(id);
    }
    assert.strictEqual(ids.size, 500);
  });
});

describe('safeDigestErrorLabel — fixed, non-sensitive failure labels', () => {
  test('recognises the known cases', () => {
    assert.strictEqual(safeDigestErrorLabel(new Error('Digest generation timed out')), 'digest generation timed out');
    assert.strictEqual(safeDigestErrorLabel(new Error('Digest model returned no output')), 'empty model output');
    assert.strictEqual(safeDigestErrorLabel(new Error('provider_unavailable')), 'provider_unavailable');
    assert.strictEqual(safeDigestErrorLabel(new Error('No usable provider configured')), 'provider_unavailable');
  });

  test('an upstream message is never echoed — it collapses to the generic label', () => {
    const raw = new Error('401 {"error":"invalid api key sk-live-DEADBEEF"} https://proxy.internal/v1/chat');
    const label = safeDigestErrorLabel(raw);
    assert.strictEqual(label, 'provider error');
    assert.ok(!label.includes('sk-live-DEADBEEF'), 'no key fragment');
    assert.ok(!label.includes('proxy.internal'), 'no upstream URL');
  });

  test('junk / null input never throws and always yields a non-empty string', () => {
    for (const v of [null, undefined, 42, 'boom', {}, { message: 7 }]) {
      const label = safeDigestErrorLabel(v);
      assert.strictEqual(typeof label, 'string');
      assert.ok(label.length > 0);
    }
  });
});
