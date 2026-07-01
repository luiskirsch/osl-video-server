const express = require("express");
const admin  = require("firebase-admin");
const { logError } = require("../logger");
const { asyncHandler, sendError, normalizeUid, normalizeEmail, formatFirestoreDate } = require("../utils");
const { ensureDb, getDb } = require("../services/firestore");
const { ensureAffiliateProfile } = require("../services/affiliate");
const { verifyFirebaseToken } = require("../services/auth");
const { FRONTEND_BASE_URL, REFERRAL_MIN_WITHDRAW_COINS, REFERRAL_WITHDRAW_PIX_VALUE } = require("../config");

const router = express.Router();

function formatAffiliate(affiliate) {
  return {
    uid: affiliate.uid,
    nome: affiliate.nome || "",
    email: affiliate.email || "",
    refCode: affiliate.refCode,
    referralLink: `${FRONTEND_BASE_URL}/vendas.html?ref=${affiliate.refCode}`,
    coins: Number(affiliate.coins || 0),
    withdrawableCoins: Number(affiliate.withdrawableCoins || 0),
    referralsApproved: Number(affiliate.referralsApproved || 0),
    referralsPending: Number(affiliate.referralsPending || 0),
    commissionApproved: Number(affiliate.commissionApproved || 0),
    totalPaidOutBRL: Number(affiliate.totalPaidOutBRL || 0),
    pixKey: affiliate.pixKey || ""
  };
}

// POST /afiliado/garantir
router.post("/afiliado/garantir", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;

  const authUid = await verifyFirebaseToken(req, res);
  if (!authUid) return;

  const email = normalizeEmail(req.body?.email);
  const nome  = String(req.body?.nome || "").trim().slice(0, 80);

  const affiliate = await ensureAffiliateProfile({ uid: authUid, email, nome });
  return res.json({ ok: true, affiliate: formatAffiliate(affiliate) });
}));

// GET /afiliado/perfil/:uid
router.get("/afiliado/perfil/:uid", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;

  const authUid = await verifyFirebaseToken(req, res);
  if (!authUid) return;

  const uid = normalizeUid(req.params.uid);
  if (!uid) return sendError(res, 400, "UID_OBRIGATORIO");
  if (authUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  const db   = getDb();
  const snap = await db.collection("affiliates").doc(uid).get();
  if (!snap.exists) return sendError(res, 404, "AFILIADO_NAO_ENCONTRADO");

  return res.json({ ok: true, affiliate: formatAffiliate(snap.data()) });
}));

// GET /afiliado/historico/:uid
router.get("/afiliado/historico/:uid", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;

  const authUid = await verifyFirebaseToken(req, res);
  if (!authUid) return;

  const uid = normalizeUid(req.params.uid);
  if (!uid) return sendError(res, 400, "UID_OBRIGATORIO");
  if (authUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  const db = getDb();

  const [referralsSnap, withdrawsSnap] = await Promise.all([
    db.collection("referrals").where("referrerUid", "==", uid).orderBy("createdAt", "desc").limit(50).get(),
    db.collection("withdrawRequests").where("uid", "==", uid).orderBy("createdAt", "desc").limit(50).get()
  ]);

  const history = [];

  referralsSnap.forEach((docSnap) => {
    const data = docSnap.data();
    history.push({
      id: docSnap.id,
      type: data.status === "approved" ? "indicação aprovada" : "indicação pendente",
      status: data.status || "pending",
      buyerEmail: data.buyerEmail || "",
      buyerName: data.buyerName || "",
      coinsAwarded: Number(data.coinsAwarded || 0),
      commissionAmount: Number(data.commissionAmount || 0),
      externalReference: data.externalReference || data.referralId || docSnap.id,
      createdAt: formatFirestoreDate(data.approvedAt || data.createdAt)
    });
  });

  withdrawsSnap.forEach((docSnap) => {
    const data = docSnap.data();
    history.push({
      id: docSnap.id, type: "saque", status: data.status || "pending",
      buyerEmail: "", buyerName: "",
      coinsAwarded: -Math.abs(Number(data.coinsUsed || 0)),
      commissionAmount: Number(data.amountBRL || 0),
      externalReference: docSnap.id,
      createdAt: formatFirestoreDate(data.createdAt)
    });
  });

  history.sort((a, b) => {
    const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return timeB - timeA;
  });

  return res.json({ ok: true, history: history.slice(0, 100) });
}));

// GET /afiliado/saques/:uid
router.get("/afiliado/saques/:uid", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;

  const authUid = await verifyFirebaseToken(req, res);
  if (!authUid) return;

  const uid = normalizeUid(req.params.uid);
  if (!uid) return sendError(res, 400, "UID_OBRIGATORIO");
  if (authUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  const db   = getDb();
  const snap = await db.collection("withdrawRequests").where("uid", "==", uid).orderBy("createdAt", "desc").limit(100).get();

  const withdrawals = snap.docs.map((docSnap) => {
    const item = docSnap.data();
    return {
      id: docSnap.id, uid: item.uid || "", nome: item.nome || "", email: item.email || "",
      pixKey: item.pixKey || "", coinsUsed: Number(item.coinsUsed || 0), amountBRL: Number(item.amountBRL || 0),
      status: item.status || "pending",
      createdAt: formatFirestoreDate(item.createdAt), updatedAt: formatFirestoreDate(item.updatedAt)
    };
  });

  return res.json({ ok: true, withdrawals });
}));

// POST /afiliado/pix
router.post("/afiliado/pix", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;

  const authUid = await verifyFirebaseToken(req, res);
  if (!authUid) return;

  const pixKey = String(req.body?.pixKey || "").trim().slice(0, 160);
  if (!pixKey) return sendError(res, 400, "PIX_OBRIGATORIO");

  const db = getDb();
  await db.collection("affiliates").doc(authUid).set({ pixKey, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  return res.json({ ok: true, pixKey });
}));

// POST /afiliado/solicitar-saque
router.post("/afiliado/solicitar-saque", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;

  const authUid = await verifyFirebaseToken(req, res);
  if (!authUid) return;

  const uid = authUid;

  const db           = getDb();
  const affiliateRef = db.collection("affiliates").doc(uid);
  const snap         = await affiliateRef.get();

  if (!snap.exists) return sendError(res, 404, "AFILIADO_NAO_ENCONTRADO");

  const affiliate       = snap.data();
  const withdrawableCoins = Number(affiliate.withdrawableCoins || 0);
  const pixKey          = String(affiliate.pixKey || "").trim();

  if (!pixKey) return sendError(res, 400, "PIX_NAO_CADASTRADO");
  if (withdrawableCoins < REFERRAL_MIN_WITHDRAW_COINS) return sendError(res, 400, "SALDO_INSUFICIENTE", { minCoins: REFERRAL_MIN_WITHDRAW_COINS });

  const withdrawRef = db.collection("withdrawRequests").doc();

  await db.runTransaction(async (tx) => {
    const affiliateSnap = await tx.get(affiliateRef);
    const latest        = affiliateSnap.data();
    const latestCoins   = Number(latest.withdrawableCoins || 0);

    if (latestCoins < REFERRAL_MIN_WITHDRAW_COINS) throw new Error("SALDO_INSUFICIENTE");

    tx.set(withdrawRef, {
      uid, nome: latest.nome || "", email: latest.email || "", pixKey: latest.pixKey || "",
      coinsUsed: REFERRAL_MIN_WITHDRAW_COINS, amountBRL: REFERRAL_WITHDRAW_PIX_VALUE,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    tx.set(affiliateRef, {
      withdrawableCoins: admin.firestore.FieldValue.increment(-REFERRAL_MIN_WITHDRAW_COINS),
      totalPaidOutBRL: admin.firestore.FieldValue.increment(REFERRAL_WITHDRAW_PIX_VALUE),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });

  return res.json({ ok: true, message: "Solicitação de saque criada com sucesso.", amountBRL: REFERRAL_WITHDRAW_PIX_VALUE, coinsUsed: REFERRAL_MIN_WITHDRAW_COINS });
}));

module.exports = router;
