# Madar main container
# Dashboard (3000) + shared code-server IDE (8100) + opencode web (4096) + qwen3:30b chat (Ollama Cloud).

# ---- Stage 1: build frontend ----
FROM node:22-bookworm AS frontend-build
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --no-fund --no-audit
COPY frontend ./
RUN npm run build

# ---- Stage 2: build backend ----
FROM node:22-bookworm AS backend-build
WORKDIR /src
COPY backend/package.json backend/package-lock.json* ./
RUN npm install --no-fund --no-audit
COPY backend ./
RUN npm run build

# ---- Stage 3: runtime ----
FROM node:22-bookworm

# Docker CLI (to manage project containers through the mounted socket)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git docker.io jq \
        python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# IDE hardening — the SINGLE enforcement point for the code-server image layer
# (closure restore + keep-list slimming + @github stubs + invariant checks).
# Installed before the code-server layer so `capture` can snapshot the closure
# while the pristine deb payload is still on disk.
COPY backend/docker/ide-hardening.sh /usr/local/share/madar/ide-hardening.sh
RUN sed -i 's/\r$//' /usr/local/share/madar/ide-hardening.sh && chmod +x /usr/local/share/madar/ide-hardening.sh

# code-server — unified Web IDE rooted at /workspaces.
# Defaults to the newest release resolved at build time via the GitHub API; pin
# a specific version with --build-arg CODE_SERVER_VERSION=<ver> for
# reproducible builds. The resolved tag is regex-guarded (semver-shaped) and
# its SHA-256 digest — published by the release — is verified before install;
# on API failure/rate-limit it falls back to the last-known-good 4.96.4, so the
# build never fails on resolve.
# NOTE: BuildKit caches this layer — rebuild with --no-cache to re-resolve latest.
ARG CODE_SERVER_VERSION=latest
RUN if [ "${CODE_SERVER_VERSION}" = "latest" ]; then \
      RELEASE_JSON="$(curl -fsSL https://api.github.com/repos/coder/code-server/releases/latest || true)"; \
      CODE_SERVER_VERSION="$(printf '%s' "$RELEASE_JSON" | jq -r '.tag_name // empty' | sed 's/^v//' || true)"; \
      if ! printf '%s' "$CODE_SERVER_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-.a-z0-9]+)?$'; then \
        echo "warning: invalid latest code-server version '$CODE_SERVER_VERSION', falling back to 4.96.4" >&2; \
        CODE_SERVER_VERSION=4.96.4; \
      fi; \
    fi \
    && CS_SHA256="$(if [ -n "${RELEASE_JSON:-}" ]; then printf '%s' "$RELEASE_JSON" | jq -r --arg v "$CODE_SERVER_VERSION" '.assets[] | select(.name == "code-server_"+$v+"_amd64.deb") | .digest // empty' || true; fi)" \
    && echo "Installing code-server ${CODE_SERVER_VERSION}" \
    && curl -fsSLo /tmp/code-server.deb \
      "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server_${CODE_SERVER_VERSION}_amd64.deb" \
    && if [ -n "${CS_SHA256}" ]; then \
         echo "Verifying code-server sha256 digest: ${CS_SHA256}"; \
         echo "${CS_SHA256#sha256:}  /tmp/code-server.deb" | sha256sum -c -; \
       fi \
    && dpkg -i /tmp/code-server.deb \
    && /usr/local/share/madar/ide-hardening.sh capture \
    && test -n "$(ls -A /opt/madar/ide-builtin 2>/dev/null)" \
    && echo "captured built-in closure: $(ls -1 /opt/madar/ide-builtin | wc -l) dirs" \
    && rm -f /tmp/code-server.deb

# VS Code Extensions
RUN code-server --install-extension dbaeumer.vscode-eslint \
    && code-server --install-extension esbenp.prettier-vscode \
    && code-server --install-extension eamodio.gitlens \
    && code-server --install-extension formulahendry.auto-rename-tag \
    && code-server --install-extension christian-kohler.path-intellisense \
    && code-server --install-extension bradlc.vscode-tailwindcss \
    && code-server --install-extension ms-python.python \
    && code-server --install-extension rust-lang.rust-analyzer \
    && code-server --install-extension usernamehw.errorlens \
    && code-server --install-extension streetsidesoftware.code-spell-checker \
    && code-server --install-extension PKief.material-icon-theme \
    && code-server --install-extension ms-vscode.references-view

# Todo Tree — PINNED + digest-verified, and deliberately NOT installed here.
# `--install-extension Gruntfuggly.todo-tree` resolved `latest`, unpinned and
# unverified, two lines below a digest-verified code-server fetch — inconsistent,
# and unreproducible across rebuilds. The VSIX is fetched once into
# /opt/madar/ide-vsix and the entrypoint boot sync installs it from that LOCAL
# file (no network at boot), letting code-server write its own registry entry.
# `--compressed` is mandatory: the marketplace answers with `content-encoding:
# gzip`, so without it curl stores the COMPRESSED bytes and the digest below
# (taken from the real artifact) can never match.
ARG TODO_TREE_VERSION=0.0.215
ARG TODO_TREE_SHA256=58af49e93be63022e8a9e296879155a7598d0173d656646f8bf885b8b58cca53
RUN mkdir -p /opt/madar/ide-vsix \
    && curl -fsSL --compressed -o "/opt/madar/ide-vsix/gruntfuggly.todo-tree-${TODO_TREE_VERSION}.vsix" \
      "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/gruntfuggly/vsextensions/todo-tree/${TODO_TREE_VERSION}/vspackage" \
    && echo "${TODO_TREE_SHA256}  /opt/madar/ide-vsix/gruntfuggly.todo-tree-${TODO_TREE_VERSION}.vsix" | sha256sum -c - \
    && echo "pinned todo-tree ${TODO_TREE_VERSION} ($(stat -c%s /opt/madar/ide-vsix/gruntfuggly.todo-tree-${TODO_TREE_VERSION}.vsix) bytes)"

# Built-in VS Code extensions layer (first-frame load time AND RAM): the stock
# bundle ships ~130 MB of unusable Copilot payload — code-server 4.138 ships four
# `@github` packages, and the ~127 MB `@github/copilot-sdk-linux-x64` is the one a
# name-based stub list never touched. `ide-hardening.sh apply` replaces every
# shipped `@github` package structurally (spawned ⇒ `process.exit(0)`, imported ⇒
# `module.exports={}`) and prunes outside the keep-list after restoring the
# captured dependency closure (vscode.git declares
# extensionDependencies:["vscode.git-base"], so a name-based delete-list silently
# removed the Git extension's only dependency and Source Control hung on
# "Scanning folder for Git repositories..." forever), pruning everything outside
# the keep-list, and rewrites the @github tree as stubs. A KEEP-list rather than
# a delete-list is what makes this version-bump-safe: the previous rm list used
# unprefixed names that never matched the real dirs (ms-vscode.js-debug-companion,
# ms-vscode.vscode-js-profile-table), so 5.6 MB survived every build.
RUN /usr/local/share/madar/ide-hardening.sh apply

# opencode CLI (project building agent, web UI on port 4096) — resolved at
# build time to the newest version and gated to the supported major: the
# backend's SUPPORTED_MAJORS=[1] (backend/src/services/opencode-api.ts) only
# speaks v1, so a major-2 install would break agents/chat/Studio on the next
# rebuild. A failed lookup or a non-1 major pins the last-known-good 1.18.22.
# The Studio Update button still upgrades inside the running container.
RUN V="$(npm view opencode-ai version 2>/dev/null || true)" \
  && case "$V" in 1.*) ;; *) echo "warning: opencode $V outside supported major 1, pinning 1.18.22" >&2; V=1.18.22;; esac \
  && npm install -g opencode-ai@$V --no-fund --no-audit

# Headless container: opencode tries to auto-open a browser via xdg-open on
# `opencode web`; provide a no-op stub so it never errors out.
RUN printf '#!/bin/sh\nexit 0\n' > /usr/local/bin/xdg-open && chmod +x /usr/local/bin/xdg-open

WORKDIR /app

# App
COPY --from=backend-build /src/package*.json ./backend/
COPY --from=backend-build /src/dist ./backend/dist
RUN cd backend && npm install --omit=dev --no-fund --no-audit

# Frontend (served statically by the backend)
COPY --from=frontend-build /src/dist ./frontend/dist

# opencode configuration + preset subagents, skills & slash commands (managed via /opencode-studio)
COPY opencode.json /root/.config/opencode/opencode.json
COPY opencode/agents/ /root/.config/opencode/agents/
COPY opencode/skills/ /root/.config/opencode/skills/
COPY opencode/command/ /root/.config/opencode/command/
RUN find /root/.config/opencode/agents /root/.config/opencode/skills /root/.config/opencode/command -type f \( -name '*.md' -o -name 'SKILL.md' \) -exec sed -i 's/\r$//' {} +

# code-server default settings (dark theme, auto-save, format-on-save, etc.).
#
# Baked at /opt/madar/ide-config — an UNSHADOWED path. The code-server-data
# VOLUME mounts the user-data-dir /root/.local/share/code-server, so a copy
# written there at image-build time is simply invisible at runtime: an existing
# volume keeps the settings.json it was seeded with, which is why the volume
# silently lacked workbench.startupEditor / update.mode / the rest while the
# docs claimed they were in effect. entrypoint.sh copies the managed copy into
# the volume on every boot (stamped, idempotent) and backs the previous file up.
#
# The seed below lands in the user-data-dir on purpose: code-server runs with no
# --user-data-dir, so USER settings resolve to <user-data-dir>/User/settings.json
# and NOT to ~/.config/code-server/User/settings.json (that tree only holds
# code-server's own config.yaml). Getting this backwards made every managed key
# inert at runtime while the boot log reported a successful sync.
COPY code-server-settings.json /opt/madar/ide-config/User/settings.json
RUN mkdir -p /root/.local/share/code-server/User /root/.config/code-server/User \
    && cp /opt/madar/ide-config/User/settings.json /root/.local/share/code-server/User/settings.json \
    # No `bind-addr`: code-server defaults to 127.0.0.1:8080, the same loopback
    # bind the supervisor passes on the CLI. `auth: none` mirrors `--auth none`;
    # a seeded volume still carries the old `auth: password` + hash, and the
    # boot sync replaces this file.
    && printf 'auth: none\ncert: false\n' > /opt/madar/ide-config/config.yaml

# Entrypoint — strip any CR characters so the script works even if the
# build context was checked out with CRLF line endings (Windows clones
# without .gitattributes applied, zip uploads, etc.)
COPY backend/docker/entrypoint.sh /app/entrypoint.sh
RUN sed -i 's/\r$//' /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# opencode SQLite purge helper (boot-time + runtime project deletes)
COPY backend/docker/opencode-purge.py /app/opencode-purge.py
RUN sed -i 's/\r$//' /app/opencode-purge.py

# LAST, so a broken image fails the build instead of shipping: every invariant
# (no Copilot dir, stubbed sidecar, resolvable extensionDependencies closure,
# built-in dir count in band) is asserted against the FINAL tree.
RUN /usr/local/share/madar/ide-hardening.sh verify

EXPOSE 3000 8100 4096

CMD ["/app/entrypoint.sh"]
