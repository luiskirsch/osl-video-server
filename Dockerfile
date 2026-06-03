FROM node:20-slim

# curl pra HEALTHCHECK + ffmpeg pra converter audio da sessao -> wav 16kHz (Whisper)
# node:20-slim é Debian (glibc) — necessário pra onnxruntime-node que o
# @huggingface/transformers usa. Alpine (musl) nao tem ld-linux-x86-64.so.2.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

# H7: HEALTHCHECK pra container orchestrators detectarem hung process
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
