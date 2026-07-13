from datetime import datetime, timedelta

import pytest

from chunking import Segment
from jobs import Job, is_claimable, process_one

NOW = datetime(2026, 7, 13, 12, 0, 0)


class TestRequeueSemantics:
    def test_queued_always_claimable(self):
        assert is_claimable("queued", NOW, NOW)
        assert is_claimable("queued", NOW - timedelta(days=3), NOW)

    def test_fresh_processing_not_claimable(self):
        assert not is_claimable("processing", NOW - timedelta(minutes=5), NOW, 60)

    def test_stale_processing_requeued(self):
        # worker died mid-job: processing row older than the window is fair game
        assert is_claimable("processing", NOW - timedelta(minutes=61), NOW, 60)
        assert is_claimable("processing", NOW - timedelta(minutes=60), NOW, 60)

    @pytest.mark.parametrize("status", ["done", "error"])
    def test_terminal_states_never_requeued(self, status):
        assert not is_claimable(status, NOW - timedelta(days=30), NOW)


class FakeStore:
    def __init__(self, jobs):
        self.jobs = list(jobs)
        self.completed = []
        self.failed = []

    def claim(self):
        return self.jobs.pop(0) if self.jobs else None

    def complete(self, job_id, transcript, chunks, embeddings):
        self.completed.append((job_id, transcript, chunks, embeddings))

    def fail(self, job_id, message):
        self.failed.append((job_id, message))


class FakeTranscriber:
    def __init__(self, segments=None, error=None):
        self.segments = segments or []
        self.error = error
        self.paths = []

    def transcribe(self, audio_path):
        self.paths.append(audio_path)
        if self.error:
            raise self.error
        return iter(self.segments)


class FakeEmbedder:
    def embed(self, text):
        return [float(len(text)), 0.0]


JOB = Job("job-1", "sermon.mp3", "abc.mp3")


def test_empty_queue_returns_false():
    store = FakeStore([])
    assert process_one(store, FakeTranscriber(), FakeEmbedder(), str) is False


def test_happy_path_completes_with_chunks_and_embeddings():
    segments = [Segment(0, 5, "four score and seven"), Segment(5, 9, "years ago")]
    store = FakeStore([JOB])
    transcriber = FakeTranscriber(segments)

    assert process_one(store, transcriber, FakeEmbedder(),
                       lambda rel: f"/uploads/{rel}") is True

    # audio resolved against uploads root
    assert transcriber.paths == ["/uploads/abc.mp3"]
    [(job_id, transcript, chunks, embeddings)] = store.completed
    assert job_id == "job-1"
    assert "four score and seven" in transcript
    assert len(chunks) == 1 and chunks[0].end_sec == 9
    assert len(embeddings) == len(chunks)
    assert store.failed == []


def test_transcription_error_marks_job_error_not_crash():
    store = FakeStore([JOB])
    transcriber = FakeTranscriber(error=RuntimeError("corrupt mp3"))

    assert process_one(store, transcriber, FakeEmbedder(), str) is True

    [(job_id, message)] = store.failed
    assert job_id == "job-1"
    assert "corrupt mp3" in message
    assert store.completed == []


def test_empty_transcription_is_an_error():
    store = FakeStore([JOB])
    assert process_one(store, FakeTranscriber([]), FakeEmbedder(), str) is True
    assert store.failed[0][1].startswith("ValueError")


def test_embedding_error_marks_job_error():
    class BoomEmbedder:
        def embed(self, text):
            raise RuntimeError("ollama down")

    store = FakeStore([JOB])
    transcriber = FakeTranscriber([Segment(0, 1, "hello")])
    assert process_one(store, transcriber, BoomEmbedder(), str) is True
    assert "ollama down" in store.failed[0][1]
