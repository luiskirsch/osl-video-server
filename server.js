// Bootstrap: dotenv pra rodar local com .env (Railway já injeta env vars
// nativamente, então em prod isso vira no-op). Tem que ser ANTES de
// qualquer require que use process.env.
try { require("dotenv").config(); } catch (_) { /* dotenv opcional em prod */ }

// Railway não define NODE_ENV automaticamente em todos os serviços. Ativa
// os defaults otimizados do Node/Express sem depender do APP_ENV localizado.
if (!process.env.NODE_ENV && process.env.RAILWAY_DEPLOYMENT_ID) {
  process.env.NODE_ENV = "production";
}

// Sentry + error handlers precisam ser os primeiros (Sentry captura
// uncaughtException internamente, e o logger é dependência circular se
// carregado antes).

// Sentry init — só ativa se SENTRY_DSN estiver setado no Railway env. Sem
// DSN, no-op completo (não importa o módulo). Custo zero quando desligado.
let Sentry = null;
if (process.env.SENTRY_DSN) {
  try {
    Sentry = require("@sentry/node");
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.APP_ENV || process.env.NODE_ENV || "production",
      release: process.env.RAILWAY_GIT_COMMIT_SHA || undefined,
      tracesSampleRate: 0,
      // Não envia dados pessoais por default — só erro stack.
      sendDefaultPii: false
    });
  } catch (e) {
    console.error("[sentry] failed to init:", e.message);
    Sentry = null;
  }
}

const { logInfo, logWarn, logError } = require("./logger");

process.on("uncaughtException", (err) => {
  if (Sentry) try { Sentry.captureException(err); } catch (_) { /* empty */ }
  logError("uncaughtException", err);
});

process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  if (Sentry) try { Sentry.captureException(err); } catch (_) { /* empty */ }
  logError("unhandledRejection", err);
});

const http    = require("http");
const express = require("express");
const helmet  = require("helmet");
const cors    = require("cors");
const morgan  = require("morgan");

const { PORT, APP_ENV, IS_PRODUCTION, CORS_ALLOWED_HEADERS, GAME_ENABLED } = require("./config");
const { createRequestId, safeRequestPath } = require("./utils");

// --- Rotas ---
const healthRouter    = require("./routes/health");
const i18nRouter      = require("./routes/i18n");
const { router: stripeRouter, webhookRouter: stripeWebhookRouter } = require("./routes/stripe");
const therapyRouter   = require("./routes/therapy");
const clinicalPrivacyRouter = require("./routes/clinicalPrivacy")();
const clinicalMfaRouter = require("./routes/clinicalMfa")();
const accountRouter         = require("./routes/account")();
const institutionRouter     = require("./routes/institution");
const rtRouter              = require("./routes/rt");

// Módulos do O SextoLugar (ver GAME_ENABLED em config.js). Carregados sob
// demanda: alguns iniciam timers ao serem importados (ex.: game/rooms.js).
// [categoria de auditoria | null, módulo], na ordem original entre si.
const GAME_ROUTERS = [
  [null, "./routes/game"], ["recording", "./routes/recording"], [null, "./routes/streaming"],
  [null, "./routes/discord"], ["payment", "./routes/payments"], ["license", "./routes/license"],
  ["affiliate", "./routes/affiliate"], ["admin", "./routes/admin"], [null, "./routes/ai"],
  ["encontro", "./routes/encontro"], [null, "./routes/security"], ["panel", "./routes/panel"],
  ["ritual", "./routes/ritual"], [null, "./routes/analytics"], [null, "./routes/social"],
  [null, "./routes/cosmetics"], [null, "./routes/platform"], [null, "./routes/content"],
  [null, "./routes/session"], [null, "./routes/liveService"], [null, "./routes/notifications"],
  [null, "./routes/inviteLinks"], [null, "./routes/rooms"], [null, "./routes/recurringGroups"],
  [null, "./routes/hub"], [null, "./routes/quickRitual"], [null, "./routes/discoveries"],
  ["ops", "./routes/ops"],
];

const { globalLimiter } = require("./services/rateLimit");
const waf = require("./middleware/waf");
const { auditLog } = require("./middleware/auditLog");
const { scheduleAuditLogCleanup } = require("./jobs/auditLogCleanup");

// Valida secrets críticos no startup — exit em prod se ausentes, warn em dev
const { checkSecrets } = require("./scripts/validate-env");
// Integrações sensíveis falham fechadas em suas próprias rotas. Mantemos a
// API e /health disponíveis para diagnóstico mesmo quando um secret modular
// ainda não foi provisionado.
checkSecrets({ exitOnError: false });

// --- App ---
const app = express();

app.disable("x-powered-by");
// trust proxy: 2 — medido em produção (2026-10-17): o Railway entrega
// X-Forwarded-For = "<cliente>, <proxy interno do Railway>" e o socket vem de
// 100.64.x. Ele DESCARTA o X-Forwarded-For enviado pelo cliente e sobrescreve
// X-Real-IP, então o penúltimo valor é sempre o IP real. Com 1, todo usuário
// aparecia com o IP do proxy (limites por IP compartilhados por todos e
// registros de acesso sem o IP real). Nunca usar "true" (IP mais à esquerda).
const trustedProxyHopsRaw = Number(process.env.TRUST_PROXY_HOPS || (IS_PRODUCTION ? 2 : 0));
const trustedProxyHops = Number.isSafeInteger(trustedProxyHopsRaw) && trustedProxyHopsRaw >= 0 && trustedProxyHopsRaw <= 5
  ? trustedProxyHopsRaw
  : (IS_PRODUCTION ? 2 : 0);
app.set("trust proxy", trustedProxyHops);

// Redireciona pra HTTPS só quando a borda (Railway) explicitamente marcou a
// requisição como HTTP. Ausência do header x-forwarded-proto = requisição
// direta ao container (ex.: healthcheck interno da própria Railway) — nunca
// redireciona nesse caso, pra não derrubar o healthcheck.
if (IS_PRODUCTION) {
  app.use((req, res, next) => {
    if (req.headers["x-forwarded-proto"] === "http") {
      return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
    }
    next();
  });
}

// Identidade e telemetria entram antes dos middlewares que podem encerrar a
// requisição, cobrindo também bloqueios de CORS, WAF e rate limit.
app.use((req, res, next) => {
  req.requestId = createRequestId();
  res.setHeader("X-Request-Id", req.requestId);

  const start = Date.now();
  res.on("finish", () => {
    logInfo("http_request", {
      requestId: req.requestId,
      method: req.method,
      path: safeRequestPath(req),
      statusCode: res.statusCode,
      durationMs: Date.now() - start,
      ip: req.ip || req.socket.remoteAddress || null
    });
  });

  next();
});

morgan.token("request-id", (req) => req.requestId || "-");
morgan.token("safe-url", (req) => safeRequestPath(req));
app.use(morgan(":method :safe-url :status :response-time ms reqId=:request-id", {
  skip: () => process.env.NODE_ENV === "production"
}));

app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      scriptSrc: ["'none'"],
      styleSrc: ["'none'"],
      imgSrc: ["'none'"],
      connectSrc: ["'self'"],
      fontSrc: ["'none'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'none'"],
      frameSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    }
  },
  // HSTS 2 anos + preload (padrão profissional; Railway já usa HTTPS obrigatório)
  strictTransportSecurity: {
    maxAge: 63072000,
    includeSubDomains: true,
    preload: true
  },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  xFrameOptions: { action: "deny" },
}));

// Permissions-Policy: desabilita tudo que a API não usa
app.use((req, res, next) => {
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()"
  );
  next();
});

// CORS restrito (security fix #8)
// Só o Espaço Prelúdio. Os sites do O SextoLugar (preludiojogos.*,
// luiskirsch.github.io) saíram com o jogo; GAME_ENABLED não os reativa.
const DEFAULT_ALLOWED_ORIGINS = [
  "https://espacopreludio.com.br",
  "https://www.espacopreludio.com.br",
  "http://localhost:3000",
  "http://localhost:8080",
  "http://localhost:5173",
  "https://api.espacopreludio.com.br",
  "https://osl-video-server-production.up.railway.app"
];
const configuredAllowedOrigins = String(process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map(origin => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);
const ALLOWED_ORIGINS = [...new Set([...DEFAULT_ALLOWED_ORIGINS, ...configuredAllowedOrigins])];
app.use(cors({
  origin: (origin, cb) => {
    // Sem Origin (server-to-server, ferramentas de teste, MP webhook) → permite
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(String(origin).replace(/\/$/, ""))) return cb(null, true);
    return cb(null, false);
  },
  credentials: false,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: CORS_ALLOWED_HEADERS,
  maxAge: 600
}));
// WAF: bloqueia scanners conhecidos e path traversal antes do body parsing.
app.use(require("./middleware/clinicalSecurity"));
app.use(waf);

// Bloqueia floods antes de alocar/parsing de corpos potencialmente grandes.
app.use(globalLimiter);

// Stripe webhook ANTES do express.json() — precisa de raw body para validar HMAC.
// express.raw() aplicado só na rota /stripe/webhook dentro do router.
app.use(stripeWebhookRouter);

// 6MB: permite upload de comprovante de matrícula (PDF/imagem em base64)
// para validação automática do tier estudante. Outros endpoints continuam
// validando tamanho específico no handler.
app.use(express.json({ limit: "6mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb", parameterLimit: 1000 }));

// Demais rotas Stripe (create-checkout, portal) — precisam do body JSON parseado.
app.use(stripeRouter);

// --- Disclosure responsável ---
app.get("/.well-known/security.txt", (req, res) => {
  res.type("text/plain").send(
    "Contact: mailto:luishenriquekirsch@hotmail.com\n" +
    "Preferred-Languages: pt, en\n" +
    "Policy: https://github.com/luiskirsch/osl-video-server/blob/luiskirsch.github.io/SECURITY.md\n" +
    "Expires: " + new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toUTCString() + "\n"
  );
});

// --- Montagem de rotas ---
app.use(healthRouter);
app.use(i18nRouter);
app.use(auditLog("conta", { matches: req => /^\/conta\//i.test(req.path) }), accountRouter);
app.use(auditLog("clinical", {
  includeSuccessfulReads: true,
  matches: req => /^\/(?:therapy|institution|rt|empresa|public)(?:\/|$)/i.test(req.path)
}));
app.use(clinicalMfaRouter);
app.use(clinicalPrivacyRouter);
app.use(auditLog("therapy"), therapyRouter);
app.use(auditLog("institution"), institutionRouter);
app.use(auditLog("responsavel-tecnico"), rtRouter);
if (GAME_ENABLED) {
  for (const [category, path] of GAME_ROUTERS) {
    const router = require(path);
    if (category) app.use(auditLog(category), router); else app.use(router);
  }
}

// --- 404 ---
app.use((req, res) => {
  return res.status(404).json({
    ok: false,
    error: "ROTA_NAO_ENCONTRADA",
    requestId: req.requestId || null
  });
});

// --- Error handler ---
app.use((err, req, res, next) => {
  logError("express_error_middleware", err, {
    requestId: req.requestId,
    method: req.method,
    path: safeRequestPath(req)
  });

  // Reporta pro Sentry junto com contexto da request (sem body — pode ter PII)
  if (Sentry) {
    try {
      Sentry.withScope(scope => {
        scope.setTag("requestId", req.requestId || "");
        scope.setTag("path", safeRequestPath(req));
        scope.setTag("method", req.method || "");
        Sentry.captureException(err);
      });
    } catch (_) { /* empty */ }
  }

  if (res.headersSent) return next(err);

  if (err?.type === "entity.too.large") {
    return res.status(413).json({
      ok: false,
      error: "CORPO_MUITO_GRANDE",
      requestId: req.requestId
    });
  }
  if (err instanceof SyntaxError && err?.type === "entity.parse.failed") {
    return res.status(400).json({
      ok: false,
      error: "JSON_INVALIDO",
      requestId: req.requestId
    });
  }

  return res.status(500).json({
    ok: false,
    error: "ERRO_INTERNO",
    requestId: req.requestId
  });
});

// --- Startup ---
const { startCleanupLoop, stopCleanupLoop } = require("./services/cleanup");
const { startSchedulerLoop, stopSchedulerLoop } = require("./services/scheduler");
const { startBackupLoop, stopBackupLoop } = require("./services/backup");
const { getDb: getFirestoreDb, getStorageBucket } = require("./services/firestore");
const sessionDna   = require("./services/sessionDna");
const socialGraph  = require("./services/socialGraph");
const reputation   = require("./services/reputation");
const liveService    = require("./services/liveService");
const achievements   = require("./services/achievements");
const notificationsSvc  = require("./services/notifications");
const recurringGroups   = require("./services/recurringGroups");
const worldStateSvc     = require("./services/worldState");
const activityTracker   = require("./services/activityTracker");
const fragmentEngine    = require("./services/fragmentEngine");
const compatibilitySvc  = require("./services/compatibility");
const selectionAudit    = require("./services/selectionAudit");
const { activeStreams, activeRecordings } = require("./game/state");
const { stopRoomStreaming, stopRoomRecording } = require("./video/webrtc");

const { initSocketIo } = require("./services/socketio");
const httpServer = http.createServer(app);
initSocketIo(httpServer, ALLOWED_ORIGINS);

function initializeService(name, service) {
  try {
    service.init();
    logInfo("service_initialized", { service: name });
  } catch (error) {
    // Um subsistema opcional não pode impedir que os demais registrem seus
    // listeners. Sem esse isolamento, uma falha em Session DNA desligava em
    // cascata social, reputação, conquistas, notificações e mundo.
    logError("service_initialization_failed", error, { service: name });
  }
}

const server = httpServer.listen(PORT, "0.0.0.0", () => {
  logInfo("server_started", { port: PORT, appEnv: APP_ENV });
  startCleanupLoop();
  startSchedulerLoop();
  startBackupLoop({ getDb: getFirestoreDb, getStorageBucket, appEnv: APP_ENV });
  scheduleAuditLogCleanup();
  // Motor do jogo (EventBus): só com GAME_ENABLED — grava em salas, users,
  // daily_ritual, world_state etc.
  if (GAME_ENABLED) [
    ["sessionDna", sessionDna],
    ["socialGraph", socialGraph],
    ["reputation", reputation],
    ["liveService", liveService],
    ["achievements", achievements],
    ["notifications", notificationsSvc],
    ["recurringGroups", recurringGroups],
    ["worldState", worldStateSvc],
    ["activityTracker", activityTracker],
    ["fragmentEngine", fragmentEngine],
    ["compatibility", compatibilitySvc],
    ["selectionAudit", selectionAudit],
  ].forEach(([name, service]) => initializeService(name, service));
  // Base de geolocalização do card de clima leva ~15s; carregar logo após o
  // boot evita que o primeiro colaborador de cada deploy fique sem clima.
  setTimeout(() => require("./services/ambient-weather").warmUp(), 20_000).unref();
  // Resumos IA presos em "processing" por queda brusca do processo anterior.
  setTimeout(() => therapyRouter.sweepStaleAiSummaries?.(), 30_000).unref();
});

async function gracefullyStopAllEgress() {
  // H1: SIGTERM no Railway antes mata egress no meio. Aqui paramos
  // todos jobs ativos pra finalizar arquivos S3 / streams limpinhos.
  const promises = [];
  for (const roomId of activeStreams.keys()) {
    promises.push(stopRoomStreaming(roomId).catch(e => logError("shutdown_stop_stream_error", e, { roomId })));
  }
  for (const roomId of activeRecordings.keys()) {
    promises.push(stopRoomRecording(roomId).catch(e => logError("shutdown_stop_recording_error", e, { roomId })));
  }
  if (promises.length === 0) return;
  logInfo("shutdown_stopping_egress", { count: promises.length });
  await Promise.allSettled(promises);
}

async function shutdown(signal) {
  if (shutdown.inProgress) return;
  shutdown.inProgress = true;
  logWarn("shutdown_started", { signal });
  stopCleanupLoop();
  stopSchedulerLoop();
  stopBackupLoop();
  recurringGroups.stop();

  await gracefullyStopAllEgress();
  // Resumos IA em andamento morrem com o processo: marca "interrompido" para
  // o prontuário oferecer reenvio (o áudio fica guardado no aparelho).
  await therapyRouter.interruptActiveAiSummaries?.().catch(e => logError("shutdown_ai_summary_error", e));

  server.close((err) => {
    if (err) { logError("shutdown_error", err, { signal }); process.exit(1); }
    logInfo("shutdown_completed", { signal });
    process.exit(0);
  });

  setTimeout(() => {
    logWarn("shutdown_forced", { signal });
    process.exit(1);
  }, 15000).unref();
}

process.on("SIGTERM", () => { shutdown("SIGTERM").catch(() => process.exit(1)); });
process.on("SIGINT",  () => { shutdown("SIGINT").catch(() => process.exit(1)); });
