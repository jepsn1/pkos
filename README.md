# pkos — Personal Knowledge Operating System

Self-hosted, AI-native personal knowledge system. One assistant, private data, designed to grow for years. See issue #1 (PRD).

## Design

- Contained app at `/srv/apps/pkos` per jepsn1/infra conventions — own compose, joins external `web` network, own `pkos` database in shared `infra-postgres` (pgvector).
- Canonical knowledge = markdown in the separate `jepsn1/knowledge` vault repo (data outlives software). Postgres holds only derived data: metadata, embeddings, graph — rebuildable from the vault via `pnpm --filter @pkos/api rebuild-index`.
- Knowledge API: `POST /api/knowledge` (ingest → vault file + commit + embedded db row), `GET /api/knowledge[/:id]`, `GET /api/search?q=` (pgvector cosine ranking, ollama `nomic-embed-text`). Details: `AGENTS.md`.
- Chat API: `POST /api/chat` `{message, conversationId?}` — retrieval-grounded answer w/ citations `{path, title, score}`; honest "nothing relevant" when retrieval misses. Conversations persisted: `GET /api/conversations[/:id]`. Retrieval is graph-augmented: 1-hop neighbors of the vector hits join the context labeled with their relationship; graph-sourced citations carry `{via: 'graph', relation}`.
- Long-term memory: `POST /api/conversations/:id/save` — LLM distills the conversation into a vault article (frontmatter `source: conversation:<id>`), ingested like any knowledge (file + commit + embedding) so later chats retrieve it. Conversation keeps a `saved_item_id` pointer; unsaved conversations stay plain history.
- Graph API: typed edges (`related_to, references, supports, contradicts, parent, child, mentioned_in, written_by`) — `POST /api/relationships` `{fromPath|fromId, toPath|toId, type}`, `DELETE /api/relationships/:id`, `GET /api/knowledge/:id/graph?depth=` (n-hop neighborhood via recursive CTE, depth ≤3). Edges are canonical in the from-item's frontmatter (`relationships: [{type, path}]`, rewritten + committed on every change); the `relationships` table is derived and restored by `rebuild-index`.
- Sermon transcription: `POST /api/sermons` (mp3/m4a/wav upload) → queued job → python worker (`apps/worker`, faster-whisper cpu) transcribes, chunks (~500 words w/ timestamps) + embeds → `GET /api/sermons/:id` serves the transcript; chunks surface in `/api/search` as `type: "sermon"` hits. Audio under `UPLOADS_PATH` (prod `/srv/data/uploads/pkos` → `/uploads`).
- LLM: local Ollama (Qwen) on the RX 6900 XT via ROCm, behind a provider interface (`LlmProvider`, `LLM_MODEL` default `qwen3:14b`).
- Frontend phase 1: Open WebUI (`pkos-webui`) wired to the api's OpenAI-compatible surface — `GET /v1/models` (single model `pkos`) + `POST /v1/chat/completions` (bearer `OPENAI_COMPAT_API_KEY`), so chats hit pkos retrieval + citations (markdown "Sources:" footer), never raw ollama. Phone via Tailscale, port 8081.
- Exposure: Tailscale-only. No public domain.

## Layout (mirrors biblestdy)

```
apps/api        NestJS + Drizzle + Vitest (dev: localhost:3002, prefix /api)
apps/web        (phase 2) React SPA — phase 1 uses Open WebUI
apps/worker     python transcription worker (faster-whisper + ollama embeddings)
packages/shared shared TS types
```

Dev + deploy workflow: `AGENTS.md`.

## Services

`docker-compose.yml`:

- `pkos-api` — built from `Dockerfile`, healthcheck on `/api/health`, published only on the host's tailscale IP (`TAILSCALE_IP` in `.env`), port 3002
- `pkos-webui` — ghcr.io/open-webui/open-webui:main, state in /srv/data/webui, talks to `pkos-api:3002/v1` with `OPENAI_COMPAT_API_KEY`, tailscale-only port 8081. First browser visit creates the admin account.
- `pkos-worker` — built from `apps/worker`, polls sermon jobs, survives restarts (stale `processing` re-queued)
- `pkos-ollama` — ollama/ollama:rocm, GPU via /dev/kfd + /dev/dri, models in /srv/data/ollama, dev access 127.0.0.1:11434
