---
name: backend-implementation
description: Server work in this repo — Express 5 + Node 22, route+service separation, middleware, validation, the `{error,message}` error shape, correct status codes, audit events for security-relevant actions. Use when implementing or updating a backend endpoint or service. Use PROACTIVELY when any change touches `backend/src` — before writing a route, load the house service and error conventions.
---

# Backend Implementation skill

Scope: Express 5 endpoints in `backend/src` that survive review — thin routes, fat services, honest errors, audited security actions.

## Route + service separation
- Routes stay thin: parse the request, call a service, map the result to JSON. Business logic lives in `backend/src/services/*.ts` (docker-manager, user-store, project-notes, …)
- Find the service that OWNS the area before writing new code — a new feature maps onto the owning service, never forks it
- Validation at the boundary: reject junk input with 400 BEFORE it reaches a service; `'X' in body` semantics for partial updates where the API defines them

## Error shape and status codes
- Errors are always `{error, message}` — never bare strings or arrays
- Correct codes: 400 validation, 401 missing/invalid token, 403 wrong-but-valid role, 404 unknown id/slug, 409 conflicts (busy port, duplicate), 429 rate-limited (with `Retry-After`), 503 upstream unavailable
- Route-level failure helpers throw `HttpError(code, message)` so one error handler owns the JSON shape

## Middleware and auth
- `authMiddleware` protects everything after `/api/auth/*`; role gates via `requireAdmin` / `requireRole`
- Per-user identity: sessions carry the USER'S OWN `id`/`username`/`role`/`tv`/`jti` — never impersonate another account
- Brute-forceable routes get a dedicated rate-limiter scope (auth 10/min, unlock 15/min + cooldown, totp 8/min); never reuse the global budget for a password-checking path

## Audit events
- Security-relevant actions (lock changes, unlocks, exports, transfers, password changes, 2FA) are appended to `data/audit.json` via the audit store — the failure never breaks the request flow
- Mutating project actions record a per-project activity entry with actor attribution; no actor → `'System'`

## Secrets and files
- Sealed at rest (secret-box, AES-256-GCM) — never store plaintext provider keys; mask with the stored `<last4>`, never echo bullets
- Persisted data files: mode 0600 (`providers.json`, `users.json`, `audit.json`), path-join against traversal, per-file sync locks for shared stores
- Verifying external hosts goes through the SSRF guard (http(s) only; cloud-metadata refused; local Ollama allowed)

**Example**
"Add `PUT /api/projects/:slug/limits`" → thin route validates body (`'cpu' in raw` semantics), `project-limits` service persists meta-first and returns honest `needsRecreate`, audit `project-limits`, activity `limits_updated`, all errors `{error,message}` with the codes above.

A route that returns the wrong status code costs a reviewer more than the code review itself.