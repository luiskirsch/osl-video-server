// Bootstrap: error handlers precisam ser os primeiros
const { logInfo, logWarn, logError } = require("./logger");

process.on("uncaughtException", (err) => {
  logError("uncaughtException", err);
});

process.on("unhandledRejection", (reason) => {
  logError("unhandledRejection", reason instanceof Error ? reason : new Error(String(reason)));
});

const express = require("express");
const helmet  = require("helmet");
const cors    = require("cors");
const morgan  = require("morgan");

const { PORT, APP_ENV } = require("./config");
const { createRequestId } = require("./utils");

// --- Rotas ---
const healthRouter    = require("./routes/health");
const gameRouter      = require("./routes/game");
const recordingRouter = require("./routes/recording");
const streamingRouter = require("./routes/streaming");
const discordRouter   = require("./routes/discord");
const paymentsRouter  = require("./routes/payments");
const licenseRouter   = require("./routes/license");
const affiliateRouter = require("./routes/affiliate");
const adminRouter     = require("./routes/admin");
const aiRouter        = require("./routes/ai");

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
  "https://luiskirsch.github.io",
  "http://localhost:3000",
  "http://localhost:8080",
  "http://localhost:5173"
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
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

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

  if (res.headersSent) return next(err);

  return res.status(500).json({
    ok: false,
    error: "ERRO_INTERNO",
    requestId: req.requestId
  });
});

// --- Startup ---
const { startCleanupLoop, stopCleanupLoop } = require("./services/cleanup");
const { activeStreams, activeRecordings } = require("./game/state");
const { stopRoomStreaming, stopRoomRecording } = require("./video/webrtc");

const server = app.listen(PORT, "0.0.0.0", () => {
  logInfo("server_started", { port: PORT, appEnv: APP_ENV });
  startCleanupLoop();
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
