FROM node:20-alpine

# wget pra HEALTHCHECK abaixo (alpine vem sem curl/wget por padrão)
RUN apk add --no-cache wget

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

# H7: HEALTHCHECK pra container orchestrators detectarem hung process
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
