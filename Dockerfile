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
    && code-server --install-extension Gruntfuggly.todo-tree

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

# code-server default settings (dark theme, auto-save, format-on-save, etc.)
COPY code-server-settings.json /root/.config/code-server/User/settings.json

# Entrypoint — strip any CR characters so the script works even if the
# build context was checked out with CRLF line endings (Windows clones
# without .gitattributes applied, zip uploads, etc.)
COPY backend/docker/entrypoint.sh /app/entrypoint.sh
RUN sed -i 's/\r$//' /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# opencode SQLite purge helper (boot-time + runtime project deletes)
COPY backend/docker/opencode-purge.py /app/opencode-purge.py
RUN sed -i 's/\r$//' /app/opencode-purge.py

EXPOSE 3000 8100 4096

CMD ["/app/entrypoint.sh"]
