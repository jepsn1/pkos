from chunking import Segment, chunk_segments, full_transcript


def seg(start, end, words):
    return Segment(start, end, " ".join(f"w{i}" for i in range(words)))


def test_packs_segments_until_word_budget():
    segments = [seg(0, 10, 300), seg(10, 20, 150), seg(20, 30, 200)]
    chunks = chunk_segments(segments, max_words=500)
    assert len(chunks) == 2
    # first chunk: 300 + 150 = 450 words, third segment would overflow
    assert (chunks[0].start_sec, chunks[0].end_sec) == (0, 20)
    assert (chunks[1].start_sec, chunks[1].end_sec) == (20, 30)
    assert chunks[0].seq == 0 and chunks[1].seq == 1


def test_never_splits_a_segment_even_when_oversized():
    chunks = chunk_segments([seg(0, 60, 800)], max_words=500)
    assert len(chunks) == 1
    assert len(chunks[0].text.split()) == 800


def test_keeps_timestamps_from_first_and_last_segment():
    segments = [Segment(1.5, 3.0, "hello there"), Segment(3.0, 7.25, "general kenobi")]
    [chunk] = chunk_segments(segments, max_words=500)
    assert chunk.start_sec == 1.5
    assert chunk.end_sec == 7.25
    assert chunk.text == "hello there general kenobi"


def test_drops_empty_segments_and_strips():
    segments = [Segment(0, 1, "  "), Segment(1, 2, " four score "), Segment(2, 3, "")]
    [chunk] = chunk_segments(segments, max_words=10)
    assert chunk.text == "four score"
    assert chunk.start_sec == 1


def test_empty_input_gives_no_chunks():
    assert chunk_segments([]) == []


def test_full_transcript_joins_chunks():
    segments = [seg(0, 10, 30), seg(10, 20, 30)]
    chunks = chunk_segments(segments, max_words=40)
    assert len(chunks) == 2
    assert full_transcript(chunks).count("\n\n") == 1
