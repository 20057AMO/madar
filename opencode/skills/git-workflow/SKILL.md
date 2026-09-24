---
name: git-workflow
description: Daily git discipline — inspect status/diff before staging, stage ONLY intended files (never `git add -A`), never commit secrets, `area: concise message` style, push right after commit. Use when preparing, staging or committing work. Use PROACTIVELY at the end of every completed task — a finished change that is not committed and pushed is a half-done task.
---

# Git Workflow skill

Scope: the commit hygiene that keeps a shared repo reviewable and secret-free. The rule of thumb: every commit is small enough that one reviewer can check it in one sitting.

## Before staging: inspect
1. `git status --short` — see exactly what changed before deciding what belongs
2. `git diff` — review the changes themselves; ask "is this the whole task, nothing more?"
3. Verify no stray artifacts (temp files, tool outputs, editor junk) are lurking untracked

## Staging: intended files only
- Stage each intended file explicitly — **never `git add -A`**: a stray temp file or tool artifact can slip junk or a secret into a commit
- After staging, re-run `git status` to confirm the staged list before committing — the staged list is the contract with your reviewer

## Secrets
- Never commit `.env`, `data/*`, tokens, cookies, keys or anything resembling credentials
- `.env` and the data directory are excluded by convention — if a file belongs there and would carry secrets, it does not belong in the commit
- If a secret ever lands in history, the fix is rotation, not deletion — report it, rotate it, then fix the staging discipline

## Commit message style
- Lowercase area prefix + concise description: `terminal: restore per-project Terminal tab`, `auth: per-user session identity`
- The prefix names the area, the body (when needed) says why — one area per commit so review and revert stay surgical
- Never use a single blob message like "updates" or "fix stuff"

## After the commit
- Push immediately: the task is not finished while the commit sits local
- Watch the remote checks after push; a red CI on a pushed commit is the same defect as a red test locally

**Example**
A session that touched `docker-manager.ts` + `AGENTS.md` → stage exactly `backend/src/services/docker-manager.ts` and `AGENTS.md`, leave the untracked scratch file behind, commit `delegate: add project-level agent runs and roster docs`, push, confirm green.

The staging list you show the reviewer is the diff they sign off on — make it the task and nothing else.