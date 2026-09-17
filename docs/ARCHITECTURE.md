# Madar — Architecture

> Technical architecture of **Madar (مدار)** — a self-hosted, all-in-one workspace platform for development teams. Version: **BETA**.

---

## 1. System Overview

Madar is a single Docker Compose stack: one `app` container serves the whole product (Preact dashboard, Express API, WebSocket services, Docker orchestration), and a separate base image (`wsd/workspace`, Ubuntu 24.04) is used to generate one container per project.

```
┌────────────────────────────────────────────────────────────────────┐
│                        host (Docker daemon)                        │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                     app container (name: wsd-pro)            │  │
│  │                                                              │  │
│  │  ┌───────────────┐   ┌────────────────────────────────────┐  │  │
│  │  │  Preact SPA   │──▶│  Express 5 API  (port 3000)        │  │  │
│  │  │  (built,      │   │  - auth + users                     │  │  │
│  │  │   served /)   │   │  - projects (dockerode)            │  │  │
│  │  └───────────────┘   │  - providers / agents / chat       │  │  │
│  │                      │  - storage / snapshots / archive   │  │  │
│  │  ┌───────────────┐   │  - webhooks / alerts               │  │  │
│  │  │  code-server  │   └────────────┬───────────────────────┘  │  │
│  │  │  (port 8100)  │                │                         │  │
│  │  └───────────────┘                │ WebSocket (ws)           │  │
│  │  ┌───────────────┐   ┌────────────▼────────────────────────┐ │  │
│  │  │  opencode web │   │ /ws/projects/status                 │ │  │
│  │  │  (port 4096)  │   │ /ws/projects/:slug/{status,logs,    │ │  │
│  │  └───────────────┘   │   terminal}                         │ │  │
│  │                      │ /ws/chat/:slug/:chatId (AI chat)    │ │  │
│  │                      │ /ws/agent/:id/:chatId               │ │  │
│  │                      │ /ws/chat-team (team chat)           │ │  │
│  │                      └─────────────────────────────────────┘ │  │
│  │                                                              │  │
│  │  ┌────────────────────────────────────────────────────────┐  │  │
│  │  │            Docker socket (/var/run/docker.sock)        │  │  │
│  │  │  ┌─────────────────────────┐  ┌──────────────────────┐  │  │
│  │  │  │ wsd-<slug> containers   │  │ wsd/workspace image  │  │  │
│  │  │  │ (project containers)    │  │ (Ubuntu 24.04 base)  │  │  │
│  │  │  └─────────────────────────┘  └──────────────────────┘  │  │
│  │  └────────────────────────────────────────────────────────┘  │  │
│  │                                                              │  │
│  │  Data (volume wsd-data + bind mount):                        │  │
│  │   ┌─────────────┐ ┌──────────────┐ ┌────────────────────┐  │  │
│  │   │ data/users  │ │ data/projects│ │ ./workspaces       │  │  │
│  │   │ data/agents │ │ /<slug>/     │ │ (bind source for   │  │  │
│  │   │ data/chat   │ │  notes.json  │ │  project containers)│  │  │
│  │   │ data/audit  │ │  canvas.json │ └────────────────────┘  │  │
│  │   │ etc.        │ │  activity    │                          │  │
│  │   └─────────────┘ └──────────────┘                          │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

---

## 2. Backend (Express 5 + Node 22 + ws)

### Tech stack
- **Runtime**: Node.js 22, TypeScript
- **HTTP**: Express 5 — same-origin UI (vite dev proxies `/api` and `/ws`)
- **WebSocket**: `ws` package — 6+ endpoints, JWT validated on upgrade via `?token=` query param
- **Docker**: `dockerode` — container lifecycle, exec, inspect, list

### WebSocket endpoints

| Path | Handler | Purpose |
|------|---------|---------|
| `/ws/projects/status` | `ws-projects-status.ts` | Global broadcast of all project status changes |
| `/ws/projects/:slug/status` | `ws-project-status.ts` | Per-project status + CPU/memory stats (3s poll) |
| `/ws/projects/:slug/logs` | `ws-project-logs.ts` | Live Docker logs tail |
| `/ws/projects/:slug/terminal` | `ws-terminal.ts` | xterm.js terminal |
| `/ws/chat/:slug/:chatId` | `ws-chat.ts` | AI chat per project |
| `/ws/agent/:id/:chatId` | `ws-agent.ts` | Agent chat with tools |
| `/ws/chat-team` | `ws-chat-team.ts` | Team chat (channels, typing, presence) |

**Access rules on the chat WS** (mirrors `requireProjectAccess`): only project members connect to a project's chat room (outsiders closed with 1008 before replay); only editor+ may send `prompt`/`stop` — a viewer's write attempt gets a read-only `error` frame while the socket stays open. Global editors (system role `editor`) pass as write-level on every project. `global` chat open to every authenticated user.

### Data layout (`WSD_DATA_DIR`, default under the app container)

| Path | Content | Mode |
|------|---------|------|
| `data/users.json` | Accounts: bcrypt hash, role, `totp`, `providersPasswordHash`, `tokenVersion` | 0600 |
| `data/providers.json` | Provider configs — API keys sealed (see §5.4) | 0600 |
| `data/audit.json` | Append-only security log, capped at last 100 entries | 0600 |
| `data/projects/<slug>/` | Per-project: `meta.json`, `notes.json`, `canvas.json`, `activity.json`, `snapshots/` | 0600 |

### Background services (sweeps)

| Service | Trigger | Default cadence |
|---------|---------|-----------------|
| `workspace-janitor` | boot + interval + after create/delete | 15 min (`WSD_JANITOR_INTERVAL_MS`) |
| `startAlertsAutomation` | boot | 10s (`WSD_ALERT_SWEEP_MS`) |
| `runSnapshotSweep` | boot + interval + on schedule change | 5 min (`WSD_SNAPSHOT_SWEEP_MS`) |
| `ensureServeRunning` | after every create/start/recreate | — |
| `dispatchWebhook` | on lifecycle/crash/snapshot events | fire-and-forget |

Each sweep is singleflighted (overlapping passes skip), isolates per-project errors, and **never throws into a lifecycle op**.

---

## 3. Frontend (Preact + TypeScript + Vite)

### Tech stack
- **Preact** + TypeScript, built with **Vite**
- **State/auth**: `AuthProvider` context (`auth.tsx`); token in `localStorage['wsd.token']`
- **API helper**: `api()` auto-attaches `Authorization: Bearer`; 401 redirects to `/login` (except intentional password checks which pass `skipAuthRedirect: true`)
- **Icons**: lucide-preact everywhere
- **Theme**: dark mode only
- **Version badge**: `BETA` (health, server/info, About, backups)

### Pages

| Route | Component | Notes |
|-------|-----------|-------|
| `/login` | Login | Setup + login (unauthenticated only) |
| `/` | Dashboard | Stats, quick actions, storage strip, crash stat-card |
| `/projects` | Projects | Cards/table, search, filter, sort, bulk ops, Trash tab |
| `/project/:slug` | Project | Overview, AI chat, files, logs, Terminal, notes, scripts, Canvas |
| `/planner` | Planner | Visual planning hub; cards deep-link to `?tab=canvas` |
| `/terminals[/:slug]` | Terminals | Legacy global terminal hub |
| `/chat` | TeamChat | Team channels + DMs + presence |
| `/agents` | Agents | AI agents with tools, RTL/LTR, presets |
| `/providers` | Providers | LLM provider config + security lock gate |
| `/settings` | Settings | Profile, password, 2FA, security, storage, webhooks |
| `/ide` | EmbeddedIDE | code-server iframe |
| `/opencode` | Opencode | opencode web iframe |
| `/opencode-studio` | OpencodeStudio | agents/skills/commands/config CRUD + bilingual guide |
| `/user/:id` | UserProfile | Public profile page for any authenticated member |

### Key UI patterns
- **ConfirmModal** replaces `window.confirm()` for destructive actions (dark, warning avatar, names the exact target)
- **ReAuthModal** sudo pattern: sensitive ops require account-password re-entry
- **WS with HTTP fallback**: project status/logs try WS first, fall back to 5s polling; agents chat uses exponential-backoff reconnect (2s→16s)
- **Brand honesty**: official opencode logo and official VS Code mark in the sidebar

---

## 4. Docker

### 4.1 Multi-stage build (`Dockerfile`)
1. **Stage 1** — build the frontend with Vite
2. **Stage 2** — compile the backend TypeScript
3. **Stage 3** — runtime: Node 22 + built assets + `entrypoint.sh` supervisor

The `entrypoint.sh` also:
- Replaces the baked opencode config, registers live-project dirs into opencode's SQLite store and purges stale rows *before* launching
- Supervises the opencode web process (while-loop) so `POST /opencode-studio/update` can swap the binary live
- Launches code-server (`--auth none`)

### 4.2 Workspace image (`Dockerfile.workspace`)
- Ubuntu 24.04 base; published as `wsd/workspace`
- Project containers run `sleep infinity` by default — services are started manually from the terminal/IDE
- Workspace dir is bind-mounted at `/workspace` (same files the dashboard sees)

### 4.3 Project container lifecycle
- `createProject` → slug, `workspaces/<slug>/`, container `wsd-<slug>`, ports, optional env/limits
- `start` / `stop` / `recreate` / `delete` — each records activity feed entries
- Ports and resource limits are persisted into `meta.json` immediately, applied only on the next **explicit recreate** (Docker cannot rebind ports or cgroup caps live) — the API reports an honest `needsRecreate`

---

## 5. Authentication & Security

### 5.1 Authn / Authz
- **Password**: bcrypt (10 rounds), stored in `data/users.json`
- **Sessions**: JWT, 24h expiry, claims carry per-user `id`/`username`/`role`; `tv` claim enables revocation (`logout-all` bumps `tokenVersion`); random `jti` enables session-bound unlock tokens
- **Middleware**: `authMiddleware` on all routes after `/api/auth/*`; `requireAdmin`/`requireRole` for admin-only surfaces; `checkProjectAccess` for per-project membership
- **Global editor**: system role `editor` acts as a write-level member on *every* project without membership (delete/transfer-owner/member-add remain admin-only)

### 5.2 Two-Factor Authentication (TOTP)
- RFC 6238 implemented from scratch (`services/totp.ts`) — HMAC-SHA1, 30s steps, 6 digits, ±1 step drift; verified against official Appendix B vectors
- Login returns `{requires2fa:true, pendingToken}` (5-min scoped JWT, **not** a session) only for the account whose own TOTP is enabled
- `POST /api/auth/login/verify` exchanges the pending token + code for a session signed for the challenged user
- Dedicated `totp` rate-limit scope: 8/min/IP

### 5.3 Providers Security Lock
- Separate bcrypt password (`providersPasswordHash`), managed via a two-step sudo flow
- Unlock mints a scoped 30-min JWT (`scope:'providers'`, `sid` = session `jti`); `providersLockMiddleware` requires the session match — a stolen token replayed from another session is rejected
- `pv` version counter invalidates all unlock tokens on password change; `POST /providers/relock` bumps it (kills tokens across all tabs/devices)
- **Scoped tokens are never sessions**: `verifyToken` rejects any JWT carrying a `scope` claim
- Locked management endpoints return `403 {error:'providers_locked'}`; `GET /api/providers/options` + `/templates` stay open; LLM chat/agent usage is server-side and never blocked

### 5.4 At-rest encryption (secret box)
- Provider API keys sealed with AES-256-GCM: `enc1:<iv>:<tag>:<ct>:<last4>`
- Key = scrypt(`WSD_ENCRYPTION_KEY` → fallback `JWT_SECRET`), salt persisted once in `data/crypto.salt` (0600)
- Plaintext keys are sealed automatically on load; masking uses `<last4>` — never decrypts; backup exports strip keys entirely

### 5.5 Hardening
- Rate limiting: global budget (240/min, env-tunable), dedicated brute-force scopes — `auth` 10/min (login/setup/password verification), `unlock` 15/min + progressive cooldown (5 failures → 15-min ban), `totp` 8/min
- `WSD_TRUST_PROXY=1` opts into one reverse-proxy hop (default OFF)
- SSRF guard: http(s) only, cloud-metadata ranges refused; local LAN/loopback allowed (local Ollama)
- Path-traversal protection on all file routes; upload sanitization; `../`-rejection in tar parsing and archive paths; **symlinks never followed** on archive restore
- CORS opt-in via `WSD_CORS_ORIGINS` allowlist (none set = no ACAO headers)
- Chat markdown href: scheme whitelist (`http:`/`https:`/`mailto:`/`#`/`/`) after control-char stripping
- `data/*.json` persist with mode 0600; provider health-check cache keys hash the API key (SHA-256)

---

## 6. Key Patterns

### 6.1 Pure-core + orchestration split
Import-free modules keep heavy logic testable offline with `node --test` (no Docker/network):

| Pure core | Used by |
|-----------|---------|
| `janitor-core.ts` | workspace janitor |
| `snapshots-schedule.ts` | scheduled snapshot sweeper |
| `alerts-core.ts` (`classifyCrash`) | crash detector |
| `activity-core.ts` | activity feed (33-event vocabulary) |
| `archive-core.ts` | trash bin file rules |
| `serve-core.ts` | static site serving rules |
| `storage-core.ts` | disk-walk metrics |

### 6.2 File locking
Per-store synchronous lock helpers (`withFileLock`) protect concurrent writes to:
- `notes.json` / `canvas.json` / `activity.json` (per-slug locks, e.g. `activity:<slug>`)
- `chat-team/` store, `users.json`, `providers.json`, `webhooks.json`

### 6.3 Caching & singleflight
- **Storage metrics**: ~45s TTL in-memory cache + singleflight; `?fresh=1` bypasses; invalidated on project create/duplicate/import/delete/restore
- **Provider health checks**: 60s server-side cache; cache keys hash the API key
- **opencode version probe**: cached
- **Alerts sweep**: singleflighted, never queues
- **Trash listing**: 15s TTL + singleflight

### 6.4 Crash classification
`classifyCrash()` on inspect data:
- Explicit stop (`meta.requestedStop`) never alarms — masks even OOM/non-zero
- `oomKilled` → `oom` (fire-once per start epoch)
- stopped + non-zero exit → `exited`; exit 0 is never a crash
- running with moved StartEpoch/RestartCount → `restart` (silent auto-restart)
- Re-fires only on a NEW start epoch — an ongoing crash cycle never spams

### 6.5 WebSockets with HTTP fallback
Project status/logs/terminal prefer WS; status/logs fall back to 5s HTTP polling. Room limit: 8 connections per WS room.

---

## 7. Testing

### Layout
```
backend/tests/
  *.test.ts            — Node test runner suites (real-Docker against the running app)
  *-core.test.ts       — offline unit tests on import-free modules
  e2e/limits_ui.py     — Playwright browser E2E (resource-limits UI)
  e2e/reviews_ui.py    — Playwright browser E2E (file reviews UI)
```

### Running

```bash
# Backend suites (server must be up on port 3000)
cd backend && node --test --test-concurrency=1 "tests/**/*.test.ts"

# UI E2E (Python + Playwright)
python backend/tests/e2e/limits_ui.py
python backend/tests/e2e/reviews_ui.py
```

### Conventions
- **Serial execution only** (`--test-concurrency=1`) — parallel runs + browser polling trip the rate limiter
- Suites sign their own JWTs from the repo `JWT_SECRET` (no real password needed)
- Optional real-login tests activate with `WSD_TEST_USER`/`WSD_TEST_PASS`
- Every suite self-cleans its projects/agents/providers/channels
- **Environment**: the full suite needs `WSD_TESTING=1` (suite container, relaxed non-security budgets). The dev container runs `WSD_TESTING=0` with production budgets — only the offline `*-core` suites run reliably against it. The `auth`/`unlock`/`totp` brute-force scopes deliberately keep **real** values under testing.

### Coverage highlights
- Auth matrix (per-user login identity, 2FA per-user journey, session revocation, sudo transfer contract)
- Project lifecycle incl. duplicate + limits (MemorySwap pinned to Memory — swap disabled) + ports conflicts (`taken[]`, stale live bindings)
- Snapshots (export/import/restore, traversal-proof tar), scheduled automation, retention pruning
- Team access (viewer read-only, global-editor matrix, owner-delete guard)
- Team chat (channel discipline, unread, search, attachments, presence)
- Canvas/notes/activity (round-trip + AI-context injection + list-carried feed)
- Opencode Studio (roster integrity: frontmatter, zero NUL bytes, non-empty descriptions)
- Webhooks (HMAC signature verification, event filtering), storage metrics (cache contract, symlink rules), crashes (fire-once epochs)
- WebSocket matrix: 6 endpoints × {no token → 401, valid → open, invalid → 401}

---

## 8. Ports & Naming Conventions

| Item | Value |
|------|-------|
| Dashboard / API | `3000` (env `PORT`) |
| Web IDE (code-server) | `8100` (`WSD_IDE_PORT`) |
| opencode web | `4096` (`WSD_OPENCODE_PORT`) |
| App container | `wsd-pro` |
| App image | `wsd-pro-app` |
| Project containers | `wsd-<slug>` |
| Workspace image | `wsd/workspace` |
| Per-project goals file | `WSD_PROJECT.md` |
| Canvas mirror | `WSD_CANVAS.md` |
| Backup naming | `madar-backup-*.json` + importable legacy `wsd-pro-backup` |

The 2026-08 renaming **kept** the `wsd.*` localStorage keys, `WSD_*` env vars, and docker resource names deliberately, for data/infra compatibility.