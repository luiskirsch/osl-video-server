# Tech Debt Backlog — osl-video-server

Findings da auditoria de qualidade de código de **2026-05-01**. Os críticos e high-value já foram corrigidos (ver commits `b694a46` e `c7ce820`). Este arquivo lista o que ficou pendente, com motivo.

Cada item pode virar um GitHub Issue independente. Severidade: **P1** = bug latente, **P2** = smell que piora manutenção, **P3** = preferência de estilo.

---

## P1 — Bugs latentes ✅ Quitados em 2026-05-07 (commit `7f5458b`)

Os 5 P1 abaixo (B1–B5) foram resolvidos em batch. Mantidos por contexto histórico — não estão mais pendentes.

### ~~#B1 Affiliate retry queue ausente~~ ✅

- **Status:** resolvido. Fila persistente `pending_referrals/{externalReference}` com backoff exponencial (1m→5m→30m→2h→12h, 5 tentativas) processada pelo `services/scheduler.js`. Webhook em `routes/payments.js` agora chama `enqueuePendingReferral` em caso de falha em vez de só logar.

### ~~#B2 Logger silent failures + sem rotação~~ ✅

- **Status:** resolvido. `logger.js` ganhou rotação por tamanho (10MB default → `server.log.1`) e fallback em stderr quando `appendFileSync` falha (sticky pra evitar spam). Não migramos pra winston/pino — overkill pra escala atual.

### ~~#B3 Streams órfãos não detectados via LiveKit poll~~ ✅

- **Status:** resolvido. `services/cleanup.js` ganhou `pollLiveKitOrphans()` que roda 15min, chama `egressClient.listEgress({ active: true })` e cruza com `activeStreams`/`activeRecordings`. Egresses não conhecidos são parados.

### ~~#B4 Re-throw on egress stop failure~~ ✅

- **Status:** resolvido. `stopRoomStreaming`/`stopRoomRecording` em `video/webrtc.js` retornam `egressStopOk: false` quando o stop falha. Routes em `streaming.js`/`recording.js` propagam 502 EGRESS_STOP_FALHOU com hint de retry.

### ~~#B5 activeJob.email pode ser undefined no /streaming/stop~~ ✅

- **Status:** resolvido. Trocada a condicional permissiva `if (job.email && job.email !== caller)` por estrita `if (job.email !== caller)` — rejeita também `undefined`, fechando o bypass.

---

## P2 — Refactors estruturais (precisam test plan)

### #B6 Unified egress service (recording + streaming)

- **Severidade:** P2
- **Arquivos:** `routes/recording.js`, `routes/streaming.js`, `video/webrtc.js`
- **Problema:** Os dois fluxos têm 90% de lógica idêntica (auth → reserve quota → start egress → stats → stop). Cada bug fix precisa ser aplicado em duplicidade.
- **Fix sugerido:** Extrair `services/egress.js` com `startEgress(type, params)` e `stopEgress(type, roomId)` que aceitam `type ∈ {recording, streaming}`. Routes ficam fininhas, só validação e response.
- **Tradeoff:** Migração precisa ser cuidadosa, qualquer caller fica desalinhado.

### #B7 Substituir Maps in-memory por Firestore (durabilidade)

- **Severidade:** P2
- **Arquivos:** `game/state.js` (todos os Maps), `routes/streaming.js`, `routes/recording.js`, `video/webrtc.js`
- **Problema:** `activeStreams`, `activeRecordings`, `pagamentosAprovados`, `panelRooms` são source-of-truth in-memory. Restart do Railway perde estado.
- **Fix sugerido:** Mover pra Firestore com docs ativos. Adicionar bootstrap que reidrata Maps na inicialização lendo Firestore. Cleanup loop continua mas agora age sobre Firestore docs.
- **Tradeoff:** Latência extra em cada start/stop; precisa pensar custo-benefício.

### #B8 Encapsular Firestore FieldValue/serverTimestamp

- **Severidade:** P2
- **Arquivos:** Todas routes que importam `admin.firestore.FieldValue.*`
- **Problema:** Acoplamento direto com Firebase Admin SDK em camada de rota. Difícil testar (precisa stub do Firestore). Mudança pra outro DB seria custosa.
- **Fix sugerido:** Service layer: `services/store.js` exporta `now()`, `increment(n)`, `serverTimestamp()` etc. Routes nunca tocam `admin.firestore.*`.

### #B9 Endpoint /streaming/validate-url

- **Severidade:** P2
- **Arquivos:** `routes/streaming.js`, `video/webrtc.js`
- **Problema:** `buildRtmpUrl` valida no momento de start. Se a key/URL é inválida, a UI só descobre depois do egress falhar.
- **Fix sugerido:** Endpoint `GET /streaming/validate-url?platform=X&streamKey=Y` que aplica a validação e retorna ok/erro. Frontend chama no blur do campo.

### #B10 Event emitter para panel updates

- **Severidade:** P2
- **Arquivos:** `video/webrtc.js`, `routes/game.js`
- **Problema:** `broadcastPanelUpdate()` é chamado manualmente em vários lugares. Se um novo recurso atualizar `panelRooms[X]` sem chamar o broadcast, o painel SSE fica desatualizado.
- **Fix sugerido:** Wrapper `panelRooms.set/delete` que dispara broadcast automaticamente. Ou EventEmitter com tópicos.

---

## P2 — Style / consistência

### #B11 Error code naming consistency

- **Severidade:** P2
- **Arquivos:** Vários (`routes/*.js`)
- **Problema:** Mistura de `UPPER_SNAKE_CASE` (maioria), kebab-case (`request-id` em logger), e plain (`STREAMS`). Sem padrão documentado.
- **Fix sugerido:** Definir convenção (`UPPER_SNAKE`) em CONTRIBUTING.md e revisar tudo.

### #B12 Middleware ordering (rate-limit antes de auth)

- **Severidade:** P2
- **Arquivos:** `routes/streaming.js` (algumas rotas têm `requireFirebaseAuth` antes de limiter)
- **Problema:** Auth verifica token via Firebase Admin (custoso CPU). Rate limit deve vir antes pra que ataques de força bruta não consumam CPU.
- **Fix sugerido:** Padronizar: `[limiter, requireFirebaseAuth, requireEmailMatchesToken, asyncHandler(...)]` em toda rota protegida.

### #B13 Magic strings (collection names, S3 prefix, timestamp parse)

- **Severidade:** P2
- **Arquivos:** `video/webrtc.js:65` (S3 prefix), `routes/payments.js:44` (timestamp parse hack), `services/firestore.js` (collection names)
- **Problema:** Coleções Firestore (`streaming_passes`, `recording_passes`, `users`, etc.) repetidas como strings literais. S3 prefix hardcoded. Timestamp ms-vs-s detectado por `length > 12`.
- **Fix sugerido:** `const COLLECTIONS = { streamingPasses: "streaming_passes", ... }` em config.js. `S3_RECORDINGS_PREFIX` em config. Timestamp: validar contra range.

### #B14 LIVEKIT_BUILTIN_LAYOUTS em config.js

- **Severidade:** P3
- **Arquivo:** `video/webrtc.js:131-134`
- **Problema:** Map `{"pov-host": "single-speaker", grid: "grid"}` hardcoded em webrtc.js mas é configuração de produto.
- **Fix sugerido:** Move pra config.js junto com PRODUCT_CATALOG.

### #B15 Rate limit messages duplicados

- **Severidade:** P3
- **Arquivos:** `routes/streaming.js:19, 33`, `routes/payments.js:19`, `routes/admin.js:19`
- **Problema:** Mensagens `{ ok: false, error: "RATE_LIMIT_EXCEDIDO", hint: "..." }` quase iguais.
- **Fix sugerido:** Helper em utils.js: `rateLimitMessage(hint)`.

---

## P3 — Out of scope / nice-to-have

### #B16 Métricas Prometheus

- **Severidade:** P3
- **Problema:** Sem visibilidade de métricas (active streams count, egress failures, webhook latency).
- **Fix sugerido:** `/metrics` com prom-client; integrar com Datadog/Grafana se houver budget.

---

## Resumo

| Severidade | Count |
|---|---|
| P1 | 5 |
| P2 | 10 |
| P3 | 1 |
| **Total** | **16** |
