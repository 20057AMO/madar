# AGENTS.md — Madar

> **Naming (2026-08)**: the product was renamed **WSD-Pro → Madar (مدار)**. All user-facing strings, docs and baked opencode content say Madar; the GitHub repo is now `20057AMO/madar` and backup downloads are named `madar-backup-*.json` (legacy `wsd-pro-backup` exports still importable). Deliberately KEPT for data/infra compatibility: `wsd.*` localStorage keys, `WSD_*` env vars, docker resource names (`wsd-pro` container, `wsd-pro-app` image, `wsd-<slug>` project containers, `wsd/workspace` image), JWT default-secret literals, the per-project goals filename `WSD_PROJECT.md`, and the legacy `wsd-pro-backup` import marker alongside the new `madar-backup`.

## Vertical Goal (الهدف الرأسي)

**Madar is an excellent, professional environment for a development team — بيئة متكاملة واحترافية لفريق تطوير.**

The product unifies the whole development lifecycle in one place:
- **بيئة تطوير مستقلة لكل مشروع** — حاوية خاصة + محرر VS Code مضمّن + طرفية + ملفات + سجلات
- **تخطيط وتوثيق** — لوحة التخطيط البصري (Canvas) + ملاحظات (أفكار/أخطاء/أهداف) + نظرة سياق ذكية
- **ذكاء اصطناعي مدمج** — opencode + وكلاء/مهارات/أوامر + محادثة بسياق المشروع الكامل
- **تعاون وفريق** — أعضاء وأدوار وصلاحيات + لقطات/نسخ احتياطية + مراقبة وتنبيهات + مقاييس تخزين

كل ميزة أو تعديل يجب أن يخدم هذا الهدف: بيئة واحدة احترافية يعمل فيها الفريق من التخطيط إلى التطوير والاختبار والإنتاج.

## Docker Rebuild Rule

After every code change to `frontend/` or `backend/`, always rebuild and restart the container:

```bash
docker compose build app && docker compose up -d app
```

No exceptions. Every feature, fix, or refactor must be tested inside the running container.

## Build & Verify

### Local (development)
```bash
cd frontend && node node_modules\typescript\bin\tsc --noEmit
cd frontend && node node_modules\vite\bin\vite.js build
cd backend && node node_modules\typescript\bin\tsc --noEmit
```

### Docker (integration)
```bash
docker compose build app && docker compose up -d app
```

## Testing

Full backend suite against the running container (server must be up on port 3000):

```bash
cd backend && node --test --test-concurrency=1 "tests/**/*.test.ts"
```

| Suite | File | Coverage |
|-------|------|----------|
| Auth & access control | `tests/auth.test.ts` | 401s, forged/tampered/expired tokens, setup guard, **per-user login identity matrix** (editor/viewer logins sign their OWN id/role/JWT — the fix that ended first-admin session impersonation — 403s through `requireAdmin`/`requireRole`, revocation-aware `tv`, sessions never carry the `2fa-pending` scope), deep **per-user 2FA journey** (enrol TOTP on a NON-first editor → challenge → verify signs the editor; pending token minted for the challenged user) gated behind `WSD_TEST_ACCOUNT_PASSWORD` (isolated server) because it costs 4 slots of the shared 10/min auth limiter; all login/setup calls use `Retry-After` backoff so window bleed from other suites never 429s the assertions |
| Session revocation | `tests/auth-revoke.test.ts` | logout-everywhere + token rotation (needs `WSD_TEST_ACCOUNT_PASSWORD`; self-skips) |
| Project lifecycle | `tests/projects.lifecycle.test.ts` | Real Docker: create → env → files → logs/stats/ports → stop/start → delete → 404; **duplicate** feature (copy source project: workspaces files + developer notes + **planning canvas** carried over, fresh ports applied, owner = duplicator) via `POST /api/projects/:slug/duplicate` |
| Project ports edit | `tests/project-ports.test.ts` | Real Docker published-ports editing: `PUT /api/projects/:slug/ports` (editor+, audited) persists a validated+deduped (cap 50, no privileged/reserved ≤65535) set into meta immediately — applied only on the next explicit recreate (Docker can't rebind live), honest `needsRecreate`; **self-exclusion vs sibling conflicts**, 409+`taken[]`, **stale LIVE bindings of edited-but-not-recreated siblings** and **stopped containers' baked `HostConfig.PortBindings`** (which the cheap docker list misses — inspected individually) still block the claim; snapshot manifest serializes the *edited meta* while stale; access matrix (non-member viewer 403 / viewer member 403 / editor member 200), 404 unknown |
| Project limits | `tests/project-limits.test.ts`: 12 live Docker tests — meta-first CPU/memory edit (`PUT /api/projects/:slug/limits`, editor+, audited `project-limits`) → applied on the next **explicit recreate** (cgroup caps can't rebind live), honest `needsRecreate` that reads clean after recreate (re-persist → false), creation-time limits applied immediately, duplicate inherits source limits, snapshot manifest deliberately excludes limits (restore = fresh machine), partial-update contract (`'cpu' in body` semantics, memory-only PUT preserves cpu), `null` removal + full clear, non-canonical round-trip normalization (`2500m`/`1G` → the exact inspected form, never an endless recreate loop), **`MemorySwap` pinned to the memory total** (`docker inspect` asserts `MemorySwap === Memory` — swap disabled, not `-1`/unlimited), stop/start keeps baked caps, access matrix 403/403/200, 404 unknown + `tests/project-limits-core.test.ts`: 31 offline unit tests (parse/ceilings/merge/round-trip) |
| Static site serve (core) | `tests/serve-core.test.ts` | 17 offline units on the import-free `serve-core.ts` (like janitor-core/snapshots-schedule): `sanitizeServeConfig` port matrix (explicit published port honored, junk/0/non-published → 400, no-port → first published, prev.port kept while still published / re-defaulted once dropped, empty published set → 400, null/empty-string treated absent), **exact argv** `['python3','-m','http.server',port,'-d','/workspace']` (no shell chars), `deriveServeState` honesty (disabled → inactive with no port/url, probe-null config-only, probe ok → active, refused → error, configured port no longer published → hostPort/url omitted), `serveUrl` host/hostPort forms |
| Static site serve (Docker) | `tests/project-serve.test.ts` | Real Docker roundtrip: POST start on a published port → live host probe active + marker `index.html` served over the host port; **list is config-only by design** (`enabled` ticks, `active` honestly false — no N+1 probes); stop flips `enabled:false` and the port stops answering; **restart persistence** (stop→start auto re-runs via `ensureServeRunning`) + **recreate persistence** (prev-meta merge, auto re-run); validation matrix (non-published port 400, no-ports project 400, stopped container 409 — rejected edits never disturb a running serve); access matrix (outsider viewer 403 on all routes / viewer member 403 on writes + 200 status); 404 on all three routes; **in-use-port 409** (a live non-SO_REUSEADDR holder inside the container forces the EADDRINUSE the 409 path relies on; failed start persists neither `enabled` nor `active`) |
| Project snapshots | `tests/project-snapshots.test.ts` | Real Docker roundtrip: create source (file+notes+**canvas**+env+meta) → `GET /projects/:slug/export` (gzip magic + attachment filename) → `POST /projects/import` multipart → restored copy: files/notes/canvas/env/description preserved (canvas nodes/edges ids survive losslessly), ports fresh while source holds them, **manifest ports reused once the source is gone**, 404 unknown, non-member viewer export/import 403, garbage/empty uploads 400, hand-crafted `../`-traversal tar 400 |
| Snapshot automation | `tests/project-snapshots-auto.test.ts` | Scheduled server-side backups: defaults + partial-config validation, capture-now (archive on disk + lastSnapshotAt stamp), **retention pruning to `keep`**, download (gzip+filename) → delete → 404, restore filed snapshot into a brand-new project (files/notes/**canvas**/description), member-viewer read-only vs outsider 403 matrix, and pure `computeDueSnapshots` interval rules (import-free `snapshots-schedule.ts`, like janitor-core) |
| Project team & access | `tests/team-access.test.ts` | Real Docker: owner creates project → creates editor+viewer users → adds members → permission matrix (viewer read-only/403s, editor read+write+stop/start, member add denied, **viewer duplicate 403**), remove rules, outsider 403, **global-editor matrix** (non-member editor reads/writes any project 200, but add-member/transfer-owner/delete stay 403), ownership transfer → deletes project + temp users |
| Providers/Agents/Chat CRUD | `tests/providers-agents-chat.test.ts` | Full CRUD + sessions + templates |
| Providers lock & backup | `tests/providers-lock.test.ts` | Lock flow E2E (needs `WSD_TEST_ACCOUNT_PASSWORD`; self-skips without it) |
| Providers page journey | `tests/providers-page-journey.test.ts` | Live-audit gaps: detection_required shape, duplicate guards, masked-key echo (POST+PUT), chat open while locked, cross-session replay via REAL logins, cooldown bans even the correct password (isolated server only; canary self-skips lock sections while the 15-min ban from a previous run is active) |
| Secret box (at-rest crypto) | `tests/crypto.test.ts` | AES-256-GCM roundtrip, fresh-IV, tamper→empty, mask-without-decrypt + API-level sealing of providers.json (file assertions when `WSD_TEST_PROVIDERS_FILE` points at the server's data dir; set `WSD_DATA_DIR` to the same dir so the test process shares the server's salt) |
| Workspace janitor | `tests/janitor.test.ts` | Orphan archiving, live-project safety, dot-dir skip, archive purge (`WSD_ARCHIVE_DAYS=0`) — offline, temp dirs only |
| Trash / archive mgmt | `tests/archive-core.test.ts` + `tests/archive-api.test.ts` | 7 offline (list/parse/traversal/`copyTree` incl. **symlink-skip**) + 20 real-Docker: list/`?fresh=1`/delete/empty, restore roundtrip + idempotency (404 on consumed), busy-port **409**, slug-collision `-1` dedup, access matrix 401/403/403/200, `../`-traversal + injection rejection |
| Storage metrics (core) | `tests/storage-core.test.ts` | Pure walk rules: nested-tree byte sums, **symlink counts its link entry — never the target's bytes nor double-counted** (assertion is Linux-correct: scans the link-only dir, so the symlink branch actually runs on CI instead of self-skipping on Windows without symlink perms), empty/missing dirs → 0, soft-deadline `truncated` stop, `cleanSlug` parity |
| Opencode Studio | `tests/opencode-studio.test.ts` | Full baked roster (27 agents / 10 skills / 8 slash commands), agent+skill+command CRUD lifecycles, kebab-name + traversal rejection, frontmatter-required command writes, **roster integrity check** (every baked file: frontmatter present, zero NUL bytes, description non-empty — regression guard after a skill once shipped as pure NULs), config merge preserves keys / rejects junk, version-info shape (against running container) |
| Security | `tests/security.test.ts` | Path traversal, upload sanitization, malformed auth headers |
| Smoke | `tests/smoke.test.ts` | Health, core endpoints, project roundtrip |
| Project notes | `tests/project-notes.test.ts` | Notes CRUD + validation (junk body 400, cap 300, truncation, kind normalization) + AI-context injection (`[Developer notes]` section ordering, done-items omitted) + 'all'-brief per-project counts |
| Project canvas | `tests/project-canvas.test.ts` | Visual-planning whiteboard: GET default-empty vs seeded roundtrip, viewer read-only/editor writes/non-member viewer 403 matrix, junk body 400 + node/edge caps + bounds normalization, node id churn on alternating writes (fresh ids each save — canvases never merge garbage from stale clients), `PUT` audits `canvas-save`, **`canvasEditedAt` appears on the project list after a save**, the `[Planning canvas]` AI-context block renders sticky notes + task cards flat text (empty canvas → absent section), and the 'all' brief appends `— board: N nodes` once a project has a board. Saving a board also mirrors a flat **`WSD_CANVAS.md`** into the project workspace (removed when the board empties) so the IDE + opencode agents can read the plan alongside `WSD_PROJECT.md`; the mirror is excluded from the file-context scan (`project-context.ts`) since it is already rendered as the `[Planning canvas]` block |
| WebSocket matrix | `tests/websocket.test.ts` | 6 endpoints × {no token→401, valid→open, invalid→401} |
| Crash alerts (detector) | `tests/project-alerts.test.ts` | 14 offline units on the import-free `alerts-core.ts` `classifyCrash` rule (like janitor-core/snapshots-schedule): **explicit stop never alarms** (requestedStop masks even OOM/non-zero), OOM-kill → `oom` fire-once, non-zero hard exit → `exited`, clean exit 0 is never a crash, running container with moved StartEpoch/RestartCount → `restart` (silent auto-restart detection), **re-fire only on a NEW start epoch** (an ongoing crash cycle never spams), watch always refreshed on clean states |
| Webhooks & notifications | `tests/webhooks.test.ts` | Real Docker + local HTTP receiver (`host.docker.internal`, since the sender runs inside the container): store CRUD + validation (name/url required, ftp + cloud-metadata URLs 400, jelly events sanitized), signing secret **masked as `hasSecret`, never echoed**, HMAC-SHA256 `X-Madar-Signature` over the raw body verified on every delivery, lifecycle `created`/`stopped`/`deleted` + manual `snapshot-saved` capture deliveries, **event filtering** (a crash-only webhook receives zero lifecycle traffic), manual Test endpoint (saved id + raw url; 400/404 on junk), access matrix (viewer/editor 403 on all five routes), unknown id 404, 51st-webhook cap 400, delete-for-good; crash *decision* coverage lives in the offline `project-alerts` suite (the wire path is shared) |
| Storage metrics (disk) | `tests/storage.test.ts` | Real-Docker `GET /api/storage`: created project appears with `workspaceBytes > 0` after a seeded file upload + a `docker.perProject` writable-layer entry, snapshot capture grows `snapshotBytes`, **cache contract** (back-to-back reads share one scan with an identical `generatedAt`; `?fresh=1` rescans), delete invalidates the cache (project vanishes from the listing), route 401 without token + viewer/editor 200 read-only shape contract. The pure walk rules are covered offline by `tests/storage-core.test.ts` (nested-tree byte sums, symlinks never pull the target's bytes, empty/missing dirs → 0, soft-deadline **`truncated`** stop, `cleanSlug` parity with `saveMeta`) |

**Test notes:**
- Tests sign their own JWT using `JWT_SECRET` from repo-root `.env` (no real password needed)
- Run serially (`--test-concurrency=1`) — parallel runs + browser polling can trip the rate limiter
- Optional real-login test activates with `WSD_TEST_USER` / `WSD_TEST_PASS` env vars
- Every suite cleans up its own data (projects, agents, providers, sessions)
- Change-password is intentionally NOT auto-tested (would mutate the real account)

### UI E2E (Playwright)
`backend/tests/e2e/limits_ui.py` — the one browser-level suite, covering the Resource-limits UI end to end against the running container: create-modal CPU/Memory inputs → create-with-limits (cap applied immediately) → edit → honest "Recreate to apply" pending banner → blanking both fields removes the limits (banner persists while the cap is live) → CPU/RAM meta-chips on Projects/Dashboard/Planner cards. It forges an admin-session JWT from the repo `JWT_SECRET` (the real account has TOTP, and the UI login route always steps the FIRST user through the authenticator — see `user-store.isTotpEnabled()`), seeds it into `localStorage['wsd.token']` before first paint, and cleans up every `e2e-*` project before/after. Exit 0 = all green, 1 = failures, 42 = skip. Host deps: `python 3.x` + `pip install playwright pyjwt requests` (+ `playwright install chromium`); server must be up. Run: `python backend/tests/e2e/limits_ui.py`

## Project Structure

```
frontend/   — Preact + TypeScript + Vite (served at /)
backend/    — Express 5 + Node 22 + WebSocket ws
Dockerfile  — Multi-stage: frontend build → backend build → runtime
Dockerfile.workspace — Ubuntu 24.04 base image for project containers
```

## Architecture Notes

### WebSocket Endpoints
| Path | Handler | Purpose |
|------|---------|---------|
| `/ws/projects/status` | `ws-projects-status.ts` | Global: broadcasts all project status changes |
| `/ws/projects/:slug/status` | `ws-project-status.ts` | Per-project: status + CPU/memory stats (3s poll) |
| `/ws/projects/:slug/logs` | `ws-project-logs.ts` | Live Docker logs tail |
| `/ws/projects/:slug/terminal` | `ws-terminal.ts` | xterm.js terminal |
| `/ws/chat/:slug/:chatId` | `ws-chat.ts` | AI chat per project |

- **Project access over the chat WS (mirrors `requireProjectAccess`)**: only project members may connect to a project's chat room (outsiders are closed with 1008 before any replay is sent) and only members with at least editor access may send `prompt`/`stop` — a viewer's write attempt gets a read-only `error` frame while the socket stays open (they keep live read). **Global editors (system role `editor`) pass as write-level on every project.** `global` chat remains open to every authenticated user; system admins always pass; legacy projects without membership data stay open
| `/ws/agent/:id/:chatId` | `ws-agent.ts` | Agent chat with tools |

### Frontend Pages
| Route | Component | Notes |
|-------|-----------|-------|
| `/login` | Login | Setup + login (unauthenticated only) |
| `/` | Dashboard | Minimal overview: stats + quick actions |
| `/projects` | Projects | Cards/table, search, filter, sort, bulk ops |
| `/project/:slug` | Project | Detail: overview, AI chat, files, logs, **Terminal** (per-project shell, the SAME `ProjectTerminal` component — tabs/project+control modes/history/zoom/reconnect/quick commands), notes, scripts, **canvas** (visual planning whiteboard) |
| `/planner` | Planner | Visual planning hub: cards for every project with canvas state + last-edit recency, filter + sort; card opens the project straight on its Canvas tab (`?tab=canvas` deep link) |
| `/terminals[/:slug]` | Terminals | Legacy global terminal hub (still routable + reachable from the Dashboard quick-action tile, but no longer in the Sidebar — per-project terminals live on each project's own **Terminal** tab driving the SAME ProjectTerminal component: project picker, tabs, project/control modes, history, zoom, reconnect, quick commands); deep-linkable via `/terminals/<slug>` |
| `/agents` | Agents | AI agents with chat, RTL/LTR, presets |
| `/providers` | Providers | LLM provider config |
| `/settings` | Settings | Change password, account info, logout |
| `/ide` | EmbeddedIDE | code-server iframe ("VS Code" branding with official mark) |
| `/opencode` | Opencode | opencode web iframe |
| `/opencode-studio` | OpencodeStudio | subagents/skills/commands/config CRUD + gated update button + bilingual User Guide tab |

### Authentication
- **Unified auth**: Single user password = providers password
- **Per-user identities**: `POST /api/auth/login` resolves the authenticated user BY USERNAME and mints a session carrying THEIR OWN `id`/`username`/`role`/`tv`/`jti` (never the first admin's — `login()` in `user-store.ts`; legacy first-admin `issueSessionToken` removed). `POST /api/auth/login/verify` signs the user who completed the challenge (`signLoginSession(pendingUserId)`). Team member logins/multi-role access depend on this: editor/viewer tokens now really are editor/viewer (403 on admin routes), not admin
- **Backend**: bcrypt (10 rounds) + JWT (24h expiry) stored in `data/users.json`
- **Frontend**: `auth.tsx` AuthProvider context, token in `localStorage` as `wsd.token`
- **HTTP**: `authMiddleware` on all routes after `/api/auth/*` (returns 401 without Bearer token)
- **WebSocket**: JWT token passed via `?token=` query param on upgrade, validated server-side
- **API helper**: `api()` auto-attaches `Authorization` header; 401 responses redirect to `/login`
- **Routes**: `/login` accessible without auth, all other routes require authenticated user
- **Global Editor role**: system `editor` is the **global editor** — `checkProjectAccess` (auth.ts) treats role `editor` like a write-level member on EVERY project without needing membership (delete/transfer-owner/member-add stay `admin`-only, and user/settings/providers management is `admin`-only), so an editor can act on any project the moment the account exists. UI surfaces this in Team ("Editor · global")

### Two-Factor Authentication (optional TOTP)
- RFC 6238 TOTP implemented from scratch in `backend/src/services/totp.ts` (HMAC-SHA1, 30s steps, 6 digits, ±1 step drift) — verified against the official Appendix B vectors in `tests/totp.test.ts`; compatible with Google Authenticator/Authy/Aegis
- **Login flow with 2FA on**: `POST /api/auth/login` verifies credentials then returns `{requires2fa:true, pendingToken}` — a 5-min JWT (`scope:'2fa-pending'`), NOT a session. The challenge is **per-user**: only an account whose OWN TOTP is enabled gets diverted; everyone else gets a direct session (an editor is never blocked because the admin enabled 2FA). `POST /api/auth/login/verify {pendingToken, code}` exchanges it for a session signed for the user who went through the challenge; guarded by a dedicated `totp` rate-limit scope (8/min/IP)
- Enrollment: `POST /api/auth/2fa/setup` → `{secret, uri}` (pending secret, disabled until proven); `POST /api/auth/2fa/enable {code}` activates only after a live code verifies; `POST /api/auth/2fa/disable {accountPassword}` requires sudo re-auth
- Frontend: Login shows an authenticator-code step when `pending2fa` is set in AuthProvider; Settings → Two-Factor panel renders the QR (`qrcode` npm pkg) + manual base32 key, activate/cancel, disable via ReAuthModal
- Audit: `2fa-enabled/-failed`, `2fa-disabled/-failed`, `login-2fa-failed`
- **Lost authenticator**: self-hosted recovery = remove `totp` from `data/users.json` and restart (documented in UI copy as admin-level escape hatch)

### Providers Security Lock (optional second layer)
- Separate bcrypt password stored in `users.json` (`providersPasswordHash`) — independent from the account password
- Managed exclusively from Settings → Providers Security via a **two-step sudo-style flow**: pick the new lock password, then confirm identity in `ReAuthModal` (shows the signed-in username, asks for the account password)
- The same `ReAuthModal` pattern authorizes every sensitive op: lock save/remove, backup export/import, logout-everywhere
- Unlock issues a scoped JWT (`scope:'providers'`, 30 min) sent as `X-Providers-Unlock`; version counter (`pv`) invalidates all unlock tokens on password change
- **Session-bound unlock**: login tokens carry a random `jti`; the unlock token embeds it as `sid` and `providersLockMiddleware` requires a match with the requesting session — a stolen unlock token replayed from another session is rejected (legacy tokens without `jti` use `''` consistently on both sides)
- **Strict instant gate (frontend)**: Providers page persists last-known lock state in `localStorage['wsd.providers.lockEnabled']` — when a lock is known-enabled and no valid local token exists, the gate renders on first paint before any network call, so provider content can never flash. Expiry is re-checked every 1s plus on `pageshow`/`visibilitychange` (bfcache/sleep-wake safe)
- **Wrong-password never logs out**: every intentional password-verification call (`unlockProviders`, providers-password set/remove, logout-all, settings export/import, 2FA disable) passes `skipAuthRedirect: true` so its 401 surfaces as an inline message instead of triggering the global session-expiry handler in `api()` (which wipes the token and redirects to `/login`)
- Unlock feedback: success shows an "Unlocked · N min" notice; the no-lock-configured case (`{unlocked:true}` without a token) explains that protection is off instead of silently accepting any word; welcome modal ("Protect your API keys") shows once per browser (`wsd.providers.onboarded` in localStorage)
- **Gate never silent**: when the gate appears it says why — `Auto-relocked after inactivity.` (idle timer breadcrumb in `sessionStorage['wsd.providers.autoRelocked']`, set by auth.tsx) or `Your unlock window ended.` (1s tick expiry detection)
- `POST /api/providers/unlock` is brute-force guarded by a **dedicated `unlock` limiter scope (15/min)** plus a progressive cooldown (5 consecutive failures per IP → 15-min window returning `429` + `Retry-After`, in-memory, reset on success); audited (`providers-unlock` / `providers-unlock-failed` / `providers-unlock-cooldown`)
- **Scoped tokens are never sessions**: `verifyToken` rejects any JWT carrying a `scope` claim, so providers-unlock and 2FA-pending tokens cannot authenticate generic routes even though they share the signing secret
- **Auto-relock**: Settings → Idle security offers an idle timer ('off'/5/15/30 min, stored as `wsd.providersAutoRelock`) that calls relock + clears the local token after inactivity; same activity-throttle + cross-tab storage-sync machinery as auto-logout
- **Unlock badge**: sidebar shows "🔓 Providers · Nm" only while unlocked (countdown from `expiresAt`); click → confirm → instant relock
- Enabling/changing the lock returns a ready-to-use unlock token — the current session stays open on the Providers page (no immediate re-entry)
- `POST /api/providers/relock` ("Lock now") bumps the version server-side — kills every outstanding unlock token across all tabs/devices; audited (`providers-relock`)
- Unlock token lives in `localStorage` (time-boxed by its expiry) so the `storage` event keeps all tabs in sync about lock state
- When enabled, management endpoints return `403 {error:'providers_locked'}` without a valid token
- Always-open endpoints: `GET /api/providers/options` (id/name/type only) and `GET /api/providers/templates`
- Chat/agent LLM usage is server-side and never blocked by the lock
- Providers page UX states: skeleton shimmer (checking) → welcome modal explaining protection (when unconfigured, dismissible per tab session) → centered login-style unlock modal (when locked)

### At-rest encryption (secret box)
- Provider API keys in `data/providers.json` are sealed with AES-256-GCM (`backend/src/services/secret-box.ts`): format `enc1:<iv>:<tag>:<ct>:<last4>`
- Key = scrypt(`WSD_ENCRYPTION_KEY` env → falls back to `JWT_SECRET`, salt persisted once in `data/crypto.salt`, mode 0600); rotating the master secret makes old blobs open to `''` (upstream auth failures — re-enter keys from the UI)
- Migration is automatic: on first load any plaintext key is sealed and the file rewritten; masking uses the stored `<last4>` so it never decrypts; duplicate detection opens values transparently
- Backup export strips keys entirely (unchanged), so ciphertext never leaves the server either
- **Lost/rotated key recovery**: delete `crypto.salt` only if starting fresh — otherwise restore the previous env value; plaintext keys pasted by users are re-sealed on next save

### Security hardening (post-audit)
- `WSD_TRUST_PROXY=1` opts into trusting one reverse-proxy hop for `req.ip`; default is OFF so directly-published ports can't spoof `X-Forwarded-For` past the rate limiters
- SSRF guard on provider detection/testing: hosts must be http(s); cloud-metadata endpoints (`169.254.x`, `metadata.google.internal`, `100.100.100.200`, link-local) are refused before any fetch — private LAN/loopback stays allowed (local Ollama is a core feature)
- Masked-key echo guard rejects both pure bullets and the displayed `<8 bullets><last4>` shape
- Provider ids are own-property checked (`__proto__` etc. → 404); `providers.json` / `users.json` / `audit.json` persist with mode 0600
- Startup banner warns when `JWT_SECRET` is missing or a known default
- CORS is **opt-in** via `WSD_CORS_ORIGINS` (comma-separated allowlist) — no env set means no ACAO headers at all; the UI is always same-origin (vite dev proxies `/api` + `/ws`), so a wildcard would only ever help attacker sites read the authenticated API
- Provider health-check cache keys hash the API key with SHA-256 — raw secrets never sit in memory-map keys
- Chat markdown href filter is a scheme **whitelist** (`http:`/`https:`/`mailto:`/`#`/`/`) after stripping control chars, so `java\tscript:` obfuscation can't reach the DOM

### UI conventions
- Icons: **lucide-preact** everywhere (`class="icon"`, spin via `.icon.spin`) — agent preset icons are stored data and stay as-is
- **Brand honesty**: sidebar uses the REAL product marks — `components/brand-icons.tsx` embeds the official opencode logo (opencode + OC Studio nav) and the official VS Code mark (nav label "VS Code", formerly "Web IDE"; EmbeddedIDE toolbar/empty-states renamed too)
- **ConfirmModal** replaces native `window.confirm()` for destructive/sensitive actions (project delete single/bulk, container restart/recreate, file delete, provider delete, agent delete, unlock-badge "Lock now") — dark modal matching ReAuthModal; danger variant shows warning avatar + red button and the title always names the exact target; in-app notices replace `alert()` (e.g. IDE-not-running yellow banner)
- App theme: **dark mode only**
- Version string: `BETA` (health, server/info, About panel, backups all aligned)

### Project notes (ideas / bugs / goals)
- Per-project structured notes stored in `data/projects/<slug>/notes.json` (`services/project-notes.ts`): items `{id, text, kind: 'idea'|'bug'|'goal', done, createdAt}` — ≤300 items, text ≤2000 chars, junk rows dropped silently on normalize, unknown kinds default to `idea`
- API: `GET/PUT /api/projects/:slug/notes` (full-document PUT; 400 without `items` array or over cap) — covered by `tests/project-notes.test.ts`
- Project page tab "Notes" (NotesPanel) sits where the per-project terminal used to live (the terminal is restored as its own tab again): quick composer with kind selector (Ctrl+Enter), filter chips with live counts, done toggle (completed hidden by default + "Show completed"), delete
- **Smart context**: `formatNotesForContext()` renders open bugs → active goals → ideas into the AI context block (section `[Developer notes]`, priority right after WSD_PROJECT.md goals, ~2500 char cap, done items summarized as a count); `noteCounts()` appends `— notes: N open bug(s), M active goal(s)` to every project line in the 'all' brief; the context cache key includes a notes mtime:size signature so edits invalidate immediately
- ws-chat and ws-agent inherit everything automatically via `getProjectContext` — no per-surface wiring

### Published ports editing
- `PUT /api/projects/:slug/ports` (editor+, audited `project-ports`) takes `{ports: number[]}` (≤50) and writes the validated+deduped set into `meta.json` **immediately** — Docker cannot rebind a running/stopped container, so the change applies only on the next explicit "Recreate container" (`POST …/recreate`). Response `{ports, needsRecreate}` where `needsRecreate` compares the sorted live spec against the requested set (false ⇒ already consistent, nothing to do)
- Conflict rule (`services/docker-manager.ts` → `currentUsedPorts()`): a port is claimed if any OTHER project declares it in meta OR physically binds it — including **stale live bindings** of edited-but-not-recreated siblings and **stopped containers' baked `HostConfig.PortBindings`** (the cheap `docker listContainers` call only reports running bindings, so stopped containers are inspected individually). Own meta ports + own bindings are self-excluded. Collisions → `409 {error:'Ports already in use: N', taken:[N]}` (meta unchanged)
- Reserved always: dashboard `PORT`/3000, `WSD_IDE_PORT`/8100, `WSD_OPENCODE_PORT`/4096; privileged 1-1023 rejected; dedupe collapses repeats; blank set unpublishes all
- `createProject` saveMeta **merges prior meta** (`…prev`), so "Recreate container" preserves members/ownerId/snapshot config — a recreate must never degrade a project into the legacy no-meta state that opens blanket editor access
- UX: Project page config panel "Published ports" input (Save ports; Enter-guard + focus-clobber guard so the 5s poll can't wipe typing) and snapshot manifest serializes the *edited meta* (the liability, not the stale binding)

### Resource limits (CPU / memory)
- `PUT /api/projects/:slug/limits` (editor+, audited `project-limits`) takes `{cpu?, memory?}` and persists a validated set into `meta.json` **immediately**; cgroup caps can't rebind a running/stopped container, so it applies only on the next explicit "Recreate container". Response `{limits, needsRecreate}` — honest `false` after a recreate (re-persist reads clean), so no endless-recreate loop
- Canonical forms: cpu `"2"` (whole) / `"500m"` (milli); memory binary `"128Mi"`/`"1Gi"`. Tolerated non-canonical input is **normalized to the exact string the live inspector reports** at write time (`2000m`→`2`, `1G`→`954Mi`, plain bytes → whole MiB) so meta ↔ `HostConfig` ↔ live always round-trip — `needsRecreate` can never falsely stick
- Partial-update contract: only keys present in the body change (`'cpu' in raw` semantics — a memory-only PUT preserves cpu); `null`/blank removes a limit; removing both clears the set entirely (`isEmptyLimits` → `meta.limits` `undefined`)
- HostConfig: `Memory` (bytes), `NanoCpus`, and `MemorySwap` **pinned to the memory total** when a limit is set — `MemorySwap` is the memory+swap total, so equality disables swap (the container is OOM-killed at the cap, never `-1` which Docker treats as *unlimited* swap). Live limits are re-derived from `HostConfig`, ignoring `0`/absent (unlimited)
- Precedence in `createProject`: request body `limits` > previous meta > env defaults (`WSD_DEFAULT_CPU` / `WSD_DEFAULT_MEMORY`, fresh projects only). Every path is re-validated against the **current** host before reaching Docker: a misconfigured env default or a stored set that no longer fits a shrunk host degrades to unlimited with a server-side warn — never a 500 on every create
- Ceilings: memory ≤ 90% of host RAM and ≥ 32 MiB; cpu ≤ 4× host cpus and ≥ 0.1. Client-facing 400 text is deliberately generic ("exceeds host capacity") — exact host numbers are logged server-side only, so any authed user can't probe host CPU/RAM via error text
- Duplicate inherits the source limits into a brand-new container at creation; **snapshot manifests deliberately exclude limits** (restore on a fresh machine starts unconstrained, matching machine-port reuse philosophy)
- UX: Project page "Resource limits" panel (CPU/memory inputs, pending-recreate banner via `limitsPending`, `fmtCpu`/`fmtMem` in `frontend/src/lib/limits.ts`), limit chips (`CPU 2` / `RAM 128Mi`) on Projects cards+table, Dashboard cards and Planner cards; Settings maps the audit label; exact host ceilings testable offline via `getHostInfo`

### Static site serving
- Project containers idle on `sleep infinity`, so static workspace files were never reachable over HTTP and Preview died with `ERR_EMPTY_RESPONSE`. The persisted per-project toggle `meta.serve = {enabled, port, pid}` runs `python3 -m http.server <port> -d /workspace` inside the project container (workspace bind-mounted at /workspace) so static sites are actually served
- API: `GET /api/projects/:slug/serve` (viewer+, live state), `POST /api/projects/:slug/serve` (editor+, body `{port?}`, strict rate-limited, audited `serve-start`/`serve-start-failed`) and `POST /api/projects/:slug/serve/stop` (editor+, audited `serve-stop`). Start persists `enabled:true` only AFTER a live host-side probe confirms the server is really answering; stop keeps the port for UX memory and flips `enabled:false`
- **Security posture** (`services/serve-core.ts` pure rules + `services/project-serve.ts` dockerode wiring): the port must be an integer ∈ the project's OWN published ports (`sanitizeServeConfig` — no-port falls back to prev.port if still published else the first published; junk/non-published 400, empty published set 400). Execution is an **argv-array dockerode exec** (`buildServeCmd`) — no shell interpolation of the port. Kill is pid-guarded: `ps -p <pid> -o args=` must still show OUR `http.server <port>` command before `kill -TERM`, with a literal `pkill -f 'python3 -m http.server <port> -d /workspace'` fallback (the port is a validated integer, so the pattern can't be shell-injected) — a stale/reused PID is never killed blind
- **Idempotency + staleness**: a double-POST early-returns when the toggle is already on AND the live probe says serving (no redundant process that would die on EADDRINUSE, no dead PID persisted). `ensureServeRunning` re-derives the serve port against the **CURRENT published set** on every auto re-run — a port later removed from published ports is never served on again
- **Auto re-run**: `docker-manager` calls `ensureServeRunning` after every container **create/start/recreate** (recreate routes through createProject's prev-meta merge, so `meta.serve` survives). **Catch-never-throw**: a failed serve is persisted as `serve.error` and logged, never propagated to break the lifecycle op
- **Honest state**: the project LIST carries config-only `serve` (`active:false` — a live probe per project would be N+1 on every list call); single-project detail + the `/serve` endpoint do a live host-side HTTP probe (`http://host.docker.internal:<port>/`, 3s timeout) → `{enabled, port, hostPort, url, active, error}` — `hostPort`/`url` only when the configured port maps 1:1 to a published host port
- UX: Project page "Static site" panel (port select from the published set, green/red/grey status dot, URL anchor + Copy built from `window.location.hostname` — NOT the backend's localhost url — toggle button, viewer read-only passive "Serving on :port" line, disabled while the container is stopped); green "Served" badge on the matching Previews row; `site :<port>` meta-chip on Projects cards/table + Dashboard cards; card previews open the serve URL first when running

### Container crash alerts
- Every status path used to collapse non-running containers to 'stopped' — an app that aborted (OOM-kill by the memory cap, non-zero exit, or a *silent auto-restart* under `RestartPolicy:unless-stopped`) looked identical to a deliberate stop. **`services/project-alerts.ts`** fixes this with a WS-independent background sweep (boot `startAlertsAutomation()`, every `WSD_ALERT_SWEEP_MS` default 10s/min 5s) that inspects every live project container and persists an optional `crash` object on `ProjectInfo`/list payloads — deliberately OUT of the status union (`{at, reason:'exited'|'oom'|'restart', exitCode?, restarted?, startedAt?}`)
- **`services/alerts-core.ts`** holds the pure import-free `classifyCrash()` rule (like janitor-core/snapshots-schedule): an explicit UI stop (`meta.requestedStop`, marked **before** `container.stop()` in `docker-manager` so a racing sweep can't misfire) never alarms even on OOM/non-zero; `oomKilled` → `oom` fire-once; stopped + non-zero exit → `exited`; exit 0 is never a crash; a running container whose StartEpoch/RestartCount moved while we did no stop/start/recreate → `restart` (silent auto-restart detection, RestartCount read from the inspect TOP level — dockerode's `State` type omits it); **re-fires only on a NEW start epoch** so one ongoing crash cycle never spams
- Persist: `meta.crash` (surfaced as a red `crashed` chip on cards/table/Planner/Dashboard red stat-card + a Project-page banner with a reason-specific hint; `setCrashState` also appends a `crashed` activity), audit `container-crash`, and a `crash` webhook dispatch. Explicit **start/recreate/create** call `resetCrashState()` (clears flag + re-seeds `crashWatch`); the project list re-derives `crash` from meta, so the chip clears on the next poll
- The sweep singleflights (overlapping passes skip, never queue), per-project isolate errors, and is entirely independent of WebSocket listeners — a crash is caught with zero browsers open

### Webhooks & notifications
- Admin-only (`requireAdmin`) CRUD on `data/webhooks.json` (0600): `GET/POST /api/webhooks` (201), `PUT/DELETE /api/webhooks/:id`, `POST /api/webhooks/test` (saved id **or** raw url, strict rate-limited, `{ok,status,error}`). Max 50 webhooks, name/url required, URL SSRF-guarded through the same `assertFetchableHost` as providers (`ftp:`/cloud-metadata rejected, localhost+host.docker.internal fine). `events` whitelist = `crash | created | started | stopped | recreated | deleted | snapshot-saved`; junk entries dropped, fully-junk falls back to `['crash']`
- **Signing secret**: optional ≤256-char HMAC-SHA256 secret stored plaintext 0600 alongside URLs; every API response masks it (`hasSecret`, never echoed, pure-bullet guard not needed since it's never echoed), and settings backups strip it entirely (restore merges by id, existing wins, secrets never importable). When set, delivery carries `X-Madar-Signature: sha256=<hex>` + `X-Madar-Timestamp` over the **raw body**
- **Delivery** (`services/webhook-sender.ts`): 5s `AbortSignal.timeout`, fire-and-forget per webhook (`dispatchWebhook(event, payload)` is non-blocking — a dead endpoint can never stall a sweep or a lifecycle write), no retries, audited `webhook-send`/`webhook-send-failed`. **Event filtering**: only webhooks with `enabled && events.includes(event)` receive traffic
- **Hooks wired in**: `docker-manager` fires `created`/`started`/`stopped`/`deleted`/`recreated`; `project-alerts` fires `crash`; `project-snapshots-auto` fires `snapshot-saved` (capture-now/scheduled). UX: Settings → Notifications & Webhooks panel (add row, per-webhook name/url/event checkboxes/enabled toggle, "Test" with live receiver feedback, new-secret or remove-secret input, danger-confirm delete)

### Disk usage / storage metrics
- `GET /api/storage` (read-only, authenticated): returns per-project workspace size, snapshot-archive size, data-directory footprint, and Docker-level aggregates. Uses on-demand compute with a short TTL in-memory cache (~45s) + singleflight guard to prevent redundant filesystem/Docker scans; `?fresh=1` bypasses cache. Invalidation occurs on project create/duplicate/import/delete/restore.
- **Scanning logic** (`services/storage-core.ts`): import-free recursive walk of workspace and snapshot directories; employs a soft deadline per walk to report `truncated: true` if scans exceed budget, preventing endpoint hangs on massive trees. Symlinks are counted by link entry size, never their targets.
- **Docker metrics** (`services/storage-docker.ts`): per-container writable-layer bytes (`SizeRw`) and rootfs size (`SizeRootFs`) fetched via `listContainers({size:true})`; system-wide totals (Images, Containers, Volumes, BuildCache) retrieved via the `/system/df` endpoint.
- **UX**: Dashboard features a storage strip with totals and the top-3 largest workspaces; Settings → Storage panel provides a detailed per-project table with a manual Refresh button.- Frontend binary formatting (KiB/MiB/GiB/TiB) lives in `lib/size.ts`.


### Settings Backup (export/import)
- `POST /api/settings/export` (JSON body with `accountPassword`) → JSON backup; **provider API keys are stripped by design**
- `POST /api/settings/import` merges by id — existing items always win, secrets are never imported
- Both operations require account-password re-auth

### Project snapshots (export / restore)
- `services/project-snapshots.ts` — hand-rolled POSIX-ustar tar writer (no `tar`/`archiver` dep, streaming via `Readable.from(async generator)` → `zlib.createGzip`) + hardened parser (ustar magic, `../`-traversal rejection, `<root>`-escape proof, cap 200k entries, 1 GiB gunzip bomb guard)
- `GET /api/projects/:slug/export` (editor+ on that project) streams `madar-<slug>-<stamp>.tar.gz` = `manifest.json` (format `madar:1` + name/description/image/ports/env) + `notes.json` + `canvas.json` (only when the board is non-empty; never blank-annotifies a restore) + `workspace/**`; audited `snapshot-export`
- **Heavy regenerable dirs excluded** (`EXCLUDE_DIRS`: `.git`, `node_modules`, `__pycache__`, `.venv`, `.next`, `dist`, `build`, `target`, `vendor`, …) — a snapshot is source + notes + config, keep it lean
- `POST /api/projects/import` (editor+, multer single `file`, ≤200 MB) restores into a **brand-new** project — never overwrites: unique slug (`base-1 …`), manifest ports reused when free else fresh (seeks from 8000), owner = restorer; audited `snapshot-import`; temp upload + staging dir always cleaned
- UI: Project page header "Export" (blob download), Projects toolbar "Restore" (file picker → navigates to the new project); frontend helpers `exportProjectSnapshot`/`importProjectSnapshot` in `api.ts`

### Snapshot automation (scheduled server-side backups)
- Per-project schedule stored in `meta.json` (`snapshot: {enabled, intervalMin, keep}` + `lastSnapshotAt`); archives live at `WSD_DATA_DIR/projects/<slug>/snapshots/madar-<slug>-<stamp>.tar.gz` (same streamed format as browser export) and die with the project (`deleteMeta` removes them too)
- **Scheduler** (`services/project-snapshots-auto.ts`): a `runSnapshotSweep` pass every `WSD_SNAPSHOT_SWEEP_MS` (default 5 min, min 10s) captures every enabled project whose gap since `lastSnapshotAt` ≥ `intervalMin` (allowed: 1h·3h·6h·12h·24h·7d), kept to `keep` newest (≤20); re-entrancy guard, per-project error isolation, deferred 5s sweep when a schedule flips on (and at boot) so the first copy lands promptly
- **Pure rules in `snapshots-schedule.ts`** (import-free, like janitor-core): `computeDueSnapshots` + `sanitizeSchedule` (invalid `intervalMin`/`keep` fall back to previous config, not the junk input)
- API: `GET /projects/:slug/snapshots` (viewer+ list), `GET/PUT …/snapshots/config` (viewer+ read / editor+ write), `POST …/snapshots` (capture-now), `GET …/snapshots/:file` (download), `DELETE …/snapshots/:file`, `POST …/snapshots/:file/restore` → new project; `:file` gated by a strict `madar-<slug>-<17-digit-stamp>.tar.gz` regex (traversal-proof); audited `snapshot-save`/`-download`/`-delete`/`-restore`/`-config-change`
- UI: Project → Snapshots tab (SnapshotsPanel): schedule toggle + frequency/keep selects, "Capture now", stored versions with download / restore-as-new-project (ConfirmModal) / delete (danger ConfirmModal)

### Workspace janitor & IDE/opencode hygiene
- Deleting a project now removes EVERYTHING: container + meta store **and its workspace files from disk** (`removeProject`); opencode sessions for that directory are deleted best-effort (`unregisterOpencodeProject`)
- `services/workspace-janitor.ts` sweeps `/workspaces` at boot (+ every `WSD_JANITOR_INTERVAL_MS`, default 15min, plus an event-driven sweep right after every project create/delete): dirs without a live meta store are MOVED to `/workspaces/.archive/<ts>-<slug>` and purged permanently after `WSD_ARCHIVE_DAYS` (default 7). Pure logic in `janitor-core.ts` (import-free so node --test can load it)
- code-server is rooted at `/workspaces` — archived dot-dir keeps it ghost-free; `entrypoint.sh` registers ONLY live-project dirs into opencode and purges stale rows from its SQLite store (`project`/`project_directory`) BEFORE launching it; `removeProject` and janitor archiving call `purgeOpencodeProjectRows` (`services/opencode-store.ts` → `docker/opencode-purge.py`) so deleted projects vanish from opencode immediately, no restart needed (covered by `tests/opencode-purge.test.ts`, self-skips without host python3). The purge script introspects the SQLite schema (`PRAGMA table_info`) and skips safely with a stderr note when columns don't match expectations — future-proof against opencode major upgrades
- Creating a project whose slug collides with an orphaned non-empty dir returns 409 (janitor archives it within minutes)
- EmbeddedIDE no longer shows the cosmetic code-server password (server runs `--auth none`); Opencode page has a live-project picker (`POST /api/opencode/open` ensures a session exists)

### Trash Bin (archived-workspace management)
- Projects page gains a **Trash** tab (`/projects?tab=trash`, count badge in the tab row) that surfaces the janitor's `.archive` — previously black-box + invisible to the UI, emptied only by the 7-day purge. CRUD over `/api/archive` is cache-coherent with the janitor so recovered-deleted workspaces are actually actionable, not just listed
- API: `GET /api/archive` (any authed role, `?fresh=1` bypasses a 15s TTL cache + singleflight scan — a fresh request resets `inflight` so it never inherits a stale in-flight list), `DELETE /api/archive/:entry` + `POST /api/archive/empty` (editor+, strict rate-limited, audited `archive-delete`/`archive-empty`), `POST /api/archive/:entry/restore {name?, ports?}` (editor+, `userWriteLimiter`, audited `archive-restore`) → **201 `{project}`**
- Pure fs rules in `services/archive-core.ts` (import-free like janitor-core): `safeName`/`parseArchiveName` (base36 `<timestamp>-<slug>`), `listArchiveEntries`, traversal-proof `archiveEntryPath`, and `copyTree` — which skips **symlinks** (`lstatSync`, never follows a link out of `.archive`; a malicious archive can't leak `/etc/shadow` on restore). Orchestration in `services/archive-manager.ts`
- **Restore = "as-new" project**: metadata (name/ports/description/members/notes) is NOT preserved — the archive holds only files — so restore provisions a fresh container/workspace and COPIES the files in. **Deliberately consume-after: no move-then-create** — the source stays alive in `.archive` for the whole op and is removed only after `createProject` persists a fresh meta store, killing the orphan race where a sweep re-archives a half-live `/workspaces/<slug>`. The restoring user becomes owner (`setOwner`)
- **Port pre-validation**: restore-requested ports are checked against `currentUsedPorts()` BEFORE container creation → a busy port is a clean **409 `Ports already in use: N`**, never an opaque Docker EADDRINUSE 500; junk/non-array `ports` passes through to `validatePortSet` for a canonical 400
- **Slug-dedup** (`workspaceDirBusy`): a derived slug backs off `-1`, `-2`, ... when taken by a live project OR a leftover orphan dir (which would otherwise make `createProject` 409), matching `duplicateProject`'s suffix loop
- UI: `TrashPanel.tsx` — stats line + Empty Trash (danger ConfirmModal), per-row Restore (inline modal: name + optional ports → restores + navigates to the new project) and per-row Delete (danger ConfirmModal), viewer read-only, `onTrashCountChange` keeps the tab badge in sync. Helpers in `api.ts` (`listArchive`/`restoreArchive`/`deleteArchive`/`emptyTrash`)
- Coverage: `tests/archive-core.test.ts` (7 offline — incl. symlink-skip) + `tests/archive-api.test.ts` (20 real-Docker: list/fresh/delete/empty, restore roundtrip + idempotency, busy-port 409, slug-collision dedup, access matrix 401/403/403/200, traversal/injection)

### Opencode Power Pack (Studio, presets, gated updates)
- **Pinned baseline**: Dockerfile installs `opencode-ai@1.18.22`; repo-root `opencode.json` (copied to `/root/.config/opencode/`) carries `$schema`, provider config and `subagent_depth: 2`
- **Baked roster (v3 — full SDLC coverage, English prompts, trigger-engineered descriptions)**: 27 subagents in `opencode/agents/*.md` — planning/design: architect · ux-designer; implementation: frontend-developer · backend-developer · db-expert · websocket-engineer · data-engineer; quality: code-reviewer · test-writer · refactorer · debugger · perf-optimizer · accessibility-auditor (read-only); security: security-auditor (read-only) + pentester (active, bash-only with hard limits); ops/reliability: devops-engineer · release-manager · incident-responder (bash-only, edit-denied) · log-analyst · observability-engineer; APIs/docs: api-designer · doc-writer; platform: wsd-expert; languages: python-expert · golang-expert · rust-expert; LLM advisory: prompt-engineer. Reviewers are `edit: deny`+`bash: deny`, implementers `allow/allow`, pentester/incident-responder bash-only. Every file follows the authoring template: `Use when…`/`Use PROACTIVELY when…` in description (MISSING_TRIGGER-style), `## When invoked`, one Input→Output few-shot example, `## Handoffs` cross-references (security-auditor→pentester, architect→implementers, reviewer→debugger…), closing principle line
- **10 skills** in `opencode/skills/<name>/SKILL.md`: clean-code, docker-debug, git-release, wsd-workflow (house rules) + planning-methodology, debugging-methodology, testing-strategy, security-hardening, api-design-guidelines, performance-profiling
- **8 slash commands** in `opencode/command/*.md` (`$ARGUMENTS` templates bound to agents): review→code-reviewer, audit-security→security-auditor, plan-feature→architect, tdd→test-writer, fix-issue→debugger, refactor-safely→refactorer, explain-code→doc-writer, release→release-manager. Planning agents (architect + plan-feature) are instructed to consult `WSD_PROJECT.md` and the `WSD_CANVAS.md` board mirror first, so Madar planning boards drive agent-produced plans
- CRLF stripped at build for ALL of the above so Windows checkouts don't poison frontmatter
- **Unified adapter** (`services/opencode-api.ts`): all opencode session CRUD goes through one facade; `SUPPORTED_MAJORS=[1]` is the capability gate — version probe (`opencode --version`, cached) feeds it, and future v2 enablement means adding V2 impls + flipping the array, NOT touching call sites
- **Opencode Studio page** (`/opencode-studio`): tabs Subagents | Skills | Commands | Config | Guide; full CRUD on `/root/.config/opencode/{agents,skills,command}` via `/api/opencode-studio/*` (kebab-case names enforced, traversal-proof `safeJoin`, CRLF-normalized writes, frontmatter parsed for list descriptions/mode/@agent badges); command saves REQUIRE frontmatter markers (400 without); Config tab edits are MERGED into `opencode.json` with `$schema` protected and unknown keys preserved; deletes audited
- **Studio UX helpers**: list filter box (name+description, client-side), copy-description button per row (paste into chat to summon a specialist by name, check-mark feedback), and a live trigger-lint warning above the editor when a description lacks a `Use when…` phrase (non-blocking — MISSING_TRIGGER standard)
- **User Guide tab**: bilingual AR/EN (`studio-guide.tsx`, toggle persisted in `localStorage['wsd.studio.guideLang']`, RTL for Arabic) teaching how to drive subagents/skills/commands: mental model, auto vs explicit delegation, slash-command table with bound agents, permissions matrix (why reviewers are read-only), workflow recipes (feature/bug/security/incident), effective-prompting rules; the two roster tables pull LIVE agent/skill lists from the existing APIs so the guide never goes stale after Studio edits
- **Update button (Desktop-style)**: `GET /api/opencode-studio/version` → `{current, latest, upToDate, channelUnlocked, supportedMajors}`; `POST /update` single-flights an `npm i -g opencode-ai@<latest>` then SIGTERMs the supervised web process — entrypoint's while-loop revives the new binary in ~2s (child PID published in `data/opencode-web.pid`). **Gotcha fixed**: inherited `set -e` made a bare `wait` fatal on rc=143, silently killing the supervisor exactly when an update killed opencode — status captured via `wait ... || RC=$?`
- **Major-gate UX**: if npm latest is a major outside `SUPPORTED_MAJORS`, the button locks to "{version} needs a Madar update" instead of bricking the install
- **E2E-verified behavior (live runs, 2026-08)**: task-tool delegation enforces subagent permissions structurally — security-auditor spawned with NO write-capable tools (read/grep/glob only) and refused edits by policy; primary correctly picked code-reviewer for post-change security review (trigger descriptions working); on a provider outage mid-subagent, the primary degraded gracefully and self-completed the review citing the security-hardening skill; scrypt+salt+timingSafeEqual implementation shipped with 11/11 passing tests. Known opencode quirk (upstream, harmless here): running an agent DIRECTLY via `opencode run --agent <name>` bypasses its frontmatter permission deny — permissions only bind on task-tool delegation, which is how real sessions use subagents

### Security activity log (audit)
- `data/audit.json` — append-only, capped at the last 100 entries
- Records: setup, login/login-failed, logout-all(+failed), password-change(+failed), providers-lock-change(+failed), providers-unlock/unlock-failed, providers-relock, backup export/import — with timestamp + IP
- `GET /api/auth/audit` → last 50 entries, newest first (auth-protected, supports `limit`/`offset` params)
- Shown in Settings → Security Activity; auditing failures never break request flow

### Brute-force guard
- Dedicated `auth` rate-limit scope: **10 password verifications/min per IP** on login, setup, logout-all, providers-password set/remove, settings export/import
- Separate from the global 240/min budget — login attempts never starve normal API usage
- Exceeding returns `429` with `Retry-After`; verified via isolated-server hammer test
- Ceilings are env-tunable (`WSD_RATE_MAX`, `WSD_RATE_STRICT_MAX`, `WSD_RATE_AGENT_WRITE_MAX`, `WSD_RATE_USER_ADMIN_MAX`); under `WSD_TESTING=1` (the compose default for the suite container) the global/strict/agent-write budgets + the **admin user-provisioning scope** (own `user-admin` limiter, admin-gated so not a brute-force surface — 20/min prod → relaxed under testing) relax so multi-suite teardown never trips them — the auth/unlock/totp brute-force scopes stay at their **real** values (those are what the security suites actually assert). Production: `WSD_TESTING=0`
- Full suite is green end-to-end (`node --test --test-concurrency=1 "tests/**/*.test.ts"` → 304 pass / 0 fail / 81 self-skip on missing creds)

### Session revocation (logout everywhere)
- Every login token carries a `tv` claim matching `users.json → tokenVersion`; `verifyToken` rejects stale versions
- `POST /api/auth/logout-all` (account-password re-auth) bumps the version → all sessions die
- `changePassword` also bumps the version but returns a fresh token so the current session survives
- Legacy tokens without a `tv` claim are treated as version 0

### Beta
- App version: `BETA` — badge shown in sidebar footer, login page and Settings → About

### Auto-logout (idle timeout)
- Configurable in Settings: off / 30 min / 60 min / 120 min (stored in `localStorage` as `wsd.idleTimeout`)
- Activity events (mousemove, keydown, click, touchstart, scroll) throttle-refresh the clock (5s cooldown)
- Cross-tab sync via `storage` event — changing the setting in one tab applies immediately in all tabs
- On expiry: clears token, removes user, redirects to `/login`

### Provider types & Azure OpenAI
- Types: `ollama | openai | anthropic | gemini | azure`; OpenAI-compatible providers can switch auth header via `auth: 'bearer' | 'api-key'`
- Azure (`type:'azure'`): `api-key` header enforced; requests go to `{host}/openai/deployments/{deployment}/chat/completions?api-version=…`; the model field carries the **deployment name** and the model dropdown lists deployments (`GET /openai/deployments`)
- Auto-detect recognizes `*.openai.azure.com` hosts and tries the deployment API first (Azure keys have no distinctive prefix)
- API version default `2024-10-21`, override with `WSD_AZURE_API_VERSION`
- Verification distinguishes auth/quota/rate-limit failures; health checks are cached server-side for 60s

### Key Patterns
- **WebSocket with HTTP fallback**: Project status/logs hooks try WS first, fall back to 5s polling; Agents chat uses exponential-backoff reconnect only (2s→16s)
- **Room-based connection limits**: Max 8 connections per WS room
- **ReAuthModal sudo pattern**: All sensitive ops (lock, backup, logout-everywhere, password change) require account-password re-auth via a unified modal

## Working Rules (قواعد العمل)

The mandatory work contract for every feature, fix, or refactor — the four-phase loop below (يمثل العقد الإلزامي) governs every round, and the sections after it are binding rules that are never skipped.

### Per-Feature Four-Phase Loop
Every new feature or modification runs these four phases, in order, end-to-end:

1. **التخطيط (Planning)** — `@planner` subagent first: open with the mandatory expert question **"ما المشكلة التي تحلّها هذه الميزة؟"** (what real problem does this solve — who is affected, when does it bite, what breaks today without it), then vertical goal, design approach with rejected alternatives, file-level task breakdown, edge cases/risks. No code before the problem is crisply defined.
2. **التنفيذ (Execution)** — implement the approved plan; edits stay in ONE area per round.
3. **التحقق (Verification)** — `@explore` subagent verifies the change against its intent; whenever a problem surfaces, `@debugger` diagnoses and fixes it (root-cause, then fix, then re-verify).
4. **المراجعة والاختبار (Review & Testing)** — `@reviewer` (code quality), `@tester` (coverage/regressions), `@security` (auth/crypto/input/secret audit) review the round; run tsc + vite build + Docker rebuild + the affected suites, then commit + push.

### Working Discipline
- **Area-by-Area (بالقطع)**: work on one feature/page/area at a time; do not jump between unrelated areas.
- **Context & Vertical Goal**: before ANY code change, understand the full context and the vertical goal — never work blindly or make random changes.
- **Think like a senior engineer**: plan thoroughly before touching code, consider edge cases / race conditions / security, test every change, never break existing functionality.
- Respond to the user in **Arabic (عربي)** unless they switch; code, logs and identifiers stay English.
- Do not add code comments unless the user asks; mirror the surrounding conventions and libraries.
- Keep every change minimal and reviewable — one area per round.

### Verification Pipeline (after EVERY code change — mandatory)
1. Type-check: `cd frontend && node node_modules\typescript\bin\tsc --noEmit` (plus `cd backend && node node_modules\typescript\bin\tsc --noEmit` when backend is touched)
2. Production build: `cd frontend && node node_modules\vite\bin\vite.js build`
3. Rebuild + restart the container — **no exceptions**: `docker compose build app && docker compose up -d app`
4. Poll `http://localhost:3000/api/health` until it returns `{"status":"ok"}`
5. Verify behavior against the RUNNING container: API requests for backend changes, the browser (chrome-devtools) for UI changes — a green build alone is never proof.

### Git Workflow
Every completed task ends with a commit pushed to GitHub; no uncommitted changes are left behind after finishing.

1. Inspect first: `git status --short`, then `git diff` — review exactly what changed.
2. Stage **only the intended files** — **never `git add -A`** (a stray temp file or tool artifact can slip junk or a secret into a commit). Re-run `git status` after staging to confirm the list before committing.
3. Never commit secrets/keys (`.env`, `data/*`, tokens, cookies).
4. Commit message style: lowercase area prefix + concise description, e.g. `terminal: restore per-project Terminal tab, drop sidebar Terminals buttons`.
5. Push immediately after the commit: `git push`.

### Testing note
Run the affected suites after a change: `cd backend && node --test --test-concurrency=1 "tests/**/*.test.ts"` (always serial — parallel runs + browser polling can trip the rate limiter). **The dev container runs `WSD_TESTING=0`** (production rate-limiter budgets), so the full suite 429s on project creation there — only the offline suites (`*-core.test.ts`, `serve-core`, `snapshots-schedule`, `alerts-core`, …) run reliably against it. The complete suite needs the suite container with `WSD_TESTING=1`.

## Development Phases & Goals (مراحل التطوير والأهداف)

The application progresses through three distinct phases, in order. All three are the current goals of the project — each builds on the one before:

### Phase 1 — New Features (الميزات الجديدة) — **الحالية (current)**
Adding new capabilities and functionality to the application.
Every new feature must be built, tested, and committed.

### Phase 2 — Improvements (التحسينات — الهدف التالي)
Enhancing and refining existing features — UX, performance, reliability of what already exists.
Every improvement must be verified to not break existing behavior.

### Phase 3 — Full Testing & Production Readiness (الاختبار الشامل والجاهزية الإنتاجية)
End-to-end testing based on real-world scenarios.
Act as a real user configuring the application for deployment.
The goal: a fully working production machine ready for daily use.

## Feature Roadmap (خريطة الميزات المطلوبة)

الأهداف المقبلة بعد اكتمال الميزات الحالية، مرتبة حسب الأولوية — كلها تخدم الهدف الرأسي:

### فريق العمل والتعاون (Team & Collaboration)
- **الدردشة الجماعية للعمل (Team Chat)** — *هدف معلن (2026-09)*: تطبيق تواصل فوري داخل المنصة (صفحة مستقلة `/chat`) بأسلوب WhatsApp لكن مصمم للعمل — الدردشات الفردية والجماعية/القنوات بين أعضاء الفريق، **قناة تلقائية لكل مشروع** تربط النقاش بالقرارات والملفات واللوحة، تمرير فوري عبر WebSocket، مشاركة ملفات مع معاينة، وسم @ وردود وإعادة توجيه ورسائل مثبتة وبحث، مؤشر الحضور والكتابة، إشعارات داخلية، صلاحيات حسب الأدوار + أرشفة وسجل تدقيق، واجهة RTL/EN. **الاحتياجات التفصيلية يحددها المستخدم** قبل التخطيط والتنفيذ.
- **حساب المستخدم (User Account)** — *الميزة الأولى المطلوبة*: صفحة بروفايل لكل مستخدم للتعديل: الاسم/الاسم المعروض/البريد + **إضافة صورة للمستخدم (avatar)** + إعدادات شخصية، وربطها في واجهة الحضور/الفريق (Team/Presence)
- تحسين إدارة الفريق: عرض أوضح للأعضاء والأدوار، تدفّق أفضل لنقل الملكية
- نشاط لكل مشروع: من قام بماذا ومتى، مع رؤية مبسطة
- مراجعات/تعليقات على الملفات والكود داخل المنصة

### تعميق الذكاء الاصطناعي (AI Depth)
- تكامل أعمق مع opencode والوكلاء/المهارات/الأوامر (الاستوديو الموسّع)
- تلقائية ذكية: ملخصات مشروع دورية، اقتراحات تخطيط من اللوحة والملاحظات
- مساعدة جودة الكود: مراجعة تلقائية قبل commit

### الموثوقية والعمليات (Reliability & Ops)
- مراقبة موارد متقدمة (CPU/RAM/قرص لكل مشروع) + تنبيهات
- أتمتة النسخ الاحتياطي مع تحقّق دوري من الاستعادة
- استقرار الحاويات والطرفيات: معالجة الجلسات اليتيمة والارتباطات العالقة

### جاهزية الإنتاج والاختبار (Production & Testing Readiness)
- توسيع تغطية الاختبارات (وحدات + E2E + مصفوفة وصول)
- اختبارات ضغط/أداء على الحاويات
- إصلاح الأخطاء المعروفة + توثيق شامل للمستخدم (AR/EN)

## Current Phase

**Phase 1: New Features (الميزات الجديدة)** — التطوير النشط قائم الآن؛ الهدف التالي المعلن هو **حساب المستخدم والبروفايل** (صورة مستخدم + تعديل بيانات + إعدادات شخصية)، يليه تحسينات Phase 2 ثم اختبار Phase 3.
