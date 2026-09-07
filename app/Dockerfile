# HyperDrop — FastAPI signaling server (serves UI + WebSocket signaling only)
FROM python:3.12-slim

# No .pyc files in the image; show logs immediately in `docker logs`
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Install dependencies first (cached layer; only re-runs when requirements change)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# App code: main.py, static/, templates/
COPY . .

# Run as a non-root user instead of root
RUN useradd --create-home appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

# Fail the container if the web app stops answering
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/', timeout=3)"

# uvicorn[standard] ships the websockets library needed for /ws/{code} signaling.
# Env vars pass through: MAX_PEERS, ROOM_TTL_SECONDS, PUBLIC_BASE_URL
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--ws", "websockets"]
