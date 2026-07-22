# pkos transcription worker: faster-whisper (cpu/int8) + ollama embeddings +
# yt-dlp for URL jobs.
FROM python:3.12-slim

WORKDIR /app

# ffmpeg: yt-dlp audio extraction + faster-whisper decoding.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py ./

# Whisper models cache under /root/.cache (compose mounts a volume there).
CMD ["python", "worker.py"]
