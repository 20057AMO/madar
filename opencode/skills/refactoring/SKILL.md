---
name: refactoring
description: Behavior-preserving refactoring — small steps, tests before and after, no unrelated changes bundled in. Use when code works but is hard to read, extend or trust. Use PROACTIVELY when a change is described as "while I was there I tidied up" — that is a refactor in disguise, and it must follow these rules instead of riding along.
---

# Refactoring skill

Scope: changing HOW code is structured without changing WHAT it does. The diff must be provably behavior-identical, one step at a time.

## The rules
- **Small steps only** — one mechanical transformation per commit: extract a function, rename, move a module, invert a branch. A 40-file refactor is a rewrite with a refactor's title
- **Tests before, tests after** — the pre-change suite runs green, the post-change suite runs green on the SAME assertions. If the area has no coverage, pin current behavior with a test FIRST, then refactor under it
- **No unrelated changes** — formatting, typo fixes and drive-by renames migrate into their own commits, or they taint review of the real change
- **No behavior drift** — error messages, status codes, edge-case handling and timing must survive byte-for-byte unless the refactor's stated goal explicitly includes them

## What is in scope
- Extract/replace duplication with the house pattern that already exists (never a new abstraction for two usages)
- Rename to the vocabulary the domain already uses (the service names, the API field names)
- Split a god-module only when the seams are real — route vs service, store vs schedule, pure core vs orchestration
- Move logic toward pure, import-free modules that `node --test` can load offline (the `*-core.ts` pattern)

## What is out of scope
- Behavior fixes, feature additions, perf work with visible side effects — those are features, plan them separately
- Migrating a working mechanism to a "better" one without a measured need (boring proven patterns beat novelty)

## Verification for every step
- `tsc --noEmit` on both sides, vite build, then the affected suite serially
- The Docker rebuild gate applies to refactors too — a refactor is a code change like any other

**Example**
`activity-core.ts` split → extract `sliceActivity`/`capActivity`/`entryId` as pure functions with offline unit tests, keep `project-activity.ts` orchestration untouched; run the suite: 19 offline units + live suite green. The diff is structural, the behavior identical.

If the review cannot tell what you changed beyond the shape, the refactor was honest.