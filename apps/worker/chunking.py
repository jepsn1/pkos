"""Split whisper segments into ~N-word chunks that keep timestamps."""

from dataclasses import dataclass

DEFAULT_MAX_WORDS = 500


@dataclass(frozen=True)
class Segment:
    """Minimal shape of a faster-whisper segment (duck-typed in prod)."""

    start: float
    end: float
    text: str


@dataclass(frozen=True)
class Chunk:
    seq: int
    text: str
    start_sec: float
    end_sec: float


def chunk_segments(segments, max_words: int = DEFAULT_MAX_WORDS) -> list[Chunk]:
    """Greedily pack whole segments into chunks of <= max_words words.

    Segment boundaries are never split, so a single segment longer than
    max_words becomes its own chunk. Empty/whitespace segments are dropped.
    """
    chunks: list[Chunk] = []
    words = 0
    texts: list[str] = []
    start = end = 0.0

    def flush():
        nonlocal words, texts
        if texts:
            chunks.append(Chunk(len(chunks), " ".join(texts), start, end))
        words = 0
        texts = []

    for seg in segments:
        text = seg.text.strip()
        if not text:
            continue
        n = len(text.split())
        if texts and words + n > max_words:
            flush()
        if not texts:
            start = seg.start
        texts.append(text)
        words += n
        end = seg.end
    flush()
    return chunks


def full_transcript(chunks: list[Chunk]) -> str:
    return "\n\n".join(c.text for c in chunks)
