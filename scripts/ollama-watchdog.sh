#!/usr/bin/env bash
# Ollama ROCm wedge watchdog. Known flake on gfx1030: a runner (chat or embed)
# hangs forever — every request times out (pkos chats 500) until the model is
# unloaded. Restarting the container is NOT needed; keep_alive:0 unload is the
# proven recovery (see .claude/skills/verify/SKILL.md).
#
# Probes both runners with a 90s budget: a healthy box answers in <5s, a busy
# box queued behind a real generation still answers well within 90s — only a
# true wedge times out. On wedge: unload both models (they reload lazily).
# Cron: */3 * * * *  (installed in marcus's crontab; logs /srv/logs/ollama-watchdog.log)
set -u
OLLAMA="${OLLAMA_URL:-http://127.0.0.1:11434}"

gen=$(curl -s -m 90 -o /dev/null -w '%{http_code}' "$OLLAMA/api/generate" \
  -d '{"model":"qwen3:14b","prompt":"ok","stream":false,"think":false,"options":{"num_predict":2}}' || echo 000)
emb=$(curl -s -m 90 -o /dev/null -w '%{http_code}' "$OLLAMA/api/embed" \
  -d '{"model":"nomic-embed-text","input":"ok"}' || echo 000)

if [[ "$gen" != 200 || "$emb" != 200 ]]; then
  echo "$(date -Is) WEDGE gen=$gen embed=$emb — unloading models"
  curl -s -m 10 "$OLLAMA/api/generate" -d '{"model":"qwen3:14b","keep_alive":0}' >/dev/null || true
  curl -s -m 10 "$OLLAMA/api/generate" -d '{"model":"nomic-embed-text","keep_alive":0}' >/dev/null || true
fi
