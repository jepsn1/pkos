# pkos — agent notes

Personal Knowledge Operating System. PRD: issue #1; slices: issues #2–#12. Server manual: jepsn1/infra `AGENTS.md` (read before infra-touching changes). Design notes: `README.md`.

## Layout

pnpm 11 monorepo (mirrors biblestdy): `apps/api` (NestJS + Drizzle + Vitest, prefix `/api`), `packages/shared` (pure TS, CJS to `dist/` — rebuild after editing or api sees stale exports). Node ≥22 (`.nvmrc`).

## Dev (native)

- `make dev` / `pnpm dev` — builds shared, runs api on **localhost:3002** (biblestdy has 3001; dev range 3000–3999).
- `make test` / `pnpm test`, `pnpm typecheck` — must be green before commit.
- **Commit often**: checkpoint after every green iteration, never one big diff at sign-off.
- Env: `apps/api/.env` = dev (localhost hosts), root `.env` = prod (compose env_file, container hosts). Both gitignored; `.env.example` files document them.
- DB: `pkos` on shared infra-postgres (`127.0.0.1:5432` dev, `infra-postgres:5432` prod), **pgvector enabled**. Schema via Drizzle (`apps/api/src/db/schema.ts`), dev push: `pnpm --filter @pkos/api db:push`.
- LLM: `pkos-ollama` container (ROCm, RX 6900 XT), `127.0.0.1:11434` dev / `pkos-ollama:11434` prod. Models: qwen3:14b, qwen3:8b.

## Prod (docker)

- Deploy: `make deploy` in `/srv/apps/pkos` (git pull, pnpm install, `docker compose up -d --build`).
- Containers: `pkos-api` (built from `Dockerfile`) + `pkos-ollama`, both on shared external `web` network.
- **Exposure is Tailscale-only — no caddy site, no public domain.** The api port is published as `${TAILSCALE_IP}:3002:3002`; set `TAILSCALE_IP` in root `.env` to `tailscale ip -4`. NEVER bind 0.0.0.0 (docker published ports bypass UFW).
  - NOTE 2026-07-13: tailscale not yet installed on this host — `TAILSCALE_IP=127.0.0.1` placeholder until then. Side effect: prod container and native dev api both want 127.0.0.1:3002 — stop one to run the other (`docker stop pkos-api`). Goes away once the real tailscale IP is set.
- Health: `GET /api/health` → 200 with real checks (db `SELECT 1` + vector extension, ollama `GET /api/tags`); any dep down → 503 with the failing check in the body. Compose healthcheck hits it.
- Logs: `make logs`.

## Conventions

- Commits: author `jepsn1 <jepsn1@users.noreply.github.com>` via `git -c user.name=... -c user.email=...`.
- Deep modules behind small interfaces with isolated Vitest behavior tests — no DB/live API in tests (health service takes injected db/fetch fakes; the pattern to copy).
- Canonical knowledge = markdown in jepsn1/knowledge vault; Postgres holds only derived, rebuildable data (see README).
