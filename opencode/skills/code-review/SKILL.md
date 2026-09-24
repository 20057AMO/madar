---
name: code-review
description: Reviewing code changes — severity-ranked findings (CRITICAL → LOW) with file:line, an explicit list of what was verified clean, and a ship / fix-first / rework verdict. Use when a change or patch needs review before commit/merge. Use PROACTIVELY after any implementation is claimed done — the reviewer's independence is the point: never silently mutate what you inspect.
---

# Code Review skill

Scope: a review the author can act on without asking what you meant. Opinion is fine; unactionable opinion is not.

## The review loop
1. Read the diff fresh — never review from memory of the conversation
2. Trace each changed path: entry → validation → service → persistence → return; check the error branches and the permission gates, not just the happy path
3. Reproduce suspicious behavior claims in the running container when cheap to do — a reviewer who verifies beats a reviewer who guesses

## Findings: severity-ranked, file:line anchored
- **CRITICAL** — data loss, secret exposure, auth bypass, unbounded resource growth. Blocks merge, period
- **HIGH** — correct-under-normal-use but breaks on a realistic edge (concurrency, restart, boundary value)
- **MEDIUM** — robustness/hygiene: missing null-check, silent failure, inconsistent status code
- **LOW** — style, naming, dead code, non-blocking
- Every finding carries `path:line` and a one-sentence "why it matters" — the cost of the blast radius, not just the label
- Interrogate the hard classes explicitly: path traversal, rate-limiter scope misuse, masked vs plaintext secrets, permission matrices (viewer/editor/admin), 401 vs 403

## The verified-clean list
Say what you CHECKED and it held: "validation rejects junk before the service", "403s on all four roles", "no shell interpolation of the port", "activity entry recorded with actor". This is what makes the review trustworthy — a list of verified behaviors, not just a list of complaints.

## Verdict
- **ship** — findings are LOW or cosmetic
- **fix-first** — MEDIUM+ findings must be addressed; one re-review round expected
- **rework** — the approach is wrong (wrong layer, wrong service, duplicate mechanism); restart the round, do not patch around it

**Example**
Input: a ports-editing PR. Output: `services/docker-manager.ts:214 HIGH — stale live bindings not claimed, port can double-assign after an edit without recreate`; `index.ts:88 LOW — unused import`; verified clean: 400 junk matrix, 409 `taken[]`, self-exclusion, `{error,message}` shape. Verdict: fix-first.

A review that only praises ships bugs; a review that only complains ships ego.