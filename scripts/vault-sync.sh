#!/usr/bin/env bash
# Sync the knowledge vault with GitHub so Obsidian (Mac + iPhone) sees AI notes.
#
# pkos-api commits EVERY note into /srv/data/knowledge but never pushes
# (AGENTS.md: "Vault pushes to GitHub stay manual/host-side"). Without a push,
# Obsidian-on-iPhone (which clones jepsn1/knowledge over GitHub) never sees new
# assistant notes. This closes that gap HOST-SIDE: pull Obsidian edits (rebase
# under the local api commits), then push. Read-only no-op when nothing changed.
#
# Host-side on purpose: pushing needs GitHub creds. The host has them via
# `gh auth git-credential` (~/.gitconfig); the api container does NOT (HOME=/tmp,
# no config in image, runs as 1000:1000). Never push from inside the container.
#
# Cron (marcus's crontab):  * * * * * /srv/apps/pkos/scripts/vault-sync.sh >> /srv/logs/vault-sync.log 2>&1
# flock keeps runs from overlapping the every-minute tick.
set -u
VAULT="${VAULT_PATH:-/srv/data/knowledge}"
BRANCH="${VAULT_BRANCH:-main}"

exec 9>"/srv/logs/.vault-sync.lock"
flock -n 9 || exit 0   # a previous run is still going

cd "$VAULT" || { echo "$(date -Is) no vault at $VAULT"; exit 1; }

# Pull remote (Obsidian) commits under our local (api) commits, then push.
# --autostash tolerates a half-written note the api hasn't committed yet.
if ! git pull --quiet --rebase --autostash origin "$BRANCH"; then
  git rebase --abort 2>/dev/null || true
  echo "$(date -Is) PULL/REBASE CONFLICT on $BRANCH — manual merge needed, not pushing"
  exit 1
fi

# Push only when we have local commits ahead of the remote.
if [[ -n "$(git rev-list "origin/$BRANCH"..HEAD 2>/dev/null)" ]]; then
  if git push --quiet origin "$BRANCH"; then
    echo "$(date -Is) pushed $(git rev-parse --short HEAD)"
  else
    echo "$(date -Is) PUSH FAILED"
    exit 1
  fi
fi
