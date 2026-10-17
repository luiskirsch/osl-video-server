// Limpeza diária de audit_logs com mais de 6 meses — o mínimo de guarda dos
// registros de acesso exigido pelo Marco Civil da Internet (art. 15), sem
// reter IP/navegador além disso (LGPD, necessidade). Substitui a TTL policy
// do Firestore (requer billing). Usa o campo `time` (ISO, gravado na criação)
// para valer também para registros antigos, criados com expireAt de 90 dias.

const { logInfo, logError } = require("../logger");
const { AUDIT_RETENTION_MS } = require("../middleware/auditLog");

const BATCH_SIZE = 400;

async function runAuditLogCleanup({ db = require("../services/firestore").getDb(), now = new Date() } = {}) {
  if (!db) return 0;

  const cutoff = new Date(now.getTime() - AUDIT_RETENTION_MS).toISOString();
  let total = 0;

  try {
    while (true) {
      const snap = await db.collection("audit_logs")
        .where("time", "<", cutoff)
        .limit(BATCH_SIZE)
        .get();

      if (snap.empty) break;

      const batch = db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      total += snap.docs.length;

      if (snap.docs.length < BATCH_SIZE) break;
    }

    logInfo("audit_log_cleanup", { deleted: total, cutoff, ranAt: now.toISOString() });
  } catch (err) {
    logError("audit_log_cleanup_error", err);
  }
  return total;
}

const MS_24H = 24 * 60 * 60 * 1000;

function scheduleAuditLogCleanup() {
  // Primeira execução após 1 minuto (servidor já estável)
  setTimeout(() => {
    runAuditLogCleanup();
    setInterval(runAuditLogCleanup, MS_24H).unref();
  }, 60 * 1000).unref();
}

module.exports = { scheduleAuditLogCleanup, runAuditLogCleanup };
