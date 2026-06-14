FROM python:3.11-slim

# Install system dependencies
# libgomp1 is needed for PyTorch OpenMP
# ffmpeg is needed for video processing
# libgl1 and libglib2.0-0 are optional dependencies for OpenCV headless (but good to have as fallbacks)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Create a non-root user for security and Hugging Face compatibility
# HF Spaces runs containers as user with UID 1000
RUN useradd -m -u 1000 appuser

WORKDIR /app

# Ensure cache directories are writeable by the appuser
ENV TORCH_HOME=/app/.cache/torch
ENV MPLCONFIGDIR=/app/.cache/matplotlib
RUN mkdir -p /app/.cache/torch /app/.cache/matplotlib /app/media_tmp && \
    chown -R appuser:appuser /app

# Copy requirements and install
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application
COPY --chown=appuser:appuser . .

# Switch to the non-root user
USER appuser

EXPOSE 7860

# Run FastAPI app with a single worker to prevent GPU/RAM exhaustion
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7860", "--workers", "1"]
