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
- LLM: `pkos-ollama` container (ROCm, RX 6900 XT), `127.0.0.1:11434` dev / `pkos-ollama:11434` prod. Models: qwen3:14b, qwen3:8b, nomic-embed-text (embeddings, 768-dim).

## Knowledge (slice 3, issue #4)

- Vault = canonical: markdown + YAML frontmatter (title, source, tags, summary, importance, created) in `/srv/data/knowledge` (checkout of jepsn1/knowledge). `VAULT_PATH` env overrides (default `/srv/data/knowledge`; `/vault` in prod container). Every api write commits in the vault repo.
- DB = derived only: `knowledge_items` (path unique, metadata, 768-dim pgvector embedding, hnsw cosine index). Rebuildable any time: `pnpm --filter @pkos/api rebuild-index` — wipes table, re-derives rows + embeddings from vault files. Needs db + ollama up.
- Embeddings: ollama `nomic-embed-text` via `POST /api/embed`, behind `EmbeddingProvider` (`EMBEDDING_MODEL` env overrides model). Embeds title+summary+body. Pull once: `docker exec pkos-ollama ollama pull nomic-embed-text`.
- Endpoints (prefix `/api`):
  - `POST /knowledge` `{title, markdown, source?, tags?, summary?, importance?, folder?}` → vault file (slugged, suffixed on collision) + vault commit + db row + embedding. Default folder `articles`.
  - `GET /knowledge` — list rows; `GET /knowledge/:id` — row + body read from vault.
  - `GET /search?q=&limit=` — cosine-ranked hits `{id, path, title, summary, score}` (limit ≤50, default 10).
- Prod vault access: compose mounts `/srv/data/knowledge` rw at `/vault`, container runs as `user: 1000:1000` (host uid) so commits stay host-owned and host-side git keeps working; git identity/safe.directory passed per-command with `-c` flags (no config in image), `HOME=/tmp` for git. Vault pushes to GitHub stay manual/host-side.

## Chat (slice 4, issue #5)

- `LlmProvider` iface (fake in tests) + Ollama impl: ollama `POST /api/chat`, `LLM_MODEL` env (default `qwen3:14b`), `think:false`, 120s timeout, `<think>` stripped anyway.
- Conversations = PRIMARY data in postgres (`conversations` + `messages`, citations jsonb) — not vault-derived, not rebuildable.
- Flow: embed query → top-5 cosine search → drop hits below `RETRIEVAL_MIN_SCORE` (default 0.5; on-topic ≈0.6–0.75, nonsense ≤0.44) → system prompt w/ item paths + bodies (read from vault), answer-ONLY-from-items + cite-paths instructions; zero hits → honest "nothing relevant" instruction, empty citations.
- Endpoints (prefix `/api`):
  - `POST /chat` `{message, conversationId?}` → `{conversationId, answer, citations: [{path, title, score}]}`. No conversationId → new conversation (title = first message, truncated 80 chars); continuation replays prior messages to the LLM.
  - `GET /conversations` — list, most recently updated first; `GET /conversations/:id` — conversation + messages.

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
