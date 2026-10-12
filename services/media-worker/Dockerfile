FROM python:3.11-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY src/ ./src/

ENV PYTHONPATH=/app/src PYTHONUNBUFFERED=1
RUN useradd --create-home worker
USER worker
# Consume media:uploads y procesa cada subida (ver src/media_worker/__main__.py).
CMD ["python", "-m", "media_worker"]
