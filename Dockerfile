FROM node:26-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2

# ffmpeg converte audio da sessao -> wav 16kHz (Whisper).
# node:22-bookworm-slim e Debian (glibc), necessario para onnxruntime-node que o
# @huggingface/transformers usa. Alpine (musl) nao tem ld-linux-x86-64.so.2.
# node:22 também é requisito mínimo do firebase-admin >=14.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force

COPY --chown=node:node . .

ENV NODE_ENV=production \
    LOG_FILE=/tmp/server.log \
    TRANSFORMERS_CACHE_DIR=/tmp/huggingface-transformers

USER node

EXPOSE 3000

# HEALTHCHECK sem curl reduz a superficie do container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]
