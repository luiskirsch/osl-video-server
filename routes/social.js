const express   = require("express");
const rateLimit = require("express-rate-limit");
const admin      = require("firebase-admin");
const { getDb }             = require("../services/firestore");
const { logInfo, logError } = require("../logger");
const { asyncHandler, sendError } = require("../utils");
const socialGraph = require("../services/socialGraph");
const reputation  = require("../services/reputation");

const router = express.Router();

const socialLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: "RATE_LIMIT_SOCIAL" }
});

// Extrai UID a partir do token no header Authorization OU body.firebaseIdToken
async function getUidFromReq(req) {
  const headerToken = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const bodyToken   = req.body?.firebaseIdToken || "";
  const token = headerToken || bodyToken;
  if (!token) return null;
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return decoded.uid;
  } catch (_) { return null; }
}

// ── POST /social/friend-request ──────────────────────────────────────────────
// Envia pedido de amizade. Idempotente: repetir não gera duplicatas.
// Auto-aceita se o target já enviou pedido para o requester.
router.post("/social/friend-request", socialLimiter, asyncHandler(async (req, res) => {
  const { targetUid } = req.body || {};
  if (!targetUid) return sendError(res, 400, "TARGET_UID_OBRIGATORIO");

  const requesterUid = await getUidFromReq(req);
  if (!requesterUid) return sendError(res, 401, "TOKEN_INVALIDO");
  if (requesterUid === targetUid) return sendError(res, 400, "NAO_PODE_ADICIONAR_SI_MESMO");

  const db = getDb();
  if (!db) return sendError(res, 503, "DB_INDISPONIVEL");

  const requesterRef = db.collection("users").doc(requesterUid);
  const targetRef    = db.collection("users").doc(targetUid);

  try {
    let status = "pending";
    await db.runTransaction(async (tx) => {
      const [requesterSnap, targetSnap] = await Promise.all([tx.get(requesterRef), tx.get(targetRef)]);
      if (!requesterSnap.exists || !targetSnap.exists) throw Object.assign(new Error(), { code: 404 });

      const rData = requesterSnap.data();

      if ((rData.friends || []).includes(targetUid)) { status = "already_friends"; return; }
      if ((rData.outgoingRequests || []).includes(targetUid)) { status = "already_pending"; return; }

      // Target já enviou pedido → aceitar automaticamente
      if ((rData.incomingRequests || []).includes(targetUid)) {
        tx.update(requesterRef, {
          friends: admin.firestore.FieldValue.arrayUnion(targetUid),
          incomingRequests: admin.firestore.FieldValue.arrayRemove(targetUid),
        });
        tx.update(targetRef, {
          friends: admin.firestore.FieldValue.arrayUnion(requesterUid),
          outgoingRequests: admin.firestore.FieldValue.arrayRemove(requesterUid),
        });
        status = "auto_accepted";
        return;
      }

      tx.update(requesterRef, { outgoingRequests: admin.firestore.FieldValue.arrayUnion(targetUid) });
      tx.update(targetRef,    { incomingRequests: admin.firestore.FieldValue.arrayUnion(requesterUid) });
    });

    logInfo("friend_request", { requesterUid, targetUid, status });
    return res.json({ ok: true, status });
  } catch (e) {
    if (e.code === 404) return sendError(res, 404, "USUARIO_NAO_ENCONTRADO");
    logError("friend_request_error", { error: e.message });
    return sendError(res, 500, "ERRO_FRIEND_REQUEST");
  }
}));

// ── POST /social/friend-respond ──────────────────────────────────────────────
// Aceita ou rejeita pedido de amizade recebido. Idempotente.
router.post("/social/friend-respond", socialLimiter, asyncHandler(async (req, res) => {
  const { requesterUid, action } = req.body || {};
  if (!requesterUid || !["accept", "reject"].includes(action)) return sendError(res, 400, "CAMPOS_INVALIDOS");

  const responderUid = await getUidFromReq(req);
  if (!responderUid) return sendError(res, 401, "TOKEN_INVALIDO");

  const db = getDb();
  if (!db) return sendError(res, 503, "DB_INDISPONIVEL");

  const responderRef = db.collection("users").doc(responderUid);
  const requesterRef = db.collection("users").doc(requesterUid);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(responderRef);
    if (!snap.exists) return;

    const incoming = snap.data().incomingRequests || [];
    if (!incoming.includes(requesterUid)) return; // Já processado — idempotente

    if (action === "accept") {
      tx.update(responderRef, {
        friends: admin.firestore.FieldValue.arrayUnion(requesterUid),
        incomingRequests: admin.firestore.FieldValue.arrayRemove(requesterUid),
      });
      tx.update(requesterRef, {
        friends: admin.firestore.FieldValue.arrayUnion(responderUid),
        outgoingRequests: admin.firestore.FieldValue.arrayRemove(responderUid),
      });
    } else {
      tx.update(responderRef, { incomingRequests: admin.firestore.FieldValue.arrayRemove(requesterUid) });
      tx.update(requesterRef, { outgoingRequests: admin.firestore.FieldValue.arrayRemove(responderUid) });
    }
  });

  logInfo("friend_respond", { responderUid, requesterUid, action });
  return res.json({ ok: true });
}));

// ── GET /social/leaderboard ───────────────────────────────────────────────────
// Retorna amigos (+ self) ordenados por XP decrescente.
router.get("/social/leaderboard", asyncHandler(async (req, res) => {
  const uid = await getUidFromReq(req);
  if (!uid) return sendError(res, 401, "TOKEN_INVALIDO");

  const db = getDb();
  if (!db) return sendError(res, 503, "DB_INDISPONIVEL");

  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists) return res.json({ ok: true, leaderboard: [] });

  const friendUids = (userSnap.data().friends || []).slice(0, 19); // máx 19 + self = 20
  const allUids    = [uid, ...friendUids];

  const { levelFromXP } = require("../data/cards");

  const snaps = await Promise.all(allUids.map(u => db.collection("users").doc(u).get()));

  const leaderboard = snaps
    .filter(s => s.exists)
    .map(s => {
      const d  = s.data();
      const xp = d.xp || 0;
      return {
        uid:           s.id,
        isSelf:        s.id === uid,
        displayName:   d.displayName   || "Jogador",
        username:      d.username      || "jogador",
        avatarEmoji:   d.avatarEmoji   || "🔮",
        avatarColor:   d.avatarColor   || "#342718",
        avatarPhotoUrl: d.avatarPhotoUrl || null,
        xp,
        level: levelFromXP(xp),
      };
    })
    .sort((a, b) => b.xp - a.xp);

  return res.json({ ok: true, leaderboard });
}));

// ── GET /social/search?q=query ────────────────────────────────────────────────
// Busca jogadores por @username (prefix match). Exclui o próprio usuário.
router.get("/social/search", socialLimiter, asyncHandler(async (req, res) => {
  const uid = await getUidFromReq(req);
  if (!uid) return sendError(res, 401, "TOKEN_INVALIDO");

  const q = String(req.query.q || "").trim().toLowerCase().replace(/^@/, "");
  if (q.length < 2) return res.json({ ok: true, results: [] });

  const db = getDb();
  if (!db) return sendError(res, 503, "DB_INDISPONIVEL");

  const snap = await db.collection("users")
    .where("username", ">=", q)
    .where("username", "<", q + "")
    .limit(6)
    .get();

  const results = snap.docs
    .filter(d => d.id !== uid)
    .slice(0, 5)
    .map(d => {
      const data = d.data();
      return {
        uid:           d.id,
        displayName:   data.displayName   || "Jogador",
        username:      data.username      || "jogador",
        avatarEmoji:   data.avatarEmoji   || "🔮",
        avatarColor:   data.avatarColor   || "#342718",
        avatarPhotoUrl: data.avatarPhotoUrl || null,
      };
    });

  return res.json({ ok: true, results });
}));

// ── GET /social/connections ───────────────────────────────────────────────────
// Retorna co-jogadores automáticos ordenados por sessões juntos.
router.get("/social/connections", asyncHandler(async (req, res) => {
  const uid = await getUidFromReq(req);
  if (!uid) return sendError(res, 401, "TOKEN_INVALIDO");

  const limit = Math.min(Number(req.query.limit || 20), 50);
  const connections = await socialGraph.getConnections(uid, limit);
  return res.json({ ok: true, connections });
}));

// ── GET /social/reputation ────────────────────────────────────────────────────
// Reputação do próprio jogador.
router.get("/social/reputation", asyncHandler(async (req, res) => {
  const uid = await getUidFromReq(req);
  if (!uid) return sendError(res, 401, "TOKEN_INVALIDO");

  const rep = await reputation.getReputation(uid);
  if (!rep) return res.json({ ok: true, reputation: null });
  return res.json({ ok: true, reputation: rep });
}));

// ── GET /social/reputation/:uid ───────────────────────────────────────────────
// Reputação pública de outro jogador.
router.get("/social/reputation/:uid", asyncHandler(async (req, res) => {
  const selfUid = await getUidFromReq(req);
  if (!selfUid) return sendError(res, 401, "TOKEN_INVALIDO");

  const targetUid = String(req.params.uid || "").trim();
  if (!targetUid) return sendError(res, 400, "UID_OBRIGATORIO");

  const rep = await reputation.getReputation(targetUid);
  if (!rep) return res.json({ ok: true, reputation: null });
  return res.json({ ok: true, reputation: rep });
}));

module.exports = router;
