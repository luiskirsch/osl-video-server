// Middleware de audit logging para endpoints sensíveis.
// Grava quem fez o quê, quando e de onde — estrutura compatível com o logger.js.
// Os logs também vão para Firestore audit_logs/ com TTL de 90 dias
// (configurar TTL policy no Firestore Console → audit_logs → campo expireAt).

const { logInfo } = require("../logger");

let _db = null;
function getDb() {
  if (!_db) {
    try { _db = require("../services/firestore").db; } catch (_) { /* sem Firestore em dev */ }
  }
  return _db;
}

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

function extractUid(req) {
  // Tenta extrair UID de diferentes fontes: body, header, token decodificado
  return req.uid || req.body?.uid || req.body?.participantId || null;
}

async function writeAuditDoc(entry) {
  try {
    const db = getDb();
    if (!db) return;
    const expireAt = new Date(Date.now() + NINETY_DAYS_MS);
    await db.collection("audit_logs").add({ ...entry, expireAt });
  } catch (_) {
    // Nunca deixar falha de audit quebrar a request
  }
}

// Fábrica: retorna middleware que loga ações em endpoints sensíveis.
// category: string curta que identifica o grupo (ex: "admin", "ritual", "payment")
function auditLog(category) {
  return (req, res, next) => {
    const started = Date.now();

    res.on("finish", () => {
      // Não auditar health checks e rotas públicas de leitura bem-sucedidas
      if (req.method === "GET" && res.statusCode < 400) return;

      const entry = {
        time: new Date().toISOString(),
        category,
        method: req.method,
        path: req.route?.path || req.originalUrl,
        statusCode: res.statusCode,
        durationMs: Date.now() - started,
        uid: extractUid(req),
        ip: req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
          || req.socket?.remoteAddress
          || null,
        userAgent: req.headers["user-agent"] || null,
        requestId: req.requestId || null,
        roomId: req.body?.roomId || null,
      };

      logInfo("audit_event", entry);
      writeAuditDoc(entry);
    });

    next();
  };
}

module.exports = { auditLog };
