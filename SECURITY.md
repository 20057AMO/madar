# Security Policy

## Supported versions

Madar is distributed as a rolling `BETA` build from this repository. Security fixes are made on the current `main` branch and in the newest published image. Older tags, forks, and installations that have not been rebuilt from current sources are not supported; upgrade before reporting an issue.

## Reporting vulnerabilities

Please report suspected vulnerabilities privately through GitHub Security Advisories for `20057AMO/madar`: <https://github.com/20057AMO/madar/security/advisories/new>.

Do not open a public issue for an unfixed vulnerability. Include the affected version or commit, a reproduction, the impact you can demonstrate, and any relevant logs with tokens, provider keys, and secrets redacted. The maintainer will triage privately and coordinate disclosure and a fix.

## Threat model

### Docker socket is root-equivalent

The app container mounts `/var/run/docker.sock` so it can create and manage project containers. Anything that can issue Docker API calls from that container—an authenticated privileged API path, a server-side command-injection bug, a malicious dependency, or code executing inside the app container—can control the Docker daemon and therefore the host. Authentication and input validation are the primary boundary; the socket is not a sandbox.

Project containers are created without `Privileged`, with `no-new-privileges:true`, with a configurable process cap (`WSD_PROJECT_PIDS_LIMIT`, default 512), and with the existing CPU/RAM caps. Only the project workspace is bind-mounted; the Docker socket is never mounted into a project container. Capabilities are left at the image defaults. A blanket `CapDrop: ['ALL']` was not applied because it was not verified against the workspace toolchain; dropping individual dangerous capabilities is a separate, live-verified change. These settings reduce blast radius but do not protect against kernel exploits or a malicious root user inside a project container.

### Single-instance design

Madar is designed as one app instance managing local project containers on one Docker daemon. There is no per-project kernel boundary between the app process, the daemon socket, and the host. Projects can be permission-isolated at the API level, but a compromise of the app process is a compromise of the whole installation, not just one project. For stronger tenant separation, run separate Madar instances on separate hosts or VMs.

### TLS is required

Terminate TLS in front of both the dashboard on `:3000` and the authenticated embedded-surface proxy on `:4097`. The dashboard JWT lives in `localStorage` and the embed credential is a host-scoped cookie; on cleartext HTTP both are readable by an on-path attacker. Protecting only the dashboard leaves the embedded IDE/opencode proxy reachable in cleartext, and that proxy fronts code-execution surfaces. `HttpOnly`, `SameSite`, and short token lifetimes reduce exposure but do not replace TLS. See [production TLS and trusted-proxy guidance](docs/PRODUCTION-DEPLOY-RUNBOOK.md) for a reverse-proxy checklist.

### Setup token and first account

On a fresh data directory, the setup endpoint requires a token. Set `WSD_SETUP_TOKEN` before first boot, or read the generated token from the container log (`docker compose logs app`) as described in [installation](docs/INSTALL.md). `data/setup.token.sha256` stores only the SHA-256 hash, which is checked in constant time. After setup succeeds the hash is removed and setup returns `409`; create the remaining accounts from the admin UI.

### Trusted proxies

Madar ignores `X-Forwarded-For` by default. If TLS terminates in front of Madar, configure `WSD_TRUSTED_PROXIES` (for example `loopback,uniquelocal`) so rate limiting and audit IPs use the proxy-provided client address. A permissive `/0` entry is ignored. See [installation](docs/INSTALL.md) and the [production runbook](docs/PRODUCTION-DEPLOY-RUNBOOK.md) before exposing Madar beyond loopback.

### Secrets at rest

Provider keys are sealed with AES-256-GCM using the current `v2:` format and a dedicated 32-byte key from `WSD_ENC_KEY` or `data/enc.key`. The older `enc1:` format is read-only for migration: it used `WSD_ENCRYPTION_KEY` or the JWT signing secret with `data/crypto.salt`. When Madar rewrites a legacy provider store it writes `v2:` values. Backups strip provider keys entirely. See [installation](docs/INSTALL.md) for key-management details and [agent safety](docs/AGENT-SAFETY.md) for the privileges available to delegated agents.

### Agent surfaces

The embedded VS Code and opencode surfaces, and delegated roster agents, can run code inside the app container, which holds the Docker socket and signing secrets. Review [agent safety](docs/AGENT-SAFETY.md) before granting editor access or launching agents.

### Optional socket proxy

An opt-in Docker socket proxy is available in [`docker-compose.socket-proxy.yml`](docker-compose.socket-proxy.yml). Enable it only as harm reduction, not as a sandbox: every enabled endpoint remains powerful, and `POST`/`EXEC` can still amount to host code execution. The overlay sets `DOCKER_HOST=tcp://docker-proxy:2375`, allows read-only API calls plus `POST`, and requires `EXEC=1` for terminal features. It does not replace authentication, TLS, project-container hardening, or host-level isolation.
