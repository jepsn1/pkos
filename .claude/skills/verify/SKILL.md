---
name: verify
description: Drive pkos-api end-to-end on prod (health, /v1 SSE streaming, ollama probes)
---

# Verifying pkos-api on this host

- Deploy just the api: `cd /srv/apps/pkos && docker compose up -d --build api` (~1 min). Never touch pkos-ollama/webui/worker.
- Health: `curl http://100.114.149.55:3002/api/health` (200 = db+vector+ollama ok).
- Auth key: `source /srv/apps/pkos/.env` → `$OPENAI_COMPAT_API_KEY`; api URL `http://$TAILSCALE_IP:3002`.
- SSE stream w/ timing: `curl -sN -X POST .../v1/chat/completions -H "authorization: Bearer $OPENAI_COMPAT_API_KEY" -d '{"model":"pkos","stream":true,"messages":[...]}'` piped to a `while read` loop stamping `date +%s.%N`. Expect: role chunk, per-token deltas (~22ms apart, first ~1-3s), Sources footer delta, stop, `data: [DONE]`.
- Ollama direct (host): `curl 127.0.0.1:11434/api/chat|/api/embed|/api/ps`. Container logs: `docker logs pkos-ollama` (GIN lines show per-request timing; api = 172.18.0.7, host = 172.18.0.1).

## Gotcha: nomic embed runner wedge (ROCm)

`/api/embed` can hang until client timeout (GIN `400 | 1m59s`) while `/api/chat` works — wedges every chat via the retrieval embed, looks like an LLM/timeout bug but is not. Unwedge WITHOUT restarting the container:
`curl 127.0.0.1:11434/api/generate -d '{"model":"nomic-embed-text","keep_alive":0}'` (unload), then retry one embed; may need 2 attempts (a queued background embed can re-wedge the fresh runner). Verify with a 20s-timeout embed probe before blaming the change under test.
