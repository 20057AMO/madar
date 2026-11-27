# Contributing to Madar

Read [AGENTS.md](AGENTS.md) first. It defines the product goals, house rules,
verification gates and the areas that must stay compatible.

## Local work

Requirements: Node 22+, npm and Docker Compose.

```bash
(cd backend && npm ci && npm run typecheck && npm test)
(cd frontend && npm ci && npm run typecheck && npm run build)
docker compose config -q
docker compose -f docker-compose.yml -f docker-compose.prod-tls.yml config -q
docker compose -f docker-compose.yml -f docker-compose.socket-proxy.yml config -q
bash -n scripts/install.sh
bash -n scripts/uninstall.sh
docker compose up -d --build
curl -sf http://localhost:3000/api/health
```

The backend test suite runs against the running container and is already
serial; do not parallelise it. Use `WSD_TESTING=1` only in an isolated suite
environment, never on the production rate-limit profile.

Never commit `.env`, `data/`, tokens, cookies or generated secrets. Keep changes
minimal and in one area per round; update docs when behaviour changes.

## Branches and pull requests

- Branch from `main` using a short `area/description` name.
- One concern per PR. Describe the problem, the fix, the verification commands
  and any operational/rollback note.
- Include the output of the relevant typecheck/build/test commands above. For
  compose or script changes, include the base and overlay `docker compose config -q`
  results and `bash -n` results.
- CI runs Gitleaks on every push and pull request with no `continue-on-error`.
  `GITHUB_TOKEN` is supplied by GitHub Actions; private/organization installs
  that require a Gitleaks license must have a `GITLEAKS_LICENSE` repository
  secret provisioned by a maintainer. A failed secret scan blocks the build.
- Do not commit, push, or open a PR unless the task explicitly asks for it.
- Do not open a PR with uncommitted generated files or unrelated workspace
  changes.
