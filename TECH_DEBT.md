# Tech Debt Backlog — osl-video-server

Findings da auditoria de qualidade de código de **2026-05-01**. Os críticos e high-value já foram corrigidos (ver commits `b694a46` e `c7ce820`). Este arquivo lista o que ficou pendente, com motivo.

Cada item pode virar um GitHub Issue independente. Severidade: **P1** = bug latente, **P2** = smell que piora manutenção, **P3** = preferência de estilo.

---

## P1 — Bugs latentes

### #B1 Affiliate retry queue ausente

- **Severidade:** P1
- **Arquivo:** `routes/payments.js:243-247`
- **Problema:** Se `approveReferralRewardFromPayment(payment)` falha, o erro é logado mas o webhook retorna 200 OK. O afiliado nunca recebe a comissão e não há reprocessamento.
- **Fix sugerido:** Implementar fila persistente (Firestore `pending_referrals/{ref}` com retry counter) e worker que reprocessa periodicamente. Ou re-throw no webhook pra que MP reenvie.

### #B2 Logger silent failures + sem rotação

- **Severidade:** P1
- **Arquivo:** `logger.js:8-10`
- **Problema:** `fs.appendFileSync(LOG_FILE, ...)` num try/catch que engole erros. Se disco encher, logs somem silenciosamente. Log file também cresce sem limite.
- **Fix sugerido:** Migrar pra `winston` ou `pino` com daily rotation + size cap. Em fallback, escrever em stderr quando arquivo falhar.

### #B3 Streams órfãos não detectados via LiveKit poll

- **Severidade:** P1
- **Arquivo:** `routes/streaming.js:226-247` (stop) + `services/cleanup.js`
- **Problema:** Se cliente crasha sem `/streaming/stop`, in-memory `activeStreams` é limpado pelo cleanup loop após 6h, mas o egress real na LiveKit pode continuar rodando — desperdício de minutos pagos.
- **Fix sugerido:** Adicionar polling periódico (ex: a cada 15min) em `services/cleanup.js` que chama `egressClient.listEgress()` e cruza com `activeStreams` em memória. Egresses que não estão no Map são parados via `egressClient.stopEgress(id)`.

### #B4 Re-throw on egress stop failure

- **Severidade:** P1
- **Arquivo:** `video/webrtc.js:103-105` e `:230-232`
- **Problema:** Quando `egressClient.stopEgress(id)` falha (LiveKit fora, network), o erro é logado mas a função retorna como se sucesso — cliente recebe 200 OK e o egress continua rodando.
- **Fix sugerido:** Mudar pra retornar `{ ok: false, reason }` em caso de falha; rota propaga 502 pra client. Trade-off: muda contrato de cliente, precisa atualizar UI.

### #B5 activeJob.email pode ser undefined no /streaming/stop

- **Severidade:** P1
- **Arquivo:** `routes/streaming.js:217-220`
- **Problema:** Se startRoomStreaming falhou DEPOIS de `activeStreams.set` mas ANTES de setar `job.email`, `activeJob.email` é undefined. A validação `if (activeJob.email && activeJob.email !== callerEmail)` permite qualquer um parar.
- **Fix sugerido:** Setar `email` no job ANTES de adicionar ao Map. Ou trocar condicional pra `if (activeJob.email !== callerEmail)` (que rejeita também undefined).

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
