# Obsidian brain — vault on desktop + iPhone

Goal: open Obsidian on the Mac AND iPhone and see every markdown note the
assistant writes, kept in sync. Issue #16.

## Approach: git-based (Obsidian + obsidian-git), no new infra

The vault (`jepsn1/knowledge`, checked out at `/srv/data/knowledge`) is already a
git repo, and **pkos-api commits every note into it** (`VaultService`,
`realGitRunner`). So the sync substrate exists — make Obsidian a second git
client of the same repo. Each device points its own local clone at
`github.com/jepsn1/knowledge`; GitHub is the meeting point.

**Rejected: Self-hosted LiveSync (CouchDB).** It would be a *second writer* to the
vault racing the api's git commits — two sources of truth for the same files,
guaranteed conflicts, and it earns nothing here: the api already versions
everything in git. Only revisit if real-time (sub-minute, no manual sync) becomes
a hard requirement, and even then keep git as canonical and treat LiveSync as a
read-cache. Not built.

## The crux: api commits are LOCAL-ONLY — fixed by a host-side push

**Finding.** `VaultService.writeNote`/`updateNote` run `git add` + `git commit`
but **never `git push`** (confirmed: vault was `ahead 3` of `origin/main`; AGENTS.md
says *"Vault pushes to GitHub stay manual/host-side"*). Nothing else pushed it —
no hook, no cron. So without a fix, assistant notes stay on the box and **iPhone
Obsidian never sees them.**

Push can't live in the container: it runs as `1000:1000` with `HOME=/tmp` and no
git creds baked in. The **host** already has push creds (`gh auth git-credential`
in `~/.gitconfig`, token scope `repo`). So a host-side cron closes the loop:

`scripts/vault-sync.sh` — every minute, host-side: `git pull --rebase --autostash`
(takes in Obsidian edits) then `git push` when the local api commits are ahead.
No-op when nothing changed; `flock` prevents overlap; rebase conflicts abort and
log instead of pushing.

### Propagation flow

```
assistant note ─► api: git commit in /srv/data/knowledge (LOCAL)
                              │
        scripts/vault-sync.sh (cron */1, host)  ── pull --rebase → push ─►  GitHub: jepsn1/knowledge
                              ▲                                                   │
        Obsidian Mac  ── commit-and-sync (push/pull) ───────────────────────────┤
        Obsidian iPhone ── commit-and-sync (push/pull) ─────────────────────────┘
```

- assistant → phone: api commit → cron push → GitHub → Obsidian pull. Latency ≤ ~1 min + Obsidian's pull interval.
- phone/Mac edit → assistant: Obsidian push → GitHub → cron `pull --rebase` into the vault. The file is live for chat immediately; it becomes **searchable** only after `pnpm --filter @pkos/api rebuild-index` (embeddings are DB-derived). Run that after bulk manual edits.

### Install the cron (Marcus runs this — host-side, no container touch)

```bash
mkdir -p /srv/logs
( crontab -l 2>/dev/null; echo '* * * * * /srv/apps/pkos/scripts/vault-sync.sh >> /srv/logs/vault-sync.log 2>&1' ) | crontab -
# smoke-test once by hand:
/srv/apps/pkos/scripts/vault-sync.sh; tail /srv/logs/vault-sync.log
```

(The script ships in this repo; `make deploy`'s `git pull` lands it at
`/srv/apps/pkos/scripts/vault-sync.sh`. No container rebuild/bounce needed.)

## Desktop setup (macOS)

1. Install Obsidian. Have git installed (`git --version`) and authenticated to
   GitHub (e.g. `gh auth login`, or a PAT in the macOS keychain).
2. Clone the vault, then open the folder as a vault:
   ```bash
   git clone https://github.com/jepsn1/knowledge.git ~/obsidian/knowledge
   ```
   Obsidian → *Open folder as vault* → `~/obsidian/knowledge`.
3. Enable community plugins → browse → **Git** (Vinzent03/obsidian-git) → install → enable.
4. obsidian-git settings: *Auto pull on startup* on; *Auto commit-and-sync
   interval* e.g. 5 min; *Pull on commit-and-sync* on. Desktop uses your native
   git + keychain creds — no PAT to paste.

## iOS setup (iPhone)

obsidian-git runs on iOS via isomorphic-git (JS git — no native git on iOS). It
works but is **slow/occasionally flaky on large repos**; the vault is small so
it's fine. If it misbehaves, GitSync.md is a drop-in alternative.

1. Install Obsidian from the App Store → create an empty vault (e.g. `knowledge`).
2. Community plugins → browse → **Git** → install → enable.
3. Create a GitHub **fine-grained PAT**: repo `jepsn1/knowledge` only, permission
   *Contents: Read and write*. (Classic token works too — scope `repo`.)
4. obsidian-git → *Authentication/Commit Author*:
   - Username: `jepsn1`
   - Password/Token: the PAT
   - Author name/email: your choice (e.g. `jepsn1 <jepsn1@users.noreply.github.com>`).
5. Command palette → **Git: Clone an existing remote repo** →
   `https://github.com/jepsn1/knowledge.git` → clone into the vault.
6. Settings: *Auto pull on startup* on; commit-and-sync interval to taste.
   Pull-to-refresh / the sync ribbon icon forces a sync.

The PAT lives only on the phone. Revoke it in GitHub settings if the device is lost.

## Notes / limits

- Single low-volume writer per side, so `pull --rebase` conflicts are rare; when
  they happen the cron aborts safely and logs — resolve by hand in the vault.
- Manual/Obsidian edits are chat-visible immediately but not search-ranked until
  `rebuild-index` (see AGENTS.md → Knowledge).
- Everything stays Tailscale/GitHub — no new ports, no `0.0.0.0` binds, no
  container changes.
