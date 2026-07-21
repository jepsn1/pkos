#!/usr/bin/env bash
# Sync knowledge vault with GitHub: pull remote edits (phone/laptop Obsidian) then
# push local API-written commits. Cron'd. Rebase+autostash so an in-flight API
# write never blocks a sync. flock prevents overlapping runs.
set -uo pipefail
VAULT=/srv/data/knowledge
LOCK=/tmp/vault-sync.lock
cd "$VAULT" || exit 1

exec 9>"$LOCK"
flock -n 9 || { echo "$(date -Is) another sync running, skip"; exit 0; }

export GIT_TERMINAL_PROMPT=0

git fetch origin main --quiet || { echo "$(date -Is) fetch failed"; exit 1; }

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
