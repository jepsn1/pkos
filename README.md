# pkos — Personal Knowledge Operating System

Self-hosted, AI-native personal knowledge system. One assistant, private data, designed to grow for years. See issue #1 (PRD).

## Design

- Contained app at `/srv/apps/pkos` per jepsn1/infra conventions — own compose, joins external `web` network, own `pkos` database in shared `infra-postgres` (pgvector).
- Canonical knowledge = markdown in the separate `jepsn1/knowledge` vault repo (data outlives software). Postgres holds only derived data: metadata, embeddings, graph — rebuildable from the vault via `pnpm --filter @pkos/api rebuild-index`.
- Knowledge API: `POST /api/knowledge` (ingest → vault file + commit + embedded db row), `GET /api/knowledge[/:id]`, `GET /api/search?q=` (pgvector cosine ranking, ollama `nomic-embed-text`). Details: `AGENTS.md`.
- LLM: local Ollama (Qwen) on the RX 6900 XT via ROCm, behind a provider interface.
- Exposure: Tailscale-only. No public domain.

## Layout (mirrors biblestdy)

```
apps/api        NestJS + Drizzle + Vitest (dev: localhost:3002, prefix /api)
apps/web        (phase 2) React SPA — phase 1 uses Open WebUI
apps/worker     (planned) transcription/embedding jobs (whisper)
packages/shared shared TS types
```

Dev + deploy workflow: `AGENTS.md`.

## Services

`docker-compose.yml`:

- `pkos-api` — built from `Dockerfile`, healthcheck on `/api/health`, published only on the host's tailscale IP (`TAILSCALE_IP` in `.env`), port 3002
- `pkos-ollama` — ollama/ollama:rocm, GPU via /dev/kfd + /dev/dri, models in /srv/data/ollama, dev access 127.0.0.1:11434
