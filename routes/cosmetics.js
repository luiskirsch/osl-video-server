const express  = require("express");
const rateLimit = require("express-rate-limit");
const admin     = require("firebase-admin");
const { getDb }             = require("../services/firestore");
const { logInfo, logError } = require("../logger");
const { asyncHandler, sendError } = require("../utils");

const router = express.Router();

const cosmeticsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: "RATE_LIMIT_COSMETICS" }
});

// Catálogo de cosméticos compráveis com moedas (não com dinheiro real).
// Mantido aqui como fonte da verdade — frontend lê via GET /cosmetics/catalog.
const COIN_CATALOG = {
  "bg-crepusculo": { title: "Fundo Crepúsculo",  tipo: "cosmetico", coins: 200 },
  "bg-pedra":      { title: "Fundo Pedra Fria",  tipo: "cosmetico", coins: 200 },
  "bg-espelho":    { title: "Fundo Espelho",      tipo: "cosmetico", coins: 300 },
  "card-cinza":    { title: "Estilo Ardósia",     tipo: "cosmetico", coins: 300 },
  "fx-centelhas":  { title: "Efeito Centelhas",   tipo: "cosmetico", coins: 250 },
};

async function getUidFromReq(req) {
  const token = ((req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim()) || (req.body?.firebaseIdToken || "");
  if (!token) return null;
  try { const d = await admin.auth().verifyIdToken(token); return d.uid; } catch (_) { return null; }
}

// GET /cosmetics/catalog — público, retorna o catálogo de cosméticos por moedas
router.get("/cosmetics/catalog", asyncHandler(async (_req, res) => {
  return res.json({ ok: true, catalog: COIN_CATALOG });
}));

// POST /cosmetics/buy-with-coins
// Body: { cosmeticId, firebaseIdToken }
// Debita moedas e registra compra em Firestore numa transação atômica.
router.post("/cosmetics/buy-with-coins", cosmeticsLimiter, asyncHandler(async (req, res) => {
  const { cosmeticId } = req.body || {};
  if (!cosmeticId) return sendError(res, 400, "COSMETIC_ID_OBRIGATORIO");

  const item = COIN_CATALOG[cosmeticId];
  if (!item) return sendError(res, 400, "COSMETICO_INVALIDO");

  const uid = await getUidFromReq(req);
  if (!uid) return sendError(res, 401, "TOKEN_INVALIDO");

  const db = getDb();
  if (!db) return sendError(res, 503, "DB_INDISPONIVEL");

  const userRef = db.collection("users").doc(uid);
  let compra, newCoinBalance;

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw Object.assign(new Error("user_not_found"), { code: 404 });

      const data  = snap.data();
      const coins = data.coins || 0;

      if (coins < item.coins) throw Object.assign(new Error("insufficient_coins"), { code: "INSUF" });

      // Idempotente: se já tem, não debita de novo
      const alreadyOwned = (data.compras || []).some(c => c.produto === cosmeticId);
      if (alreadyOwned) throw Object.assign(new Error("already_owned"), { code: "OWNED" });

      compra = {
        ref:     `coin_${cosmeticId}_${uid}_${Date.now()}`,
        produto: cosmeticId,
        titulo:  item.title,
        tipo:    item.tipo,
        valor:   0,
        coins:   item.coins,
        ts:      Date.now(),
      };
      newCoinBalance = coins - item.coins;

      tx.update(userRef, {
        coins:   admin.firestore.FieldValue.increment(-item.coins),
        compras: admin.firestore.FieldValue.arrayUnion(compra),
      });
    });

    logInfo("cosmetic_purchased", { uid, cosmeticId, coinsSpent: item.coins });
    return res.json({ ok: true, compra, newCoinBalance });

  } catch (e) {
    if (e.code === 404)    return sendError(res, 404, "USUARIO_NAO_ENCONTRADO");
    if (e.code === "INSUF") return sendError(res, 400, "MOEDAS_INSUFICIENTES");
    if (e.code === "OWNED") return res.json({ ok: true, alreadyOwned: true, compra: null, newCoinBalance: null });
    logError("cosmetic_buy_error", e);
    return sendError(res, 500, "ERRO_COMPRA_COSMETICO");
  }
}));

module.exports = router;
