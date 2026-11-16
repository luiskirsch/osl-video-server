// Middleware de audit logging para endpoints sensíveis.
// Grava quem fez o quê, quando e de onde — estrutura compatível com o logger.js.
// Os logs também vão para Firestore audit_logs/ e ficam 6 meses (Marco Civil,
// art. 15); a remoção é feita por jobs/auditLogCleanup.js.

const { logInfo } = require("../logger");
const { safeRequestPath } = require("../utils");

let _db = null;
function getDb() {
  if (!_db) {
    try { _db = require("../services/firestore").getDb(); } catch (_) { /* sem Firestore em dev */ }
  }
  return _db;
}

const AUDIT_RETENTION_MS = 183 * 24 * 60 * 60 * 1000; // 6 meses

function extractUid(req) {
  // Somente identidade comprovada pelo middleware de autenticação.
  return req.firebaseUid || null;
}

async function writeAuditDoc(entry) {
  try {
    const db = getDb();
    if (!db) return;
    const expireAt = new Date(Date.now() + AUDIT_RETENTION_MS);
    await db.collection("audit_logs").add({ ...entry, expireAt });
  } catch (_) {
    // Nunca deixar falha de audit quebrar a request
  }
}

// Registra o listener de auditoria da request; devolve a função que o remove.
function watchRequest(req, res, category, includeSuccessfulReads) {
  const started = Date.now();
  const onFinish = () => {
    // Não auditar health checks e rotas públicas de leitura bem-sucedidas
    if (!includeSuccessfulReads && req.method === "GET" && res.statusCode < 400) return;

    const entry = {
      time: new Date().toISOString(),
      category,
      method: req.method,
      path: safeRequestPath(req),
      statusCode: res.statusCode,
      durationMs: Date.now() - started,
      uid: extractUid(req),
      ip: req.ip || req.socket?.remoteAddress || null,
      userAgent: String(req.headers["user-agent"] || "").slice(0, 512) || null,
      requestId: req.requestId || null,
      roomId: String(req.body?.roomId || "").slice(0, 128) || null,
    };

    logInfo("audit_event", entry);
    writeAuditDoc(entry);
  };
  res.once("finish", onFinish);
  return () => res.removeListener("finish", onFinish);
}

// Fábrica: retorna middleware que loga ações em endpoints sensíveis.
// category: string curta que identifica o grupo (ex: "admin", "ritual", "payment")
function auditLog(category, { includeSuccessfulReads = false, matches = null } = {}) {
  return (req, res, next) => {
    if (matches && !matches(req)) return next();
    watchRequest(req, res, category, includeSuccessfulReads);
    next();
  };
}

// Audita só as requests que ESTE router responde. `app.use(auditLog(c), router)`
// sem caminho rodava o auditLog de todos os routers em cada request: um
// heartbeat virava 8 documentos em audit_logs, cada um com uma categoria
// errada (e estourava o limite de listeners de "finish"). Se o router repassa
// a request adiante (next() sem erro), o registro é descartado.
function auditedRouter(category, router, { includeSuccessfulReads = false } = {}) {
  const middleware = (req, res, next) => {
    const detach = watchRequest(req, res, category, includeSuccessfulReads);
    router(req, res, (err) => {
      if (!err) detach();
      next(err);
    });
  };
  // Quem percorre a árvore de rotas (buckets do rate limit em
  // services/rateLimit.js, DUMP_ROUTES do server.js) procura `handle.stack`.
  middleware.stack = router.stack;
  return middleware;
}

module.exports = { auditLog, auditedRouter, AUDIT_RETENTION_MS };
