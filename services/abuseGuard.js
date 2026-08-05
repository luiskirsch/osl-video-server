// Sistema central de segurança: banimentos, denúncias e auto-suspensão.
//
// Bans → Firestore `security_bans` (doc ID = uid), com cache in-memory TTL 5min.
// Reports → Firestore `security_reports` (auto-ID).
// Auto-suspensão: 3 denúncias de usuários DISTINTOS → ban automático pelo sistema.
//
// Fail-open: qualquer erro de DB na verificação de ban NÃO bloqueia o usuário —
// nunca punir inocente por falha de infraestrutura.

const { getDb } = require("./firestore");
const { logInfo, logWarn, logError } = require("../logger");

const BAN_CACHE_TTL_MS    = 5 * 60_000; // 5 min
const AUTO_BAN_THRESHOLD  = 3;           // denúncias únicas para auto-suspensão

// Cache positivo de bans — uid → timestamp de expiração
const banCache = new Map();

const VALID_REASONS = [
  "ASSEDIO",        // assédio / mensagens indesejadas
  "NUDEZ",          // conteúdo sexual não consensual em vídeo/foto
  "AMEACA",         // ameaça de violência
  "SPAM",           // flood de mensagens / comportamento automatizado
  "DISCURSO_ODIO",  // discurso de ódio / discriminação
  "OUTRO",          // outro (usar campo comment)
];

// ─── Ban ─────────────────────────────────────────────────────────────────────

async function isUserBanned(uid) {
  const hit = banCache.get(uid);
  if (hit && Date.now() < hit) return true;

  const db = getDb();
  if (!db) return false;

  try {
    const doc = await db.collection("security_bans").doc(uid).get();
    if (doc.exists && doc.data()?.active === true) {
      banCache.set(uid, Date.now() + BAN_CACHE_TTL_MS);
      return true;
    }
    return false;
  } catch (err) {
    logError("ban_check_failed", err, { uid });
    return false; // fail-open
  }
}

function clearBanCache(uid) {
  banCache.delete(uid);
}

async function banUser({ uid, reason, bannedBy = "admin", note = "", autoSuspend = false }) {
  const db = getDb();
  if (!db) throw new Error("DB_NAO_DISPONIVEL");

  await db.collection("security_bans").doc(uid).set({
    uid,
    reason:      String(reason).trim(),
    bannedBy,
    note:        String(note).trim().slice(0, 1000),
    autoSuspend: !!autoSuspend,
    active:      true,
    bannedAt:    Date.now(),
  }, { merge: true });

  banCache.set(uid, Date.now() + BAN_CACHE_TTL_MS);
  logWarn("user_banned", { uid, reason, bannedBy, autoSuspend });
}

async function unbanUser(uid, adminUid = "admin") {
  const db = getDb();
  if (!db) throw new Error("DB_NAO_DISPONIVEL");

  await db.collection("security_bans").doc(uid).update({
    active:      false,
    unbannedAt:  Date.now(),
    unbannedBy:  adminUid,
  });
  clearBanCache(uid);
  logInfo("user_unbanned", { uid, adminUid });
}

// ─── Report ──────────────────────────────────────────────────────────────────

async function reportUser({ reporterUid, reportedUid, reason, comment = "", context = null }) {
  if (!VALID_REASONS.includes(reason)) {
    throw Object.assign(new Error("MOTIVO_INVALIDO"), { code: "MOTIVO_INVALIDO" });
  }
  if (reporterUid === reportedUid) {
    throw Object.assign(new Error("AUTO_DENUNCIA"), { code: "AUTO_DENUNCIA" });
  }

  const db = getDb();
  if (!db) throw new Error("DB_NAO_DISPONIVEL");

  const reportRef = db.collection("security_reports").doc();
  const reportId  = reportRef.id;

  await reportRef.set({
    reportId,
    reporterUid,
    reportedUid,
    reason,
    comment: String(comment).trim().slice(0, 500),
    context,          // { eventId?, roomId? } — contexto onde ocorreu
    status:  "pending",
    createdAt: Date.now(),
  });

  logWarn("user_reported", { reportId, reporterUid, reportedUid, reason, context });

  // Auto-suspensão é assíncrona — não bloqueia a resposta ao usuário
  checkAutoSuspension(reportedUid, db).catch((err) =>
    logError("auto_suspension_check_failed", err, { reportedUid })
  );

  return { reportId };
}

async function checkAutoSuspension(reportedUid, db) {
  const snap = await db.collection("security_reports")
    .where("reportedUid", "==", reportedUid)
    .where("status", "==", "pending")
    .get();

  // Conta apenas denunciantes distintos — 1 pessoa denunciando 3x não conta
  const uniqueReporters = new Set(snap.docs.map(d => d.data().reporterUid));

  if (uniqueReporters.size >= AUTO_BAN_THRESHOLD) {
    await banUser({
      uid:         reportedUid,
      reason:      "AUTO_SUSPENSION_BY_REPORTS",
      bannedBy:    "system",
      autoSuspend: true,
      note:        `${uniqueReporters.size} denúncias de usuários distintos`,
    });
  }
}

// ─── Admin ───────────────────────────────────────────────────────────────────

async function listReports({ status = null, limit = 50 } = {}) {
  const db = getDb();
  if (!db) return [];
  let q = db.collection("security_reports").orderBy("createdAt", "desc").limit(limit);
  if (status) q = q.where("status", "==", status);
  const snap = await q.get();
  return snap.docs.map(d => d.data());
}

async function reviewReport(reportId, { status, reviewedBy = "admin" }) {
  const VALID_STATUSES = ["reviewed", "dismissed"];
  if (!VALID_STATUSES.includes(status)) throw new Error("STATUS_INVALIDO");
  const db = getDb();
  if (!db) throw new Error("DB_NAO_DISPONIVEL");
  await db.collection("security_reports").doc(reportId).update({
    status,
    reviewedBy,
    reviewedAt: Date.now(),
  });
  logInfo("report_reviewed", { reportId, status, reviewedBy });
}

async function listBans({ activeOnly = true } = {}) {
  const db = getDb();
  if (!db) return [];
  let q = db.collection("security_bans").orderBy("bannedAt", "desc").limit(100);
  if (activeOnly) q = q.where("active", "==", true);
  const snap = await q.get();
  return snap.docs.map(d => d.data());
}

// ─── Middleware Express ───────────────────────────────────────────────────────

async function requireNotBanned(req, res, next) {
  const uid = req.firebaseUid;
  if (!uid) return next();
  const banned = await isUserBanned(uid);
  if (banned) {
    logWarn("banned_user_blocked", { uid, path: req.originalUrl });
    return res.status(403).json({ ok: false, error: "USUARIO_SUSPENSO" });
  }
  return next();
}

module.exports = {
  VALID_REASONS,
  isUserBanned, clearBanCache,
  banUser, unbanUser,
  reportUser,
  listReports, reviewReport, listBans,
  requireNotBanned,
};
