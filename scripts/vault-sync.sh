#!/usr/bin/env bash
# Sync knowledge vault with GitHub: pull remote edits (phone/laptop Obsidian) then
# push local API-written commits. Cron'd. Rebase+autostash so an in-flight API
# write never blocks a sync. flock prevents overlapping runs.
#
# Reindex-on-pull: when the pull brings note changes from a DEVICE (remote tip
# advanced since our last fetch), re-derive the search index so Obsidian edits
# become searchable. The API already indexes its own writes, so local commits
# don't trigger a reindex.
set -uo pipefail
VAULT=/srv/data/knowledge
LOCK=/tmp/vault-sync.lock
API_CONTAINER=pkos-api
cd "$VAULT" || exit 1

exec 9>"$LOCK"
flock -n 9 || { echo "$(date -Is) another sync running, skip"; exit 0; }

export GIT_TERMINAL_PROMPT=0

# Remote tip as we last knew it, then fetch to learn the true tip.
before_remote=$(git rev-parse origin/main 2>/dev/null || echo none)
git fetch origin main --quiet || { echo "$(date -Is) fetch failed"; exit 1; }
after_remote=$(git rev-parse origin/main)

# Rebase local (API) commits on top of remote; stash any uncommitted write first.
if ! git pull --rebase --autostash origin main --quiet; then
  echo "$(date -Is) REBASE CONFLICT — aborting, manual fix needed"
  git rebase --abort 2>/dev/null || true
  git stash pop 2>/dev/null || true
  exit 1
fi

if git push origin main --quiet; then
  echo "$(date -Is) synced"
else
  echo "$(date -Is) push failed"
  exit 1
fi

# Reindex only if a device advanced the remote AND touched markdown notes.
if [ "$before_remote" != "$after_remote" ]; then
  if git diff --name-only "$before_remote" "$after_remote" 2>/dev/null | grep -q '\.md$'; then
    echo "$(date -Is) device changes pulled — reindexing"
    if docker exec "$API_CONTAINER" node apps/api/dist/scripts/rebuild-index.js 2>&1 \
        | grep -i "rebuild-index:"; then
      echo "$(date -Is) reindex done"
    else
      echo "$(date -Is) reindex FAILED"
    fi
  fi
fi
