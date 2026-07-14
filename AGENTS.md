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
- Graph-augmented retrieval (slice 9): after the vector top-k, 1-hop graph neighbors of the hits join the grounded context labeled with their relationship (`related_to: <title> (<path>)`, incoming edges as `<type> (incoming)`); neighbors that are already hits get the label but no repeated body. Graph-sourced citations: `{path, title, via: 'graph', relation}` (no score).

## Graph (slice 9, issue #10)

- Typed edges between knowledge items; types: `related_to, references, supports, contradicts, parent, child, mentioned_in, written_by` (pg enum).
- Vault stays canonical: an edge lives as `relationships: [{type, path}]` in the **from-item's** frontmatter; every create/delete rewrites that file + vault commit (`link a -[type]-> b` / `unlink ...`). Db table `relationships` (from_item, to_item, type; unique triple; FK cascade) is derived: `rebuild-index` second pass restores rows from frontmatter (paths → ids, unresolvable edges warned + skipped).
- Traversal: undirected n-hop walk via recursive CTE (`DrizzleRelationshipRepo.neighborhood`), depth-bounded + cycle-safe; edges in the response stay typed + directional.
- Endpoints (prefix `/api`):
  - `POST /relationships` `{fromPath|fromId, toPath|toId, type}` → edge row + `fromPath`/`toPath`; 409 on duplicate triple, 400 bad type/self-link, 404 unknown item.
  - `DELETE /relationships/:id` → removes frontmatter entry + row.
  - `GET /knowledge/:id/graph?depth=` — n-hop neighborhood `{root, depth, nodes: [{id, path, title, summary, depth}], edges: [{id, fromId, fromPath, toId, toPath, type}]}`; depth default 1, capped at 3.

## Save conversation → knowledge (slice 8, issue #9)

- `POST /conversations/:id/save` `{folder?, force?}` → `{itemId, path, title}`. `SaveService` sends ALL messages to the LLM (strict-JSON distill prompt: title/summary/tags/markdown article — insights + conclusions, NOT a transcript), then `KnowledgeService.ingest` (vault file + commit + row + embedding). Default folder `conversations`.
- Provenance both ways: article frontmatter `source: conversation:<id>` (canonical); `conversations.saved_item_id` FK → knowledge_items (nullable, on delete set null).
- Resave → 409 w/ existing `{itemId, path}`; `force:true` → new file (slug suffix) + pointer moves. Unsaved conversations = plain history, untouched.
- `GET /conversations` list rows include `savedItemId` + `savedPath` (left join).
- `rebuild-index` wipes knowledge_items (nulls pointers via FK), then re-links `saved_item_id` from `source: conversation:*` frontmatter — provenance survives rebuilds. Force-resaved convs: newest item wins.

## Frontend: Open WebUI + OpenAI-compat surface (slice 5, issue #6)

- Api exposes an OpenAI-compatible surface at **root `/v1`** (excluded from the `/api` prefix in `main.ts` — OpenAI clients hardcode `/v1`), module `apps/api/src/openai-compat/`:
  - `GET /v1/models` — single model, id `pkos`.
  - `POST /v1/chat/completions` — OpenAI request → `ChatService.answer()` (retrieval + grounded qwen3 answer) → OpenAI response. Citations appended to assistant content as a markdown `**Sources:**` footer (`path — title (score)`). `stream:true` supported: SSE with the finished answer as one content chunk (underlying LLM call is non-streaming).
  - Auth: `Authorization: Bearer $OPENAI_COMPAT_API_KEY` (env, both .env files; unset ⇒ fails closed, all 401).
  - **Stateless by design**: OpenAI clients resend full history every turn; last user msg drives retrieval, prior user/assistant turns replayed to the LLM, client system prompts dropped (grounding owns the system slot). Nothing written to `conversations`/`messages` — those belong to native `/api/chat`. Open WebUI persists its own chats in /srv/data/webui.
- `pkos-webui` container (ghcr.io/open-webui/open-webui:main): `OPENAI_API_BASE_URL=http://pkos-api:3002/v1`, `OPENAI_API_KEY=$OPENAI_COMPAT_API_KEY`, `ENABLE_OLLAMA_API=false` (never raw ollama), published `${TAILSCALE_IP}:8081:8080`, state volume /srv/data/webui.
- **First login**: first browser visit to :8081 shows a signup form — that account becomes admin; later signups need admin approval. Model `pkos` is preselected (only one).

## Sermons (slice 7, issue #7)

- Flow: `POST /api/sermons` multipart `file` (mp3/m4a/wav only, else 400) → audio saved under `UPLOADS_PATH` (random name; db stores path relative to it) → `sermon_jobs` row status `queued` → python worker transcribes → transcript on the job + ~500-word `transcript_chunks` (timestamps + 768-dim embeddings, hnsw cosine index) → status `done` (failures: `error` + message).
- `UPLOADS_PATH`: dev = gitignored `<repo>/.uploads` (default), prod = `/uploads` (compose mounts `/srv/data/uploads/pkos`; create host dir once, chown 1000:1000).
- Endpoints (prefix `/api`): `POST /sermons` → job row; `GET /sermons` — jobs newest first (no transcript); `GET /sermons/:id` — full job incl. transcript when done.
- `GET /search` now returns a **union**: knowledge items (`type: "knowledge"`) + sermon chunks (`type: "sermon"`, with `jobId`, `text`, `seq`, `startSec`/`endSec`), merged by cosine score, one `limit`.
- Worker (`apps/worker`, python): polls `sermon_jobs` with `FOR UPDATE SKIP LOCKED`; faster-whisper (`WHISPER_MODEL` default `small`, cpu/int8, first job downloads ~460MB into `whisper-cache` volume); embeds chunks via ollama `nomic-embed-text`. Restart-safe: `processing` rows older than `STALE_PROCESSING_MIN` (default 60) are re-queued. Env: `DATABASE_URL`, `UPLOADS_PATH`, `OLLAMA_URL`, `POLL_INTERVAL_SEC` (default 5).
- Worker dev: `python3 -m venv --without-pip apps/worker/.venv` + get-pip (host python3.14 lacks ensurepip), `pip install -r apps/worker/requirements-dev.txt`, run `python worker.py` with env set; tests `python -m pytest apps/worker` (fakes only — no whisper download, no db).
- Prod: compose service `worker` (container `pkos-worker`, built from `apps/worker`), same `.env`.

## Sermon enrichment (issue #8)

- Worker stays transcription-only; enrichment is api-side (`src/sermons/enrichment.*`). Trigger: Nest interval poller (`ENRICH_POLL_INTERVAL_MS`, default 15s, 0 disables) claims `done` jobs without an article via atomic status flip + `FOR UPDATE SKIP LOCKED` — status chain `done → enriching → enriched | enrich_error` (append-only enum; worker untouched, it only claims `queued`/stale `processing`).
- Generation: qwen3 (`LLM_PROVIDER`) strict-JSON prompt → `{title, summary, themes, bible_references, action_points, key_quotes, tags}`, lenient parse (fences/prose/camelCase tolerated). Transcripts over `ENRICH_INPUT_MAX_CHARS` (default 24000) get a per-piece condense pass first.
- Article via `KnowledgeService.ingest` → `faith/sermons/YYYY-MM-DD Title - Speaker.md` (explicit-filename seam in `VaultService.writeNote`; date/speaker/title from upload metadata, fallback today + Unknown, user title wins over LLM suggestion). Frontmatter `source: sermon:<jobId>` (canonical provenance), tags = LLM tags + Bible refs as `ref:book-chapter` (e.g. `ref:john-3`, verses dropped). Body: summary/themes/refs/action points/key quotes + pointer to the job (transcript stays on the job row).
- Idempotent: job stores `article_item_id` (FK set null) + `article_path`; enriched jobs are never re-claimed. `rebuild-index` re-links `article_item_id` from `source: sermon:*` frontmatter. Failure → `enrich_error` + message on the job, transcript intact.
- Endpoints (prefix `/api`): `POST /sermons` also takes multipart text fields `{speaker?, date? (YYYY-MM-DD), title?}`; `GET /sermons[/:id]` rows now carry `speaker/sermonDate/title/articleItemId/articlePath/enrichError`; `POST /sermons/:id/enrich` = manual (re)trigger (409 when already enriched w/ `{itemId, path}`, 409 when no finished transcript; runs synchronously).

## Fitness (slice 11, issue #11)

- Schema (PRIMARY, not vault-derived): `workouts` (date, notes) + `workout_sets` (exercise lowercase-normalized, set_no, reps, weight_kg null = bodyweight), `body_metrics` (date, weight_kg?, calories?, protein_g? — db check ≥1 non-null), `goals`.
- Logging/querying happens through `POST /api/chat` via LLM tool calls (ollama-native `tools` on /api/chat). `LlmProvider.chat(messages, tools?)`: plain string without tools (legacy), `LlmReply {content, toolCalls}` with them — backward compatible. Tool loop in `ChatService`, max 4 rounds; bad tool args go back to the model as `{error}` instead of throwing.
- Tools (`src/fitness/fitness-tools.service.ts`, executors behind `FITNESS_REPO` — parameterized queries only, model never writes SQL):
  - `log_workout` `{date?, exercises: [{exercise, sets: [{reps, weight_kg?}]}], notes?}`
  - `log_body_metric` `{date?, weight_kg?, calories?, protein_g?}` (≥1 metric)
  - `query_fitness` `{query: metric_avg|exercise_progression|weekly_volume|recent_workouts, metric?, since?, until?, exercise?, limit?}` — metric_avg defaults to last 7 days incl. today; weeks start Monday.
- Planner: system prompt appends `FitnessToolsService.routingPrompt()` — routing rules + today's date (qwen3 invents dates otherwise) + "5x5 = five set entries" (it collapsed AxB to one set otherwise). Fitness turns → tools; everything else → existing vector retrieval, unchanged.
- REST fallback (prefix `/api`): `GET /fitness/workouts` (recent 50 w/ sets), `GET /fitness/metrics` (date desc).
- `LLM_TIMEOUT_MS` env overrides the 120s ollama timeout (tool loops = several LLM round trips; shared ollama queues).

## Prod (docker)

- Deploy: `make deploy` in `/srv/apps/pkos` (git pull, pnpm install, `docker compose up -d --build`).
- Containers: `pkos-api` (built from `Dockerfile`) + `pkos-webui` (port 8081) + `pkos-ollama`, all on shared external `web` network.
- **Exposure is Tailscale-only — no caddy site, no public domain.** The api port is published as `${TAILSCALE_IP}:3002:3002`; set `TAILSCALE_IP` in root `.env` to `tailscale ip -4`. NEVER bind 0.0.0.0 (docker published ports bypass UFW).
  - NOTE 2026-07-13: tailscale not yet installed on this host — `TAILSCALE_IP=127.0.0.1` placeholder until then. Side effect: prod container and native dev api both want 127.0.0.1:3002 — stop one to run the other (`docker stop pkos-api`). Goes away once the real tailscale IP is set.
- Health: `GET /api/health` → 200 with real checks (db `SELECT 1` + vector extension, ollama `GET /api/tags`); any dep down → 503 with the failing check in the body. Compose healthcheck hits it.
- Logs: `make logs`.

## Conventions

- Commits: author `jepsn1 <jepsn1@users.noreply.github.com>` via `git -c user.name=... -c user.email=...`.
- Deep modules behind small interfaces with isolated Vitest behavior tests — no DB/live API in tests (health service takes injected db/fetch fakes; the pattern to copy).
- Canonical knowledge = markdown in jepsn1/knowledge vault; Postgres holds only derived, rebuildable data (see README).
