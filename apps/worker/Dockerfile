# pkos transcription worker: faster-whisper (cpu/int8) + ollama embeddings +
# yt-dlp for URL jobs.
FROM python:3.12-slim

WORKDIR /app

# ffmpeg: yt-dlp audio extraction + faster-whisper decoding.
# curl/unzip: install Deno, the JS runtime yt-dlp uses to solve YouTube's
# "n-challenge" (without it YouTube returns only thumbnails, no audio).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
    && deno --version

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py ./

# Whisper models cache under /root/.cache (compose mounts a volume there).
CMD ["python", "worker.py"]
