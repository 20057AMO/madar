# Madar — Architecture

> Technical architecture of **Madar (مدار)** — a self-hosted, all-in-one workspace platform for development teams. Version: **BETA**.

---

## 1. System Overview

Madar is a single Docker Compose stack: one `app` container serves the whole product (Preact dashboard, Express API, WebSocket services, Docker orchestration), and a separate base image (`wsd/workspace:latest`, Ubuntu 26.04 LTS + Node 24 LTS) is used to generate one container per project. The `app` container itself stays on Node 22.

**Deployment cardinality: one app instance.** Do not run replicas or HA. State is local to the single `app` container: JSON stores with in-process locks, read-write `/var/run/docker.sock`, bind-mounted workspaces, and WebSocket/terminal/chat state. Production runs one instance behind nginx/TLS (§8).

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
│  │  │  code-server  │   │  - embed proxy (4097, editor+)     │  │  │
│  │  │ (127.0.0.1:   │   └────────────┬───────────────────────┘  │  │
│  │  │  8080, only via│               │                         │  │
│  │  │  the proxy)   │                │ WebSocket (ws)           │  │
│  │  └───────────────┘                │                         │  │
│  │  ┌───────────────┐   ┌────────────▼────────────────────────┐ │  │
│  │  │  opencode web │   │ /ws/projects/status                 │ │  │
│  │  │ (127.0.0.1:   │   │ /ws/projects/:slug/{status,logs,    │ │  │
│  │  │  4096, only via│  │ terminal}                         │ │  │
│  │  │  the proxy)   │   │ /ws/chat/:slug/:chatId (AI chat)    │ │  │
│  │                      │ /ws/agent/:id/:chatId               │ │  │
│  │                      │ /ws/chat-team (team chat)           │ │  │
│  │                      └─────────────────────────────────────┘ │  │
│  │                                                              │  │
│  │  ┌────────────────────────────────────────────────────────┐  │  │
│  │  │            Docker socket (/var/run/docker.sock)        │  │  │
│  │  │  ┌─────────────────────────┐  ┌──────────────────────┐  │  │
│  │  │  │ wsd-<slug> containers   │  │ wsd/workspace image  │  │  │
│  │  │  │ (project containers)    │  │ (Ubuntu 26.04 LTS)   │  │  │
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
- Syncs the **managed** IDE config on every boot *before* the supervisor starts, because the `code-server-data` volume shadows the baked user-data-dir `/root/.local/share/code-server` — where VS Code reads USER settings from (see §4.4)

### 4.4 IDE image hardening (`backend/docker/ide-hardening.sh`)

The stock code-server bundle carries an unusable ~130 MB Copilot payload, and the naive "delete the
extension directories" fix is broken in four ways. This script is the **single enforcement point** and
exposes three modes:

| Mode | When | What it does |
| --- | --- | --- |
| `capture` | image build only | Walks `extensionDependencies` **transitively** from the keep-list roots and snapshots the computed closure to `/opt/madar/ide-builtin` — while the pristine tree still exists and before the `.deb` is discarded. The Dockerfile asserts the dir is non-empty, since a silent no-op capture would otherwise reach a `verify` that no-ops on the same condition and ship a broken image. |
| `apply` | build, every `dpkg -i`, boot re-apply | Restores the captured closure, prunes to the keep-list, stubs the `@github` tree. Idempotent. |
| `verify` | build, every `dpkg -i`, boot | Invariants I1–I5; exits 1 naming the broken one. |

The four defects it exists to close:

1. **Unprefixed names** — the old delete list used `js-debug-companion` / `vscode-js-profile-table`, but the
   real directories are `ms-vscode.js-debug-companion` / `ms-vscode.vscode-js-profile-table`. Both shipped green.
2. **`dpkg -i` resurrects everything** — both the interactive component update and the boot re-apply
   restore the pristine tree. Every `dpkg` call site in `code-server-update.ts` (baseline, interactive and
   each rollback rung) now runs `apply && verify`, and a failure drives the existing rollback ladder, so
   hardening can never be silently skipped by an update.
3. **Deleting a dependency** — `vscode.git` declares `extensionDependencies: ["vscode.git-base"]`. The old
   list removed Git's only dependency and Source Control hung on `Scanning folder for Git repositories…`
   forever. The closure is *computed*, never named, so this cannot recur.
4. **Name-based stubbing misses packages** — the first pass named three `@github` packages while
   code-server 4.138 ships a fourth (`@github/copilot-sdk-linux-x64`, 127 MB), so the image stayed at
   442 MB with every named check green. Stubbing is therefore **structural**: every shipped package is
   replaced, and the flavour comes from its own `package.json` — a package declaring `bin` is *spawned*, so
   its stub is `process.exit(0)` (real bin name preserved); everything else is *imported*, so its stub is
   `module.exports = {}`. I2 caps the **whole tree** at <2 MiB and requires it to be ELF-free, which is
   what catches a package nobody knew about. Writer and checker share one `github_stub_kind` definition.

Result: `@github` 132 MB → **12 KB**, `/usr/lib/code-server` 442 MB → **316 MB**, no sidecar process, no
boot errors — and the invariants were re-proven live after a runtime bump to
code-server 4.140 / VS Code 1.140.

**Keep-list roots.** The closure is computed from the keep-list roots, and a root is kept **even when
nothing declares it**. `vscode.github-authentication` is exactly that case: its pristine
`extensionDependencies` is empty, so no other built-in pulls it into the closure — and because it is the
`github` authentication *provider*, pruning it cost a 404 on every IDE load plus
`Activating extension 'vscode.github-authentication' failed` and
`Timed out waiting for authentication provider 'github' to register`. It is safe to keep: it carries no
Copilot edge (`dependencies {}`, no `@github/*` reference) and the structural `@github` stubs keep the
sign-in path dead regardless, so restoring it cannot reintroduce the Copilot payload. Adding it moved the
built-in count 37 → 38 and left `@github` (12 KB, ELF-free) and `/usr/lib/code-server` (316 MB) untouched.

**Managed config.** Editing the baked `settings.json` alone is a no-op: the `code-server-config` volume
shadows it, and a volume survives a container recreate with the stale file. `entrypoint.sh` therefore
backs the volume's file up (`settings.json.madar-backup-<stamp>`, never deleted), replaces it atomically
(`cp` to temp + `mv`), overwrites the stale `config.yaml`, installs the pinned digest-verified
`gruntfuggly.todo-tree` VSIX from `/opt/madar/ide-vsix` via the CLI (local file, no network), runs
`verify`, and only then writes the `$DATA_DIR/ide-sync.json` stamp (mode 0600) atomically. Every step is
`|| echo`-guarded so a failed migration can never abort the boot. The digest check requires
`curl --compressed`, because the marketplace answers with `content-encoding: gzip` and the raw bytes do
not match.

### 4.2 Workspace image (`Dockerfile.workspace`)
- Ubuntu 26.04 LTS + Node 24 LTS base, published as `wsd/workspace:latest`; the `app` container itself stays on Node 22
- The image carries OCI labels (`org.opencontainers.image.*`) plus `io.madar.workspace.toolchain.*` labels: `schema`, `image`, `build-id`, `built-at`, `marker`, `marker-schema`, `ubuntu-version-id`, `node-major`, `node-channel`. At build it writes the marker `/etc/madar/workspace-toolchain.json` (schema `1`) recording declared and detected Ubuntu / Node / npm versions, `buildId`, `builtAt`, per-check results (`ubuntu`, `nodeMajor`, `nodeLts`, `npm`, `dockerCliAbsent`) and `dockerCli:false`. The build fails if the installed toolchain does not match the declared target or if a Docker CLI is present in the image
- No Docker CLI is installed in the workspace image, so project containers cannot report Docker versions. Docker version reporting is host-daemon-only: the app reads `Version` and `ApiVersion` from `docker version` on the host daemon (`safeDockerDaemonVersion` allowlist), exposing no other fields and no raw command output
- Staleness is derived from the marker's `builtAt` against `DEFAULT_WORKSPACE_STALE_DAYS = 30` (a build is stale at `>= 30` days). `services/workspace-image-core.ts` holds these rules as import-free pure functions
- Refresh builds `docker build --pull --no-cache --file <Dockerfile> --tag wsd/workspace:latest` with pinned build args as an argv array (no shell). It rebuilds the image only: running containers keep their current toolchain until each is explicitly **recreated** — there is no auto-upgrade. Failures map to fixed labels (`docker_unavailable`, `workspace_build_unavailable`, `timeout`, `workspace_build_failed`, `build_failed`, `workspace_image_error`), never raw Docker logs or host paths
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
- Provider API keys sealed with AES-256-GCM: current `v2:<iv>:<tag>:<ct>:<last4>`; legacy `enc1:` is read-only migration
- Current key comes from `WSD_ENC_KEY` (16–1024 chars) or a generated random 32-byte key in `data/enc.key` (0600), never derived from the JWT secret; a fresh 12-byte IV is used per seal and the GCM tag is verified
- Legacy `enc1:` uses scrypt(`WSD_ENCRYPTION_KEY` → fallback the resolved signing secret) with `data/crypto.salt` (0600); it is rewritten to `v2:` on the next provider-store load/rewrite. Masking uses `<last4>` — never decrypts; backup exports strip keys entirely

### 5.5 Hardening
- **No default signing secret**: `JWT_SECRET` is resolved once by `services/jwt-secret.ts` — a strong env value wins, otherwise a random `randomBytes(32)` secret is generated once and persisted at `data/jwt.secret` (0600, inside the data volume). A blank, known-weak (the retired in-repo literals) or under-32-character value is **refused, never repaired**, and every sign/verify call site reads that one memoized value, so a signer/verifier split is impossible
- Rate limiting: global budget (240/min, env-tunable), dedicated brute-force scopes — `auth` 10/min (login/setup/password verification), `unlock` 15/min + progressive cooldown (5 failures → 15-min ban), `totp` 8/min
- `WSD_TRUSTED_PROXIES` accepts a comma-separated allowlist of IPs/CIDRs plus `loopback`/`linklocal`/`uniquelocal` (default OFF; `/0` ignored) — it governs both per-IP limiter trust (`req.ip`) and whether the `madar_embed` cookie is minted `Secure` from `X-Forwarded-Proto`. `WSD_TRUST_PROXY=1|true` remains an alias for `loopback,uniquelocal`; do not enable it with the base compose
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
| `activity-core.ts` | activity feed (38-event vocabulary) |
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
cd backend && npm test

# UI E2E (Python + Playwright)
python backend/tests/e2e/limits_ui.py
python backend/tests/e2e/reviews_ui.py
```

### Conventions
- **Serial execution only** (`--test-concurrency=1`) — parallel runs + browser polling trip the rate limiter
- Suites sign their own JWTs with the same resolved secret the server uses (env `JWT_SECRET`, else the container's persisted `data/jwt.secret`) — no real password needed
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
| Embedded-surface proxy (the ONLY route to the IDE / opencode) | `4097` (`WSD_EMBED_PROXY_PORT`), editor+ `madar_embed` cookie |
| Production public listeners | nginx on the host: `80` (ACME challenge → HTTPS redirect), `443` (dashboard/API), `4097` (embedded proxy TLS) |
| Production app bind | `127.0.0.1:3000` and `127.0.0.1:4097` via `docker-compose.prod-tls.yml` |
| Web IDE (code-server) | `127.0.0.1:8080` in-container (`WSD_IDE_INTERNAL_PORT`) — not published; `8100` stays reserved |
| opencode web | `127.0.0.1:4096` in-container (`WSD_OPENCODE_PORT`) — not published |
| App container | `wsd-pro` |
| App image | `wsd-pro-app` |
| Project containers | `wsd-<slug>` |
| Workspace image | `wsd/workspace` |
| Per-project goals file | `WSD_PROJECT.md` |
| Canvas mirror | `WSD_CANVAS.md` |
| Backup naming | `madar-backup-*.json` + importable legacy `wsd-pro-backup` |

The 2026-08 renaming **kept** the `wsd.*` localStorage keys, `WSD_*` env vars, and docker resource names deliberately, for data/infra compatibility.

### Production trust boundary (single instance)

Production runs **one** app instance. nginx is the only public listener; the app container listens on loopback only. Apply `docker-compose.prod-tls.yml` on top of `docker-compose.yml` — do not hand-edit `docker-compose.yml`.

```text
public                 nginx (host)                     app container (loopback only)
:80    ── ACME challenge, then redirect to HTTPS
:443   ──►  127.0.0.1:3000   (dashboard + API)
:4097  ──►  127.0.0.1:4097   (authenticated embedded-surface proxy)
                                    ├─► 127.0.0.1:8080  code-server --auth none
                                    └─► 127.0.0.1:4096  opencode web
```

- `:3000` carries the authenticated dashboard/API and the JWT sent from `localStorage`.
- `:4097` is the **only** route to code-server and opencode. The raw `8100`/`4096` publishes are gone; both upstreams bind to `127.0.0.1` inside the app container and have no address on any Docker network.
- `WSD_TRUSTED_PROXIES` belongs **only** in the production override. The base compose publishes `3000`/`4097` on `127.0.0.1` (`WSD_EMBEDDED_PUBLISH_HOST`, default `127.0.0.1`), so do not combine a `0.0.0.0` publish with proxy trust; a startup warning fires when trust is enabled while the publish host is `0.0.0.0`.
- Serve the two surfaces by **port, not path prefix**: `madar_embed` is host-scoped (cookies ignore ports), and opencode serves absolute `/assets/…` URLs so it owns the origin root.
- TLS is required. On cleartext, one on-path attacker reads both the dashboard JWT and the `madar_embed` cookie. The cookie is issued `Secure` only on a trusted TLS link (`WSD_TRUSTED_PROXIES` matches the proxy hop plus `X-Forwarded-Proto: https`), because an unconditional `Secure` flag would be silently dropped by browsers on a plain-HTTP LAN install.
- nginx access logs must use `$uri`, never `$request_uri`: WebSocket connections carry the JWT in `?token=`, and `$request_uri` would write it to disk. Set `client_max_body_size 256m`: the app caps snapshot import at 200 MB and `256m` leaves room for multipart data and upload headers; see [INSTALL.md](INSTALL.md#الأمان-في-النشر--security-in-production-deployment) for the full nginx contract and deployment sequence.
- `bash scripts/check-prod-binding.sh` must exit 0 after startup; `--check-running` also inspects the running `wsd-pro` container.

Full deployment steps and devops-owned file names are in [INSTALL.md](INSTALL.md#الأمان-في-النشر--security-in-production-deployment). See also [SECURITY.md](../SECURITY.md) for the threat model and [Agent safety](AGENT-SAFETY.md) for tool-use permission defaults and provider-key isolation.