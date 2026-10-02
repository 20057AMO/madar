#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${WSD_DATA_DIR:-/app/data}"
mkdir -p "$DATA_DIR"

# ── Web IDE ───────────────────────────────────────────────────
# BOTH embedded surfaces run UNAUTHENTICATED code execution as ROOT beside
# /var/run/docker.sock, so they listen on the app container's LOOPBACK and
# nothing else. This is the load-bearing control: a 127.0.0.1 listener has no
# address on any docker network, so NO container — on the app network, on the
# default bridge, on any user-defined network — can route to it. Publishing the
# port on the host with HostIp 127.0.0.1 never helped: that only constrains
# traffic arriving in the HOST network namespace, while a container on the
# default bridge reaches the container's bridge address directly (live-proven:
# a project container on 172.17.0.x got 200 from opencode and 302 from
# code-server on 172.18.0.2, then drove opencode to a session + prompt).
#
# The browser reaches both through the Madar embedded-surface proxy
# (services/embed-proxy.ts, port WSD_EMBED_PROXY_PORT), which requires an
# editor+ Madar session. That is why 0.0.0.0 upstream binds are gone: the
# published port now points at the authenticated proxy, never at these.
#
# The bind is HARD-CODED and deliberately NOT an env knob. A knob here is an
# opt-out of the only control that keeps these surfaces unreachable, and the
# pre-change .env.example shipped WSD_IDE_BIND=0.0.0.0 with instructions to
# widen it for LAN sharing — every host that followed that advice would have
# silently reopened the original hole on upgrade (a comment saying "do not
# widen it" is not a control). A stale value in an existing .env is reported
# loudly and ignored, never honoured.
if [ -n "${WSD_IDE_BIND:-}" ] || [ -n "${WSD_OPENCODE_BIND:-}" ]; then
  echo "Madar: WSD_IDE_BIND / WSD_OPENCODE_BIND are no longer read — the embedded upstreams are always loopback-bound. Delete them from .env; the value there has NO effect." >&2
fi
IDE_BIND=127.0.0.1
OPENCODE_BIND=127.0.0.1

echo "Madar: starting supervised code-server IDE on ${IDE_BIND}:8080 (no auth, loopback-only)"

# ── Managed IDE config sync (stamped, idempotent, never fatal) ──
# TWO separate stores are in play, and confusing them silently invalidates
# every managed key:
#
#   * config.yaml  → /root/.config/code-server/config.yaml
#     (~/.config is code-server's XDG_CONFIG_HOME — its OWN config lives there)
#   * settings.json → <user-data-dir>/User/settings.json
#     code-server is started with no --user-data-dir, so its user-data-dir is
#     $XDG_DATA_HOME/code-server = /root/.local/share/code-server, and VS Code
#     reads USER settings from <user-data-dir>/User/settings.json.
#
# The sync used to write settings.json into /root/.config/code-server/User/ —
# a directory the workbench never opens — so every managed key was inert while
# the boot log cheerfully reported a successful sync. Proof it is the data dir
# that counts: /root/.local/share/code-server/User/ carries the user-data-dir
# furniture (workspaceStorage, History, globalStorage, Backups) and holds the
# hand-set values that are visibly in effect in a live window, and the workbench
# itself logs that path when it reads user settings.
#
# Both stores are VOLUME-mounted, so the shadowing is real in the other
# direction too: a recreated container keeps whatever its volume was seeded
# with. That is how the data dir ended up without workbench.startupEditor /
# update.mode / telemetry.telemetryLevel. The fix is not "copy at build time"
# but a boot sync from UNSHADOWED /opt/madar/ide-config, gated on a content
# stamp so it costs one sha256 on a no-op boot.
#
# The previous settings.json is kept as settings.json.madar-backup-<stamp8>
# (timestamped by stamp, NEVER deleted) so an operator can always diff what the
# sync replaced. extensions.json is NEVER hand-merged: the pinned VSIX is
# installed from a local file through code-server's own CLI so code-server
# writes the registry entry itself.
#
# HARD RULE: no step here may block boot. Every command is guarded — a failed
# migration must degrade to "the IDE still starts", because the alternative is
# an IDE that cannot be reached at all on a fresh or partially-migrated volume.
IDE_MANAGED_DIR=/opt/madar/ide-config
IDE_VSIX_DIR=/opt/madar/ide-vsix
IDE_HARDENING=/usr/local/share/madar/ide-hardening.sh
IDE_STAMP_FILE="$DATA_DIR/ide-sync.json"
IDE_SETTINGS=/root/.local/share/code-server/User/settings.json

ide_sync_managed_files() {
  [ -d "$IDE_MANAGED_DIR" ] || {
    echo "Madar: $IDE_MANAGED_DIR absent — skipping the managed IDE config sync"
    return 0
  }
  # Stamp over every managed input (settings, config.yaml, the pinned VSIX and
  # the hardening script itself), so a change to ANY of them re-runs the sync
  # instead of being masked by a stamp that is merely still valid.
  #
  # The DESTINATION is part of the stamp too, for the same reason: fixing the
  # settings path changed nothing about the managed inputs, so a stamp computed
  # only over them short-circuited and the sync kept writing to the dead file.
  # Moving the target is exactly the kind of change this gate must notice.
  local stamp current=""
  stamp="$( { find "$IDE_MANAGED_DIR" "$IDE_VSIX_DIR" -type f 2>/dev/null; [ -f "$IDE_HARDENING" ] && echo "$IDE_HARDENING"; } \
    | sort | xargs -r sha256sum 2>/dev/null \
    | { cat; printf '%s\n' "settings-target=$IDE_SETTINGS"; } \
    | sha256sum | cut -c1-64 )"
  if [ -z "$stamp" ]; then
    echo "Madar: could not compute the managed IDE config stamp — skipping the sync"
    return 0
  fi
  if [ -f "$IDE_STAMP_FILE" ]; then
    current="$(jq -r '.stamp // empty' "$IDE_STAMP_FILE" 2>/dev/null || echo '')"
  fi
  if [ "$current" = "$stamp" ]; then
    echo "Madar: managed IDE config already at stamp ${stamp:0:8} — nothing to sync"
    return 0
  fi
  echo "Madar: applying managed IDE config (stamp ${current:-none} -> ${stamp:0:8})"

  if [ -f "$IDE_SETTINGS" ]; then
    cp -a "$IDE_SETTINGS" "${IDE_SETTINGS}.madar-backup-${stamp:0:8}" \
      || echo "Madar: warning — could not back up the existing settings.json" >&2
  fi
  mkdir -p "$(dirname "$IDE_SETTINGS")" || true
  cp "$IDE_MANAGED_DIR/User/settings.json" "${IDE_SETTINGS}.madar-tmp" 2>/dev/null \
    && mv -f "${IDE_SETTINGS}.madar-tmp" "$IDE_SETTINGS" \
    || echo "Madar: warning — could not install the managed settings.json" >&2
  if [ -f "$IDE_MANAGED_DIR/config.yaml" ]; then
    cp "$IDE_MANAGED_DIR/config.yaml" /root/.config/code-server/config.yaml 2>/dev/null \
      || echo "Madar: warning — could not install the managed config.yaml" >&2
  fi

  local vsix
  for vsix in "$IDE_VSIX_DIR"/*.vsix; do
    [ -f "$vsix" ] || continue
    code-server --install-extension "$vsix" >/dev/null 2>&1 \
      || echo "Madar: warning — could not install the pinned $(basename "$vsix")" >&2
  done

  if [ -x "$IDE_HARDENING" ]; then
    "$IDE_HARDENING" verify >/dev/null 2>&1 \
      || echo "Madar: warning — ide-hardening verify failed; run '$IDE_HARDENING verify' and read the image build log" >&2
  fi

  # The stamp is written LAST — only once every step above was attempted, so a
  # crash mid-migration re-runs instead of claiming success.
  local tmp="$IDE_STAMP_FILE.madar-tmp"
  printf '{"stamp":"%s","appliedAt":"%s"}\n' "$stamp" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$tmp" 2>/dev/null \
    && chmod 600 "$tmp" \
    && mv -f "$tmp" "$IDE_STAMP_FILE" \
    || echo "Madar: warning — could not persist the IDE sync stamp" >&2
  rm -f "$tmp"
  return 0
}
ide_sync_managed_files || echo "Madar: warning — the managed IDE config sync failed (non-fatal)" >&2

# NOTE: code-server reads the PORT env var and it overrides --bind-addr,
# so unset it (PORT is used by the dashboard node app).
# Auth disabled (--auth none) — the ONLY access control is this loopback bind
# plus the authenticated proxy in front of it, and the bind is not configurable.
# Supervised restart loop: same pattern as opencode below — if code-server
# crashes or is killed (e.g. version update), the loop revives it within ~2s.
# PID of the live child is published in $DATA_DIR/code-server.pid for the
# backend to target precisely.
CODE_SERVER_PID_FILE="$DATA_DIR/code-server.pid"
rm -f "$CODE_SERVER_PID_FILE"
(
  while true; do
    env -u PORT code-server --auth none --disable-telemetry --disable-update-check \
      --disable-workspace-trust \
      --bind-addr "${IDE_BIND}:8080" /workspaces \
      > /tmp/code-server.log 2>&1 &
    CODE_SERVER_CHILD=$!
    printf '%s' "$CODE_SERVER_CHILD" > "$CODE_SERVER_PID_FILE"
    RC=0
    wait "$CODE_SERVER_CHILD" || RC=$?
    echo "Madar: code-server exited (code=$RC) - restarting in 2s" >&2
    sleep 2
  done
) &
CODE_SERVER_SUPERVISOR=$!

# ── opencode web (native UI, rooted at /workspaces) ───────────
# Purge stale opencode projects BEFORE it starts: deleted Madar projects
# must never haunt the opencode web UI. Shared python script also runs at
# runtime (best-effort) on every project delete / janitor archive.
OPENCODE_DB="$DATA_DIR/opencode/opencode/opencode.db"
if [ -f "$OPENCODE_DB" ] && command -v python3 >/dev/null 2>&1; then
  python3 /app/opencode-purge.py "$DATA_DIR" || true
fi

echo "Madar: starting supervised opencode web on ${OPENCODE_BIND}:${WSD_OPENCODE_PORT:-4096} (cwd /workspaces, loopback-only)"
mkdir -p "$DATA_DIR/opencode"
# Supervised restart loop: the Studio Update button kills the running
# opencode process after installing a newer binary — this loop revives it
# into the new version within ~2s. PID of the live child is published in
# $DATA_DIR/opencode-web.pid for the backend to target precisely.
OPENCODE_PID_FILE="$DATA_DIR/opencode-web.pid"
rm -f "$OPENCODE_PID_FILE"
(
  cd /workspaces
  while true; do
    # env -u PORT avoids the dashboard PORT=3000 leaking into opencode.
    # HOME=/workspaces makes the web UI's project picker start at /workspaces so the
    # user's project folders are visible immediately. XDG_* pins keep the Big Pickle
    # config, session state, cache and data in their original locations (so opencode
    # does not litter /workspaces with .cache/.npm runtime folders). npm_config_cache
    # redirects the npm cache the opencode process creates at startup.
    env -u PORT \
      HOME=/workspaces \
      XDG_CONFIG_HOME=/root/.config \
      XDG_STATE_HOME=/root/.local/state \
      XDG_CACHE_HOME=/root/.cache \
      XDG_DATA_HOME="$DATA_DIR/opencode" \
      npm_config_cache=/root/.npm \
      opencode web --hostname "${OPENCODE_BIND}" --port "${WSD_OPENCODE_PORT:-4096}" \
      > /tmp/opencode-web.log 2>&1 &
    OPENCODE_CHILD=$!
    printf '%s' "$OPENCODE_CHILD" > "$OPENCODE_PID_FILE"
    # NOTE: inherited `set -e` makes a bare `wait` FATAL when the child dies
    # from a signal (rc=143) — which silently killed this whole supervision
    # loop exactly when the Studio Update button killed opencode. Capture
    # the status explicitly instead.
    RC=0
    wait "$OPENCODE_CHILD" || RC=$?
    echo "Madar: opencode web exited (code=$RC) - restarting in 2s" >&2
    sleep 2
  done
) &
OPENCODE_SUPERVISOR=$!

# ── Register existing projects with opencode ──────────────────
# opencode only gives a directory its own project once a session is created
# there AND it can resolve a project id. Resolution order (packages/core/src/
# project.ts): git remote > cached id in <gitdir>/opencode > root commit >
# global. Seed every live /workspaces/<slug> with a git repo + a deterministic
# cached id (sha1 of the dir path) so the web UI sidebar lists each project.
# IMPORTANT: only directories belonging to LIVE projects (meta store in
# $DATA_DIR/projects/<slug>) are registered — deleted projects must never
# resurrect in opencode after a restart.
# Every curl is time-boxed so this block can never block dashboard startup.
OPCODE_URL="http://127.0.0.1:${WSD_OPENCODE_PORT:-4096}"
opencode_ready() {
  curl -fsS --max-time 2 "$OPCODE_URL/global/health" >/dev/null 2>&1
}
for i in $(seq 1 30); do
  opencode_ready && break
  sleep 1
done
if opencode_ready; then
  PROJ_JSON="$(curl -fsS --max-time 5 "$OPCODE_URL/project" 2>/dev/null || echo '[]')"
  WORKTREES="$(printf '%s' "$PROJ_JSON" | jq -r '.[].worktree' 2>/dev/null || true)"
  for m in "$DATA_DIR"/projects/*/meta.json; do
    [ -f "$m" ] || continue
    slug="$(basename "$(dirname "$m")")"
    case "$slug" in .*) continue ;; esac # skip runtime dot-dirs (.cache, .npm, ...)
    dir="/workspaces/$slug"
    [ -d "$dir" ] || continue
    if printf '%s\n' "$WORKTREES" | grep -qxF "$dir"; then
      continue
    fi
    git -C "$dir" init -q 2>/dev/null || true
    if [ -d "$dir/.git" ]; then
      printf '%s' "$(printf '%s' "$dir" | sha1sum | cut -c1-40)" > "$dir/.git/opencode"
    fi
    curl -fsS --max-time 5 -X POST "$OPCODE_URL/session?directory=$dir" \
      -H 'content-type: application/json' -d '{}' >/dev/null 2>&1 || true
  done
fi

cleanup() {
  kill "$CODE_SERVER_SUPERVISOR" "$OPENCODE_SUPERVISOR" 2>/dev/null || true
  [ -f "$CODE_SERVER_PID_FILE" ] && kill "$(cat "$CODE_SERVER_PID_FILE")" 2>/dev/null || true
  [ -f "$OPENCODE_PID_FILE" ] && kill "$(cat "$OPENCODE_PID_FILE")" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Madar: starting dashboard on 0.0.0.0:${PORT:-3000}"
cd /app/backend
exec node dist/index.js
