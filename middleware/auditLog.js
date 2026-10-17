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

// Fábrica: retorna middleware que loga ações em endpoints sensíveis.
// category: string curta que identifica o grupo (ex: "admin", "ritual", "payment")
function auditLog(category, { includeSuccessfulReads = false, matches = null } = {}) {
  return (req, res, next) => {
    if (matches && !matches(req)) return next();
    const started = Date.now();

    res.on("finish", () => {
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
    });

    next();
  };
}

module.exports = { auditLog, AUDIT_RETENTION_MS };
