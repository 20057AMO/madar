# Madar main container
# Dashboard (3000) + shared code-server IDE (8100) + opencode web (4096) + qwen3:30b chat (Ollama Cloud).

# ---- Stage 1: build frontend ----
FROM node:22-bookworm AS frontend-build
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --no-fund --no-audit
COPY frontend ./
RUN npm run build

# ---- Stage 2: build backend ----
FROM node:22-bookworm AS backend-build
WORKDIR /src
COPY backend/package.json backend/package-lock.json* ./
RUN npm ci --no-fund --no-audit
COPY backend ./
RUN npm run build

# ---- Stage 3: runtime ----
FROM node:22-bookworm

# Docker CLI (to manage project containers through the mounted socket)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git docker.io jq \
        python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# code-server — unified Web IDE rooted at /workspaces
ARG CODE_SERVER_VERSION=4.96.4
RUN curl -fsSLo /tmp/code-server.deb \
      "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server_${CODE_SERVER_VERSION}_amd64.deb" \
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

# opencode CLI (project building agent, web UI on port 4096) — pinned
# baseline; the Studio Update button upgrades it inside the running container.
RUN npm install -g opencode-ai@1.18.22 --no-fund --no-audit

# Headless container: opencode tries to auto-open a browser via xdg-open on
# `opencode web`; provide a no-op stub so it never errors out.
RUN printf '#!/bin/sh\nexit 0\n' > /usr/local/bin/xdg-open && chmod +x /usr/local/bin/xdg-open

WORKDIR /app

# App
COPY --from=backend-build /src/package*.json ./backend/
COPY --from=backend-build /src/dist ./backend/dist
RUN cd backend && npm ci --omit=dev --no-fund --no-audit

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
