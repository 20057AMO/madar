#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${WSD_DATA_DIR:-/app/data}"
IDE_PASSWORD_FILE="$DATA_DIR/ide-password"

# Resolve the IDE password: explicit env > persisted > generated
if [ -n "${WSD_IDE_PASSWORD:-}" ]; then
  IDE_PASSWORD="$WSD_IDE_PASSWORD"
else
  mkdir -p "$DATA_DIR"
  if [ -f "$IDE_PASSWORD_FILE" ]; then
    IDE_PASSWORD="$(cat "$IDE_PASSWORD_FILE")"
  else
    IDE_PASSWORD="$(head -c 24 /dev/urandom | base64 | tr -d '+/=' | cut -c1-16)"
    printf '%s' "$IDE_PASSWORD" > "$IDE_PASSWORD_FILE"
  fi
fi

# ── Web IDE ───────────────────────────────────────────────────
echo "Madar: starting supervised code-server IDE on 0.0.0.0:8080 (no auth)"
# NOTE: code-server reads the PORT env var and it overrides --bind-addr,
# so unset it (PORT is used by the dashboard node app).
# Auth disabled (--auth none) — safe in local Docker environment.
# Supervised restart loop: same pattern as opencode below — if code-server
# crashes or is killed (e.g. version update), the loop revives it within ~2s.
# PID of the live child is published in $DATA_DIR/code-server.pid for the
# backend to target precisely.
CODE_SERVER_PID_FILE="$DATA_DIR/code-server.pid"
rm -f "$CODE_SERVER_PID_FILE"
(
  while true; do
    env -u PORT code-server --auth none --disable-telemetry --disable-update-check \
      --bind-addr 0.0.0.0:8080 /workspaces \
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

echo "Madar: starting supervised opencode web on 0.0.0.0:${WSD_OPENCODE_PORT:-4096} (cwd /workspaces)"
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
      opencode web --hostname 0.0.0.0 --port "${WSD_OPENCODE_PORT:-4096}" \
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
OPCODE_URL="http://localhost:${WSD_OPENCODE_PORT:-4096}"
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
