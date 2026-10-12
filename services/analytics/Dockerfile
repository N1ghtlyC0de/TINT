FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY src/ ./src/

ENV PYTHONPATH=/app/src PYTHONUNBUFFERED=1
RUN useradd --create-home worker
USER worker

# API de solo lectura de KPIs (ANALYTICS_PORT).
EXPOSE 8084

CMD ["python", "-m", "analytics"]
