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
You are reading a photograph of a page (often a Bible page) that the reader has annotated by hand, to turn it into ONE coherent study note for their personal knowledge vault.

ORIENTATION: the photo may be rotated or upside-down (phone EXIF). FIRST work out the correct reading orientation, then interpret everything — especially the direction of any arrows — in that corrected orientation. Do not describe things as "upside down"; silently read them the right way up.

Understand the whole page: the printed text, what the reader highlighted or underlined, their handwritten margin notes, and any arrows/lines linking their notes to specific parts of the text.

Then WRITE ONE COHERENT NOTE (readable markdown prose, NOT a form or a list of labelled sections):
- Open with the relevant passage quoted VERBATIM in its original language — never translate or paraphrase scripture, keep verse numbers.
- Then, in flowing prose, convey the reader's own study: what they emphasised (highlighted/underlined), what their handwritten notes say and mean, and the connections they drew with arrows — woven into a coherent train of thought, as if written up from their markings.
- Write in the SAME language as the page.

FAITHFULNESS: use only what is actually on the page. Never invent text, verses, notes, marks, or connections. If something is genuinely unreadable, say so briefly rather than guessing.

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
