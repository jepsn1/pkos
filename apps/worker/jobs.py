"""Sermon job claiming + lifecycle. DB via psycopg; logic testable with fakes."""

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional, Protocol

from chunking import Chunk, chunk_segments, full_transcript

log = logging.getLogger("pkos-worker")

DEFAULT_STALE_PROCESSING_MIN = 60


@dataclass(frozen=True)
class Job:
    id: str
    original_filename: str
    # NULL for a URL job until the download step fills it in.
    audio_path: Optional[str]
    # Set for a URL job; the worker downloads it (yt-dlp) before transcribing.
    source_url: Optional[str] = None


@dataclass(frozen=True)
class DownloadResult:
    """Audio path (relative to uploads) + best-effort source metadata."""
    audio_path: str
    title: Optional[str] = None
    uploader: Optional[str] = None
    upload_date: Optional[str] = None  # ISO YYYY-MM-DD
    duration_sec: Optional[int] = None


def is_claimable(
    status: str,
    updated: datetime,
    now: datetime,
    stale_minutes: int = DEFAULT_STALE_PROCESSING_MIN,
) -> bool:
    """Requeue semantics: queued jobs always; processing jobs only when stale.

    A `processing` row older than stale_minutes means a worker died mid-job
    (crash/restart) — treat it as queued again. PgJobStore.CLAIM_SQL encodes
    the same rule in SQL; keep the two in sync.
    """
    if status == "queued":
        return True
    if status == "processing":
        return now - updated >= timedelta(minutes=stale_minutes)
    return False  # done/error are terminal


class JobStore(Protocol):
    def claim(self) -> Optional[Job]: ...
    def complete(self, job_id: str, transcript: str, chunks: list[Chunk],
                 embeddings: list[list[float]]) -> None: ...
    def fail(self, job_id: str, message: str) -> None: ...
    def set_audio_path(self, job_id: str, audio_path: str) -> None: ...
    def set_metadata(self, job_id: str, title: Optional[str],
                     uploader: Optional[str], upload_date: Optional[str]) -> None: ...


class Transcriber(Protocol):
    def transcribe(self, audio_path: str):  # -> iterable of segments
        ...


class Downloader(Protocol):
    def download(self, url: str, job_id: str) -> "DownloadResult":
        ...


class Embedder(Protocol):
    def embed(self, text: str) -> list[float]: ...


def process_one(
    store: JobStore,
    transcriber: Transcriber,
    embedder: Embedder,
    resolve_audio,
    downloader: Optional[Downloader] = None,
    max_words: int = 500,
) -> bool:
    """Claim and fully process one job. Returns False when queue is empty.

    A URL job (audio_path NULL, source_url set) is downloaded first, then treated
    like an uploaded file. Any exception marks the job `error` with the message;
    the worker loop survives and moves on.
    """
    job = store.claim()
    if job is None:
        return False
    log.info("job %s: processing %s", job.id, job.original_filename)
    try:
        audio_rel = job.audio_path
        if not audio_rel and job.source_url:
            if downloader is None:
                raise ValueError("url job but no downloader configured")
            log.info("job %s: downloading %s", job.id, job.source_url)
            result = downloader.download(job.source_url, job.id)
            audio_rel = result.audio_path
            store.set_audio_path(job.id, audio_rel)  # persist so a requeue resumes
            # Best-effort metadata → job fields the enrichment already uses for the
            # note (title/speaker/date); only fills what the user didn't set.
            store.set_metadata(job.id, result.title, result.uploader, result.upload_date)
        if not audio_rel:
            raise ValueError("job has neither audio_path nor source_url")
        segments = transcriber.transcribe(resolve_audio(audio_rel))
        chunks = chunk_segments(segments, max_words=max_words)
        if not chunks:
            raise ValueError("transcription produced no text")
        embeddings = [embedder.embed(c.text) for c in chunks]
        store.complete(job.id, full_transcript(chunks), chunks, embeddings)
        log.info("job %s: done (%d chunks)", job.id, len(chunks))
    except Exception as e:  # noqa: BLE001 — job errors must not kill the loop
        log.exception("job %s: failed", job.id)
        store.fail(job.id, f"{type(e).__name__}: {e}")
    return True


class PgJobStore:
    """Postgres store. FOR UPDATE SKIP LOCKED so parallel workers never collide."""

    # Mirrors is_claimable(): queued, or processing but stale (worker died).
    CLAIM_SQL = """
        UPDATE sermon_jobs SET status = 'processing', updated = now()
        WHERE id = (
            SELECT id FROM sermon_jobs
            WHERE status = 'queued'
               OR (status = 'processing'
                   AND updated < now() - make_interval(mins => %(stale)s))
            ORDER BY created
            FOR UPDATE SKIP LOCKED
            LIMIT 1
        )
        RETURNING id, original_filename, audio_path, source_url
    """

    def __init__(self, conn, stale_minutes: int = DEFAULT_STALE_PROCESSING_MIN):
        self.conn = conn
        self.stale_minutes = stale_minutes

    def claim(self) -> Optional[Job]:
        with self.conn.cursor() as cur:
            cur.execute(self.CLAIM_SQL, {"stale": self.stale_minutes})
            row = cur.fetchone()
        self.conn.commit()
        return Job(str(row[0]), row[1], row[2], row[3]) if row else None

    def set_audio_path(self, job_id: str, audio_path: str) -> None:
        with self.conn.cursor() as cur:
            cur.execute(
                "UPDATE sermon_jobs SET audio_path = %s, updated = now() WHERE id = %s",
                (audio_path, job_id),
            )
        self.conn.commit()

    def set_metadata(self, job_id, title, uploader, upload_date) -> None:
        # COALESCE: never override metadata the user supplied at enqueue time.
        with self.conn.cursor() as cur:
            cur.execute(
                """
                UPDATE sermon_jobs SET
                    title = COALESCE(title, %s),
                    speaker = COALESCE(speaker, %s),
                    sermon_date = COALESCE(sermon_date, %s),
                    updated = now()
                WHERE id = %s
                """,
                (title, uploader, upload_date, job_id),
            )
        self.conn.commit()

    def complete(self, job_id, transcript, chunks, embeddings) -> None:
        with self.conn.cursor() as cur:
            # Idempotent for requeued jobs: drop any half-written chunks first.
            cur.execute("DELETE FROM transcript_chunks WHERE job_id = %s", (job_id,))
            for chunk, embedding in zip(chunks, embeddings):
                cur.execute(
                    """
                    INSERT INTO transcript_chunks
                        (job_id, seq, text, start_sec, end_sec, embedding)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    """,
                    (job_id, chunk.seq, chunk.text, chunk.start_sec,
                     chunk.end_sec, _vector(embedding)),
                )
            cur.execute(
                """
                UPDATE sermon_jobs
                SET status = 'done', transcript = %s, error = NULL, updated = now()
                WHERE id = %s
                """,
                (transcript, job_id),
            )
        self.conn.commit()

    def fail(self, job_id: str, message: str) -> None:
        with self.conn.cursor() as cur:
            cur.execute(
                """
                UPDATE sermon_jobs
                SET status = 'error', error = %s, updated = now()
                WHERE id = %s
                """,
                (message[:2000], job_id),
            )
        self.conn.commit()


def _vector(embedding: list[float]) -> str:
    """pgvector text literal, e.g. '[0.1,0.2]'."""
    return "[" + ",".join(repr(float(x)) for x in embedding) + "]"
