FROM python:3.12-slim

# Copy uv binary from official image for fast, reliable package installation
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# Install dependencies
COPY pyproject.toml ./
RUN uv pip install --system -r pyproject.toml || uv pip install --system "fastapi>=0.111.0" "uvicorn[standard]>=0.29.0" "websockets>=12.0"

# Copy application source
COPY main.py ./

# Port configuration (Render/Fly set PORT dynamically at runtime)
ENV PORT=8000
EXPOSE 8000

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port "]
