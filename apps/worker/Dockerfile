# pkos transcription worker: faster-whisper (cpu/int8) + ollama embeddings.
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py .

# Whisper models cache under /root/.cache (compose mounts a volume there).
CMD ["python", "worker.py"]
