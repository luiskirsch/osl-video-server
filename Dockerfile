FROM node:25-bookworm-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370

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

# Imagens montadas fora do Railway (workflow "Imagem do backend") informam o
# commit; nas montagens do próprio Railway fica vazio e vale RAILWAY_GIT_COMMIT_SHA.
ARG GIT_COMMIT_SHA=""

ENV NODE_ENV=production \
    LOG_FILE=/tmp/server.log \
    TRANSFORMERS_CACHE_DIR=/tmp/huggingface-transformers \
    GIT_COMMIT_SHA=$GIT_COMMIT_SHA

USER node

EXPOSE 3000

# HEALTHCHECK sem curl reduz a superficie do container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]
