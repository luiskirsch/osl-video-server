// Limpeza diária de audit_logs expirados.
// Substitui Firestore TTL policy (requer billing) — deleta documentos onde
// expireAt < now(), em lotes de 400 para respeitar limite de batch do Firestore.

const { logInfo, logError } = require("../logger");

const BATCH_SIZE = 400;

async function runAuditLogCleanup() {
  let db;
  try {
    db = require("../services/firestore").db;
  } catch (_) {
    return;
  }
  if (!db) return;

  const now = new Date();
  let total = 0;

  try {
    while (true) {
      const snap = await db.collection("audit_logs")
        .where("expireAt", "<", now)
        .limit(BATCH_SIZE)
        .get();

      if (snap.empty) break;

      const batch = db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      total += snap.docs.length;

      if (snap.docs.length < BATCH_SIZE) break;
    }

    logInfo("audit_log_cleanup", { deleted: total, ranAt: now.toISOString() });
  } catch (err) {
    logError("audit_log_cleanup_error", err);
  }
}

const MS_24H = 24 * 60 * 60 * 1000;

function scheduleAuditLogCleanup() {
  // Primeira execução após 1 minuto (servidor já estável)
  setTimeout(() => {
    runAuditLogCleanup();
    setInterval(runAuditLogCleanup, MS_24H).unref();
  }, 60 * 1000).unref();
}

module.exports = { scheduleAuditLogCleanup };
