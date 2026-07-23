#!/usr/bin/env bash
# Host-side vision runner (pkos issue #29). Claude Code lives on the host, not in
# the pkos-api container, so this daemon bridges them: it claims image-read jobs
# from the api over localhost, reads each image with headless `claude -p`, and
# posts the reading back. Runs as the user who owns the Claude auth (~/.claude).
#
# Install: see scripts/vision-runner.service. Config via env:
#   PKOS_API        (default http://127.0.0.1:3002)
#   VISION_POLL_SECS(default 5)
#   VISION_WORK_DIR (default /srv/data/vision-runner)
set -uo pipefail

API="${PKOS_API:-http://127.0.0.1:3002}"
POLL="${VISION_POLL_SECS:-5}"
WORK="${VISION_WORK_DIR:-/srv/data/vision-runner}"
mkdir -p "$WORK"
cd "$WORK" || exit 1

log() { echo "[$(date -Is)] $*"; }

# The reading contract the api's parseTitleBody expects: TITLE line, blank line,
# then a source-language, verbatim, annotation-aware body. Never translate/invent.
read_prompt() {
  local img="$1" instr="$2"
  cat <<PROMPT
You are turning a photo of a hand-annotated page (usually a Bible page) into the reader's OWN study note for their vault.

ORIENTATION: the photo may be rotated or upside-down (phone EXIF). First work out the correct reading orientation and read everything — especially arrow directions — that way. Never mention orientation or rotation.

Study the page and understand what the reader was drawing out: what they highlighted, underlined, boxed, wrote in the margins, and joined with arrows. These mark the points that matter to them and how those points connect.

Now WRITE THE NOTE AS IF THE READER WROTE IT — it must read as a study note in its own right, NOT a description of the photo. This is the most important rule:
- NEVER refer to "the reader", "the image", "the photo", "the page", or to the markings themselves ("highlighted", "underlined", "boxed", "an arrow", "a margin note", "marked in yellow", etc.). Do not describe what was marked or that anything was marked.
- Instead STATE the actual insight or point each marking was drawing out, directly, as the note's own claims — so that reading the note simply gives you the takeaways those markings pointed to.

Structure it EXACTLY in this order, with headings in the SAME language as the page:
1. FIRST (the main content, at the top): a short heading, then the key points / insights / impact as direct statements in a coherent order.
2. LAST (for reference): a heading (e.g. the passage reference), then the relevant verses quoted VERBATIM in the original language — EACH VERSE ON ITS OWN LINE (a blockquote with one verse per line), keeping verse numbers. Never translate or paraphrase scripture.

FAITHFULNESS: use only what is on the page; never invent points, verses, or connections. If something is genuinely unreadable, omit it rather than guess. Write in the SAME language as the page.

Output EXACTLY: first line "TITLE: <a short, specific title>", then a blank line, then the note body. If the image has no legible text at all, output "TITLE:" then a body of exactly NO_TEXT.${instr:+

Context from the reader: $instr}
PROMPT
}

post_json() { # url json
  curl -sf -X POST "$1" -H 'content-type: application/json' -d "$2" >/dev/null
}

process_one() {
  local job id att instr mime ext img out text
  job=$(curl -sf "$API/api/vision/jobs/next") || return 1
  id=$(printf '%s' "$job" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id') or '')" 2>/dev/null) || return 1
  [ -z "$id" ] && return 1  # {} => queue empty

  att=$(printf '%s' "$job" | python3 -c "import sys,json;print(json.load(sys.stdin).get('attachment_id') or '')")
  instr=$(printf '%s' "$job" | python3 -c "import sys,json;print(json.load(sys.stdin).get('instructions') or '')")
  log "claimed $id (attachment $att)"

  # Fetch the original image; pick an extension from its content-type so claude
  # recognizes it as an image.
  mime=$(curl -sf -o "$WORK/dl-$id" -w '%{content_type}' "$API/api/attachments/$att") || {
    post_json "$API/api/vision/jobs/$id/fail" '{"error":"could not fetch image from api"}'; return 0; }
  case "$mime" in
    *png*) ext=png;; *webp*) ext=webp;; *heic*) ext=heic;; *gif*) ext=gif;; *) ext=jpg;;
  esac
  img="img-$id.$ext"; mv -f "$WORK/dl-$id" "$WORK/$img"

  # Read it. --allowedTools Read = read-only (cannot edit/run anything); reading a
  # file in cwd is auto-allowed, so no permission prompt and no dangerous flag.
  # Wrapped in `timeout` so a hung/very-slow read fails the job instead of blocking
  # the whole runner forever (big images are slow — a 28MB PNG can take minutes).
  local rc
  out=$(timeout "${VISION_CLAUDE_TIMEOUT:-360}" claude -p "$(read_prompt "$img" "$instr")" --output-format json --allowedTools "Read" </dev/null 2>>"$WORK/runner.err")
  rc=$?
  if [ "$rc" -eq 0 ]; then
    text=$(printf '%s' "$out" | python3 -c "import sys,json;d=json.load(sys.stdin);print('' if d.get('is_error') else (d.get('result') or ''))" 2>/dev/null)
    if [ -n "$text" ]; then
      post_json "$API/api/vision/jobs/$id/complete" "$(python3 -c "import json,sys;print(json.dumps({'text':sys.stdin.read()}))" <<<"$text")" \
        && log "completed $id" || log "completed-post failed for $id"
    else
      post_json "$API/api/vision/jobs/$id/fail" '{"error":"claude returned no result"}'; log "no result for $id"
    fi
  elif [ "$rc" -eq 124 ]; then
    post_json "$API/api/vision/jobs/$id/fail" '{"error":"reading timed out — the image may be very large; try a smaller/clearer photo"}'; log "timeout for $id"
  else
    post_json "$API/api/vision/jobs/$id/fail" '{"error":"claude invocation failed (see runner.err)"}'; log "claude failed for $id (rc=$rc)"
  fi
  rm -f "$WORK/$img"
}

log "vision-runner up (api=$API poll=${POLL}s work=$WORK)"
while true; do
  process_one || true
  sleep "$POLL"
done
