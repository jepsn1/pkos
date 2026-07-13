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
    audio_path: str


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


class Transcriber(Protocol):
    def transcribe(self, audio_path: str):  # -> iterable of segments
        ...


class Embedder(Protocol):
    def embed(self, text: str) -> list[float]: ...


def process_one(
    store: JobStore,
    transcriber: Transcriber,
    embedder: Embedder,
    resolve_audio,
    max_words: int = 500,
) -> bool:
    """Claim and fully process one job. Returns False when queue is empty.

    Any exception marks the job `error` with the message; the worker loop
    survives and moves on.
    """
    job = store.claim()
    if job is None:
        return False
    log.info("job %s: transcribing %s", job.id, job.original_filename)
    try:
        segments = transcriber.transcribe(resolve_audio(job.audio_path))
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
        RETURNING id, original_filename, audio_path
    """

    def __init__(self, conn, stale_minutes: int = DEFAULT_STALE_PROCESSING_MIN):
        self.conn = conn
        self.stale_minutes = stale_minutes

    def claim(self) -> Optional[Job]:
        with self.conn.cursor() as cur:
            cur.execute(self.CLAIM_SQL, {"stale": self.stale_minutes})
            row = cur.fetchone()
        self.conn.commit()
        return Job(str(row[0]), row[1], row[2]) if row else None

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
