# pkos — Personal Knowledge Operating System

Self-hosted, AI-native personal knowledge system. One assistant, private data, designed to grow for years. See issue #1 (PRD).

## Design

- Contained app at `/srv/apps/pkos` per jepsn1/infra conventions — own compose, joins external `web` network, own `pkos` database in shared `infra-postgres` (pgvector).
- Canonical knowledge = markdown in the separate `jepsn1/knowledge` vault repo (data outlives software). Postgres holds only derived data: metadata, embeddings, graph — rebuildable from the vault.
- LLM: local Ollama (Qwen) on the RX 6900 XT via ROCm, behind a provider interface.
- Exposure: Tailscale-only. No public domain.

## Layout (planned, mirrors biblestdy)

```
apps/api        NestJS + Drizzle
apps/web        (phase 2) React SPA — phase 1 uses Open WebUI
apps/worker     transcription/embedding jobs (whisper)
packages/       shared TS types
```

## Services

`docker-compose.yml`:

- `pkos-ollama` — ollama/ollama:rocm, GPU via /dev/kfd + /dev/dri, models in /srv/data/ollama, dev access 127.0.0.1:11434
