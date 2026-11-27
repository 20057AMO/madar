---
name: wsd-workflow
description: Madar house rules — Docker rebuild gate, tsc/vite checks, serial test suite, commit discipline, PowerShell quirks. Use when working inside THIS repository on any change. Use PROACTIVELY before claiming any Madar task is done — these gates are non-negotiable.
---

# Madar Workflow skill

Scope: every code change in this repo. If you touched `frontend/` or `backend/` and have not passed the gates below, the task is NOT done.

## The non-negotiables
1. **Docker rebuild rule**: after ANY frontend/backend change:
   ```
   docker compose build app && docker compose up -d app
   ```
   Every feature is tested inside the running container. No exceptions.
2. **Local gates before Docker**:
   - `cd frontend && npm run typecheck`
   - `cd frontend && npm run build`
   - `cd backend && npm run typecheck`
3. **Full suite** (server up on :3000):
   ```
   cd backend && npm test
   ```
4. **Commit discipline**: task + tests + verification -> stage only intended files (`git add <paths>`, never `git add -A`), descriptive message, push, watch CI green.

## Area-by-area method (بالقطع)
One feature/area per round · full context + vertical goal BEFORE any edit · clarifying questions before new work.

## House style quick reference
ConfirmModal destructive ops · ReAuthModal sudo pattern · lucide-preact icons (`class="icon"`) · dark only · version `BETA` · error shape `{error,message}` · audit events for security-relevant actions.

## Windows host quirks
- PowerShell: no `&&` — use `if ($?)`; git stderr prints as PS errors harmlessly
- Container scripts: temp file → `docker cp` → exec; NEVER inline-quote complex sh through PowerShell (`$(...)` gets mangled)

## Pitfalls
- ❌ Parallel test runs ✅ `--test-concurrency=1` — parallel + browser polling trips the rate limiter
- ❌ Declaring done after local build only ✅ Rebuilt container + suite + manual probe of the changed path
- ❌ Batching unrelated fixes ✅ One area per commit so review and revert stay surgical

The rebuild gate exists because "works locally" has never once been evidence.
