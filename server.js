// Bootstrap: dotenv pra rodar local com .env (Railway já injeta env vars
// nativamente, então em prod isso vira no-op). Tem que ser ANTES de
// qualquer require que use process.env.
try { require("dotenv").config(); } catch (_) { /* dotenv opcional em prod */ }

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

const { PORT, APP_ENV } = require("./config");
const { createRequestId } = require("./utils");

// --- Rotas ---
const healthRouter    = require("./routes/health");
const { router: stripeRouter, webhookRouter: stripeWebhookRouter } = require("./routes/stripe");
const gameRouter      = require("./routes/game");
const recordingRouter = require("./routes/recording");
const streamingRouter = require("./routes/streaming");
const discordRouter   = require("./routes/discord");
const paymentsRouter  = require("./routes/payments");
const licenseRouter   = require("./routes/license");
const affiliateRouter = require("./routes/affiliate");
const adminRouter     = require("./routes/admin");
const aiRouter        = require("./routes/ai");
const therapyRouter   = require("./routes/therapy");
const baggioRouter    = require("./routes/baggio");
const encontroRouter  = require("./routes/encontro");

// --- App ---
const app = express();

app.disable("x-powered-by");
app.set("trust proxy", true);

app.use(helmet({ crossOriginResourcePolicy: false, contentSecurityPolicy: false }));

// CORS restrito (security fix #8)
const ALLOWED_ORIGINS = [
  "https://preludiojogos.com",
  "https://www.preludiojogos.com",
  "https://preludiojogos.com.br",
  "https://www.preludiojogos.com.br",
  "https://espacopreludio.com.br",
  "https://www.espacopreludio.com.br",
  "https://luiskirsch.github.io",
  "http://localhost:3000",
  "http://localhost:8080",
  "http://localhost:5173",
  "https://osl-video-server-production.up.railway.app"
];
app.use(cors({
  origin: (origin, cb) => {
    // Sem Origin (server-to-server, ferramentas de teste, MP webhook) → permite
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("CORS_BLOQUEADO"));
  },
  credentials: false
}));
// Stripe webhook ANTES do express.json() — precisa de raw body para validar HMAC.
// express.raw() aplicado só na rota /stripe/webhook dentro do router.
app.use(stripeWebhookRouter);

// 6MB: permite upload de comprovante de matrícula (PDF/imagem em base64)
// para validação automática do tier estudante. Outros endpoints continuam
// validando tamanho específico no handler.
app.use(express.json({ limit: "6mb" }));
app.use(express.urlencoded({ extended: true, limit: "6mb" }));

// Demais rotas Stripe (create-checkout, portal) — precisam do body JSON parseado.
app.use(stripeRouter);

// Request ID + log estruturado por requisição
app.use((req, res, next) => {
  req.requestId = createRequestId();
  res.setHeader("X-Request-Id", req.requestId);

  const start = Date.now();
  res.on("finish", () => {
    logInfo("http_request", {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Date.now() - start,
      ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || null
    });
  });

  next();
});

morgan.token("request-id", (req) => req.requestId || "-");
app.use(morgan(":method :url :status :response-time ms reqId=:request-id", {
  skip: () => process.env.NODE_ENV === "production"
}));

// --- Montagem de rotas ---
app.use(healthRouter);
app.use(gameRouter);
app.use(recordingRouter);
app.use(streamingRouter);
app.use(discordRouter);
app.use(paymentsRouter);
app.use(licenseRouter);
app.use(affiliateRouter);
app.use(adminRouter);
app.use(aiRouter);
app.use(therapyRouter);
app.use(baggioRouter);
app.use(encontroRouter);

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
    path: req.originalUrl
  });

  // Reporta pro Sentry junto com contexto da request (sem body — pode ter PII)
  if (Sentry) {
    try {
      Sentry.withScope(scope => {
        scope.setTag("requestId", req.requestId || "");
        scope.setTag("path", req.originalUrl || "");
        scope.setTag("method", req.method || "");
        Sentry.captureException(err);
      });
    } catch (_) { /* empty */ }
  }

  if (res.headersSent) return next(err);

  return res.status(500).json({
    ok: false,
    error: "ERRO_INTERNO",
    requestId: req.requestId
  });
});

// --- Startup ---
const { startCleanupLoop, stopCleanupLoop } = require("./services/cleanup");
const { startSchedulerLoop, stopSchedulerLoop } = require("./services/scheduler");
const { activeStreams, activeRecordings } = require("./game/state");
const { stopRoomStreaming, stopRoomRecording } = require("./video/webrtc");

const { initSocketIo } = require("./services/socketio");
const httpServer = http.createServer(app);
initSocketIo(httpServer, ALLOWED_ORIGINS);

const server = httpServer.listen(PORT, "0.0.0.0", () => {
  logInfo("server_started", { port: PORT, appEnv: APP_ENV });
  startCleanupLoop();
  startSchedulerLoop();
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
  logWarn("shutdown_started", { signal });
  stopCleanupLoop();
  stopSchedulerLoop();

  await gracefullyStopAllEgress();

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
