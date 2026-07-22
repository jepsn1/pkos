"""pkos transcription worker: poll sermon_jobs, whisper, chunk, embed, store.

Env: DATABASE_URL (required), UPLOADS_PATH (required), OLLAMA_URL,
EMBEDDING_MODEL, WHISPER_MODEL (default small), POLL_INTERVAL_SEC,
STALE_PROCESSING_MIN (processing rows older than this are re-queued).
"""

import json
import logging
import os
import subprocess
import time
import urllib.request

import psycopg

from jobs import DEFAULT_STALE_PROCESSING_MIN, DownloadResult, PgJobStore, process_one

log = logging.getLogger("pkos-worker")

# Shared ollama is queued on by several consumers — be patient.
EMBED_TIMEOUT_SEC = 300
EMBED_RETRIES = 3


class OllamaEmbedder:
    def __init__(self, base_url: str, model: str):
        self.url = f"{base_url}/api/embed"
        self.model = model

    def embed(self, text: str) -> list[float]:
        body = json.dumps({"model": self.model, "input": text}).encode()
        req = urllib.request.Request(
            self.url, data=body, headers={"content-type": "application/json"}
        )
        last = None
        for attempt in range(EMBED_RETRIES):
            try:
                with urllib.request.urlopen(req, timeout=EMBED_TIMEOUT_SEC) as res:
                    data = json.load(res)
                embedding = (data.get("embeddings") or [[]])[0]
                if not embedding:
                    raise ValueError("ollama returned no embedding")
                return embedding
            except Exception as e:  # noqa: BLE001
                last = e
                time.sleep(2**attempt)
        raise RuntimeError(f"ollama embed failed after {EMBED_RETRIES} tries: {last}")


def _parse_meta(stdout: str) -> dict:
    """Best-effort parse of yt-dlp --print-json output into DownloadResult fields."""
    try:
        line = next(
            (l for l in reversed(stdout.splitlines()) if l.strip().startswith("{")), None
        )
        if not line:
            return {}
        d = json.loads(line)
        raw = d.get("upload_date")  # YYYYMMDD
        iso = f"{raw[0:4]}-{raw[4:6]}-{raw[6:8]}" if raw and len(raw) == 8 else None
        dur = d.get("duration")
        return {
            "title": d.get("title"),
            "uploader": d.get("uploader") or d.get("channel"),
            "upload_date": iso,
            "duration_sec": int(dur) if isinstance(dur, (int, float)) else None,
        }
    except Exception:  # noqa: BLE001 — metadata is best-effort, never fail the job
        return {}


class YtDlpDownloader:
    """Download a URL's audio to UPLOADS_PATH as <job_id>.mp3 via yt-dlp+ffmpeg."""

    def __init__(self, uploads_dir: str):
        self.uploads = uploads_dir

    def download(self, url: str, job_id: str) -> DownloadResult:
        out_tmpl = os.path.join(self.uploads, f"{job_id}.%(ext)s")
        # --print-json emits the video's metadata on stdout while extracting audio.
        proc = subprocess.run(
            ["yt-dlp", "-x", "--audio-format", "mp3", "--no-playlist",
             "--print-json", "-o", out_tmpl, url],
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            tail = (proc.stderr or proc.stdout or "").strip()[-500:]
            raise RuntimeError(f"yt-dlp failed: {tail}")
        rel = f"{job_id}.mp3"
        if not os.path.exists(os.path.join(self.uploads, rel)):
            raise RuntimeError("yt-dlp produced no mp3")
        return DownloadResult(audio_path=rel, **_parse_meta(proc.stdout))


class WhisperTranscriber:
    """Lazy-loads the model: first job pays the download, idle worker stays lean."""

    def __init__(self, model_name: str):
        self.model_name = model_name
        self._model = None

    def transcribe(self, audio_path: str):
        if self._model is None:
            from faster_whisper import WhisperModel

            log.info("loading whisper model %s (cpu/int8)", self.model_name)
            self._model = WhisperModel(self.model_name, device="cpu", compute_type="int8")
        segments, _info = self._model.transcribe(audio_path)
        return segments


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    dsn = os.environ["DATABASE_URL"]
    uploads = os.environ["UPLOADS_PATH"]
    poll_sec = float(os.environ.get("POLL_INTERVAL_SEC", "5"))
    stale_min = int(os.environ.get("STALE_PROCESSING_MIN", str(DEFAULT_STALE_PROCESSING_MIN)))

    transcriber = WhisperTranscriber(os.environ.get("WHISPER_MODEL", "small"))
    embedder = OllamaEmbedder(
        os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434"),
        os.environ.get("EMBEDDING_MODEL", "nomic-embed-text"),
    )
    resolve_audio = lambda rel: os.path.join(uploads, rel)  # noqa: E731
    downloader = YtDlpDownloader(uploads)

    log.info("worker up: polling every %ss, stale-processing=%smin", poll_sec, stale_min)
    while True:
        try:
            with psycopg.connect(dsn) as conn:
                store = PgJobStore(conn, stale_minutes=stale_min)
                while process_one(store, transcriber, embedder, resolve_audio, downloader):
                    pass
        except Exception:  # noqa: BLE001 — db hiccup: back off, reconnect
            log.exception("worker loop error; retrying in %ss", poll_sec)
        time.sleep(poll_sec)


if __name__ == "__main__":
    main()
