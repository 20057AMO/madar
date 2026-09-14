/**
 * reviews-core.test.ts
 * Pure unit coverage for the file-reviews rules — no server, no Docker, no
 * service imports (same pattern as activity-core).
 *
 * Contract under test:
 *  - normalizeReviewPath: posix normalization, traversal/abs/backslash/control/
 *    oversize rejection, empty handling.
 *  - sanitizeCommentText: trim + 2000-char ceiling, junk → ''.
 *  - validateThreads: junk rows dropped, malicious paths dropped, missing
 *    fields rooted, status/comment normalization, caps enforced.
 *  - resolve/reopen: only the open → resolved → open path is allowed.
 *  - addComment / deleteComment (incl. last-comment + not-found guards).
 *  - reviewCounts / threadSummary.
 *  - reviewId / commentId formats.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  MAX_REVIEW_PATH,
  MAX_REVIEW_TEXT,
  MAX_THREADS,
  MAX_COMMENTS,
  normalizeReviewPath,
  sanitizeCommentText,
  validateThreads,
  resolveThread,
  reopenThread,
  addComment,
  deleteComment,
  reviewCounts,
  threadSummary,
  reviewId,
  commentId,
  type ReviewThread,
  type ReviewComment,
} from '../src/services/reviews-core.ts';

function makeThread(over: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: 'r-1',
    path: 'src/main.ts',
    status: 'open',
    createdAt: '2026-09-01T00:00:00.000Z',
    createdBy: 'u1',
    createdByName: 'alice',
    comments: [
      { id: 'c-1', text: 'first comment', userId: 'u1', username: 'alice', createdAt: '2026-09-01T00:00:00.000Z' },
      { id: 'c-2', text: 'reply', userId: 'u2', username: 'bob', createdAt: '2026-09-02T00:00:00.000Z' },
    ],
    ...over,
  };
}

describe('normalizeReviewPath — the safe-path matrix', () => {
  test('empty / whitespace-only input normalizes to empty string', () => {
    assert.strictEqual(normalizeReviewPath(''), '');
    assert.strictEqual(normalizeReviewPath('   '), '');
    assert.strictEqual(normalizeReviewPath(null), null);
    assert.strictEqual(normalizeReviewPath(undefined), null);
    assert.strictEqual(normalizeReviewPath(42), null);
    assert.strictEqual(normalizeReviewPath({}), null);
  });

  test('plain relative paths pass through with posix trims', () => {
    assert.strictEqual(normalizeReviewPath('src/main.ts'), 'src/main.ts');
    assert.strictEqual(normalizeReviewPath('./src/main.ts'), 'src/main.ts');
    assert.strictEqual(normalizeReviewPath('a/./b'), 'a/b');
    assert.strictEqual(normalizeReviewPath('a//b/'), 'a/b');
    assert.strictEqual(normalizeReviewPath('a/../b'), 'b');
    assert.strictEqual(normalizeReviewPath('  spaced  file.txt  '), 'spaced  file.txt');
    assert.strictEqual(normalizeReviewPath('a/b/c.d'), 'a/b/c.d');
  });

  test('traversal that escapes the project root is rejected', () => {
    assert.strictEqual(normalizeReviewPath('../evil'), null);
    assert.strictEqual(normalizeReviewPath('..'), null);
    assert.strictEqual(normalizeReviewPath('a/../../x'), null);
    assert.strictEqual(normalizeReviewPath('../../etc/passwd'), null);
    assert.strictEqual(normalizeReviewPath('a/b/../../../x'), null);
  });

  test('absolute / drive-letter / backslash / control-char forms rejected', () => {
    assert.strictEqual(normalizeReviewPath('/etc/passwd'), null);
    assert.strictEqual(normalizeReviewPath('//share'), null);
    assert.strictEqual(normalizeReviewPath('C:/x'), null);
    assert.strictEqual(normalizeReviewPath('c:/x'), null);
    assert.strictEqual(normalizeReviewPath('a\\b'), null);
    assert.strictEqual(normalizeReviewPath('a\\b/c'), null);
    assert.strictEqual(normalizeReviewPath('a\x00b'), null);
    assert.strictEqual(normalizeReviewPath('a\nb'), null);
    assert.strictEqual(normalizeReviewPath('a\tb'), null);
    assert.strictEqual(normalizeReviewPath('a\x1fb'), null);
  });

  test('length ceiling: exactly MAX is fine, one more is refused', () => {
    assert.strictEqual(normalizeReviewPath('x'.repeat(MAX_REVIEW_PATH)), 'x'.repeat(MAX_REVIEW_PATH));
    assert.strictEqual(normalizeReviewPath('x'.repeat(MAX_REVIEW_PATH + 1)), null);
  });
});

describe('sanitizeCommentText — trim + ceiling', () => {
  test('trims whitespace and truncates to MAX_REVIEW_TEXT', () => {
    assert.strictEqual(sanitizeCommentText('  hello  '), 'hello');
    const big = 'x'.repeat(5000);
    const out = sanitizeCommentText(big);
    assert.strictEqual(out.length, MAX_REVIEW_TEXT);
    assert.ok(out.endsWith('x'.repeat(MAX_REVIEW_TEXT)));
  });

  test('junk input yields empty string', () => {
    assert.strictEqual(sanitizeCommentText(null), '');
    assert.strictEqual(sanitizeCommentText(42), '');
    assert.strictEqual(sanitizeCommentText({}), '');
    assert.strictEqual(sanitizeCommentText(undefined), '');
    assert.strictEqual(sanitizeCommentText('   '), '');
  });
});

describe('validateThreads — corrupt-store normalization', () => {
  const NOW = '2026-09-10T08:00:00.000Z';

  test('junk rows and malicious paths are dropped', () => {
    const raw = [
      null,
      42,
      'junk',
      { id: 'r-ok', path: 'src/a.ts', status: 'open', createdAt: NOW },
      { id: 'r-evil', path: '../escape', status: 'open', createdAt: NOW },
      { id: 'r-empty', path: '', status: 'open', createdAt: NOW },
      { id: 'r-abs', path: '/abs', status: 'open', createdAt: NOW },
    ];
    const out = validateThreads(raw, NOW);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].id, 'r-ok');
  });

  test('missing fields are rooted (id/createdAt generated, names defaulted)', () => {
    const raw = [{ path: 'src/missing.ts' }];
    const out = validateThreads(raw, NOW);
    assert.strictEqual(out.length, 1);
    assert.match(out[0].id, /^r-[a-z0-9-]+$/);
    assert.strictEqual(out[0].createdAt, NOW);
    assert.strictEqual(out[0].createdBy, '');
    assert.strictEqual(out[0].createdByName, '');
    assert.strictEqual(out[0].status, 'open');
    assert.deepStrictEqual(out[0].comments, []);
  });

  test('unknown status defaults to open; resolved rows keep resolution fields', () => {
    const resolved = validateThreads([
      { id: 'r-a', path: 'a.ts', status: 'resolved', createdAt: NOW, resolvedAt: '2026-09-02T00:00:00.000Z', resolvedBy: 'u9', resolvedByName: 'zoe' },
      { id: 'r-b', path: 'b.ts', status: 'weird', createdAt: NOW, resolvedAt: '2026-09-02T00:00:00.000Z' },
    ], NOW);
    assert.strictEqual(resolved[0].status, 'resolved');
    assert.strictEqual(resolved[0].resolvedAt, '2026-09-02T00:00:00.000Z');
    assert.strictEqual(resolved[0].resolvedBy, 'u9');
    assert.strictEqual(resolved[0].resolvedByName, 'zoe');
    // Stale resolution fields never leak onto an open row.
    assert.strictEqual(resolved[1].status, 'open');
    assert.strictEqual(resolved[1].resolvedAt, undefined);
  });

  test('comments are normalized: junk dropped, text truncated, ids rooted', () => {
    const raw = [{
      id: 'r-1',
      path: 'x.ts',
      status: 'open',
      createdAt: NOW,
      createdBy: 'u1',
      createdByName: 'alice',
      comments: [
        { id: 'c-1', text: 'valid', userId: 'u1', username: 'alice', createdAt: NOW },
        42,
        { text: 'x'.repeat(5000), userId: 'u2', username: 'bob', createdAt: NOW },
        { id: 'c-2', text: '  ', userId: 'u3', username: 'carol', createdAt: NOW },
      ],
    }];
    const out = validateThreads(raw, NOW);
    assert.strictEqual(out[0].comments.length, 2);
    assert.strictEqual(out[0].comments[0].text, 'valid');
    assert.strictEqual(out[0].comments[1].text.length, MAX_REVIEW_TEXT);
    assert.match(out[0].comments[1].id, /^c-/);
  });

  test('ceiling: at most MAX_THREADS threads and MAX_COMMENTS comments per thread', () => {
    const flood = Array.from({ length: MAX_THREADS + 5 }, (_, i) => ({
      id: `r-${i}`,
      path: `f/${i}.ts`,
      status: 'open',
      createdAt: NOW,
      comments: Array.from({ length: MAX_COMMENTS + 3 }, (_, j) => ({
        id: `c-${i}-${j}`,
        text: `comment ${j}`,
        userId: 'u1',
        username: 'alice',
        createdAt: NOW,
      })),
    }));
    const out = validateThreads(flood, NOW);
    assert.strictEqual(out.length, MAX_THREADS);
    assert.strictEqual(out[0].comments.length, MAX_COMMENTS);
  });

  test('duplicate thread ids are dropped (first wins, second silently skipped)', () => {
    const raw = [
      { id: 'r-dup', path: 'a.ts', status: 'open', createdAt: NOW },
      { id: 'r-dup', path: 'b.ts', status: 'open', createdAt: NOW },
      { id: 'r-ok', path: 'c.ts', status: 'open', createdAt: NOW },
    ];
    const out = validateThreads(raw, NOW);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].id, 'r-dup');
    assert.strictEqual(out[0].path, 'a.ts');
    assert.strictEqual(out[1].id, 'r-ok');
  });

  test('duplicate comment ids within a thread are dropped', () => {
    const raw = [{
      id: 'r-1',
      path: 'x.ts',
      status: 'open',
      createdAt: NOW,
      comments: [
        { id: 'c-dup', text: 'first', userId: 'u1', username: 'a', createdAt: NOW },
        { id: 'c-dup', text: 'second — dupe', userId: 'u2', username: 'b', createdAt: NOW },
        { id: 'c-ok', text: 'third — unique', userId: 'u3', username: 'c', createdAt: NOW },
      ],
    }];
    const out = validateThreads(raw, NOW);
    assert.strictEqual(out[0].comments.length, 2);
    assert.strictEqual(out[0].comments[0].id, 'c-dup');
    assert.strictEqual(out[0].comments[0].text, 'first');
    assert.strictEqual(out[0].comments[1].id, 'c-ok');
  });

  test('generated fallback ids (missing/invalid) are never treated as duplicates', () => {
    const raw = [
      { path: 'a.ts', status: 'open', createdAt: NOW },          // no id → generated
      { path: 'b.ts', status: 'open', createdAt: NOW },          // no id → generated
      { id: '', path: 'c.ts', status: 'open', createdAt: NOW },  // empty → generated
      { id: 42, path: 'd.ts', status: 'open', createdAt: NOW },  // junk → generated
    ];
    const out = validateThreads(raw, NOW);
    assert.strictEqual(out.length, 4, 'all four survive because none share a real input id');
  });

  test('non-array input yields an empty list', () => {
    assert.deepStrictEqual(validateThreads(null, NOW), []);
    assert.deepStrictEqual(validateThreads({ threads: [] }, NOW), []);
    assert.deepStrictEqual(validateThreads('x', NOW), []);
  });
});

describe('resolve / reopen — the only allowed transition path', () => {
  const NOW = '2026-09-05T00:00:00.000Z';

  test('open → resolved stamps resolution fields', () => {
    const t = makeThread();
    const r = resolveThread(t, 'u2', 'bob', NOW);
    assert.strictEqual(r.status, 'resolved');
    assert.strictEqual(r.resolvedAt, NOW);
    assert.strictEqual(r.resolvedBy, 'u2');
    assert.strictEqual(r.resolvedByName, 'bob');
    assert.strictEqual(r.comments.length, 2, 'comments untouched');
  });

  test('resolve on an already-resolved thread is a no-op', () => {
    const t = makeThread({ status: 'resolved', resolvedAt: '2026-09-03T00:00:00.000Z', resolvedBy: 'u1', resolvedByName: 'alice' });
    const r = resolveThread(t, 'u2', 'bob', NOW);
    assert.strictEqual(r, t, 'same object returned — no re-stamp');
    assert.strictEqual(r.resolvedAt, '2026-09-03T00:00:00.000Z');
  });

  test('resolved → open strips resolution fields', () => {
    const t = makeThread({ status: 'resolved', resolvedAt: '2026-09-03T00:00:00.000Z', resolvedBy: 'u1', resolvedByName: 'alice' });
    const r = reopenThread(t);
    assert.strictEqual(r.status, 'open');
    assert.strictEqual(r.resolvedAt, undefined);
    assert.strictEqual(r.resolvedBy, undefined);
    assert.strictEqual(r.resolvedByName, undefined);
    assert.strictEqual(r.comments.length, 2);
  });

  test('reopen on an already-open thread is a no-op', () => {
    const t = makeThread();
    assert.strictEqual(reopenThread(t), t);
  });

  test('full cycle open → resolved → open → resolved works', () => {
    let t = makeThread();
    t = resolveThread(t, 'u2', 'bob', '2026-09-04T00:00:00.000Z');
    t = reopenThread(t);
    assert.strictEqual(t.status, 'open');
    t = resolveThread(t, 'u1', 'alice', '2026-09-05T00:00:00.000Z');
    assert.strictEqual(t.status, 'resolved');
    assert.strictEqual(t.resolvedBy, 'u1');
  });
});

describe('addComment / deleteComment', () => {
  test('addComment appends and preserves earlier comments', () => {
    const t = makeThread();
    const c: ReviewComment = { id: 'c-9', text: 'new reply', userId: 'u3', username: 'carol', createdAt: '2026-09-03T00:00:00.000Z' };
    const out = addComment(t, c);
    assert.strictEqual(out.comments.length, 3);
    assert.strictEqual(out.comments[2], c);
    assert.strictEqual(t.comments.length, 2, 'original untouched (immutable)');
  });

  test('deleteComment removes a middle comment', () => {
    const t = makeThread();
    const res = deleteComment(t, 'c-1');
    assert.strictEqual(res.error, null);
    assert.strictEqual(res.thread?.comments.length, 1);
    assert.strictEqual(res.thread?.comments[0].id, 'c-2');
  });

  test('deleteComment refuses the last remaining comment', () => {
    const t = makeThread({ comments: [makeThread().comments[0]] });
    const res = deleteComment(t, 'c-1');
    assert.strictEqual(res.thread, null);
    assert.strictEqual(res.error, 'last-comment');
  });

  test('deleteComment reports not-found for a junk id', () => {
    const res = deleteComment(makeThread(), 'nope');
    assert.strictEqual(res.thread, null);
    assert.strictEqual(res.error, 'not-found');
  });
});

describe('reviewCounts / threadSummary', () => {
  test('counts split open/resolved with an honest total', () => {
    const threads = [
      makeThread(),
      makeThread({ id: 'r-2', status: 'resolved' }),
      makeThread({ id: 'r-3' }),
    ];
    assert.deepStrictEqual(reviewCounts(threads), { open: 2, resolved: 1, total: 3 });
    assert.deepStrictEqual(reviewCounts([]), { open: 0, resolved: 0, total: 0 });
    assert.deepStrictEqual(reviewCounts(null as unknown as ReviewThread[]), { open: 0, resolved: 0, total: 0 });
  });

  test('summary counts comments and picks the newest activity timestamp', () => {
    const t = makeThread(); // comments at 09-01 and 09-02
    const s = threadSummary(t);
    assert.strictEqual(s.commentCount, 2);
    assert.strictEqual(s.lastActivityAt, '2026-09-02T00:00:00.000Z');

    const resolved = makeThread({ status: 'resolved', resolvedAt: '2026-09-04T00:00:00.000Z' });
    assert.strictEqual(threadSummary(resolved).lastActivityAt, '2026-09-04T00:00:00.000Z');

    const single = makeThread({ comments: [makeThread().comments[0]] });
    assert.strictEqual(threadSummary(single).lastActivityAt, '2026-09-01T00:00:00.000Z');
  });
});

describe('reviewId / commentId — formats', () => {
  test('match the stable r-/c- prefixes and stay unique in a batch', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const a = reviewId();
      const b = commentId();
      assert.match(a, /^r-[a-z0-9-]+$/);
      assert.match(b, /^c-[a-z0-9-]+$/);
      ids.add(a);
      ids.add(b);
    }
    assert.strictEqual(ids.size, 600);
  });
});