const express = require("express");
const admin = require("firebase-admin");
const { logError, logWarn } = require("../logger");
const { asyncHandler, sendError, normalizeUid, normalizeEmail } = require("../utils");
const { ensureDb, saveLicenseRecord, claimOrValidateLicenseOwnership } = require("../services/firestore");
const { mercadoPagoFetch } = require("../services/payments");
const { approveReferralRewardFromPayment } = require("../services/affiliate");
const {
  signPayload, verifySignedToken, generateLicenseCode, verifyFirebaseToken, getBearerToken
} = require("../services/auth");

// Versao opcional: se Bearer presente, valida e devolve uid; senao retorna
// null SEM enviar erro. Usado em rotas legadas que aceitavam uid no body
// pra compat — quando Bearer existe, e' preferido (defesa em profundidade
// contra atacante reivindicando licenseCode com uid forjado).
async function tryDecodeBearerUid(req) {
  const bearer = getBearerToken(req);
  if (!bearer) return null;
  try {
    const decoded = await admin.auth().verifyIdToken(bearer);
    return decoded.uid || null;
  } catch {
    return null;
  }
}
const { pagamentosAprovados } = require("../game/state");
const {
  PRODUCT_ID, PRODUCT_TITLE, PRODUCT_PRICE, PRODUCT_CURRENCY, PRODUCT_CATALOG,
  LICENSE_SECRET, ACCESS_TOKEN_SECRET, LICENSE_VALIDITY_MS, ACCESS_VALIDITY_MS
} = require("../config");

const router = express.Router();

// POST /emitir-licenca
router.post("/emitir-licenca", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;

  const paymentId = String(req.body?.paymentId || "").trim();
  if (!paymentId) return sendError(res, 400, "PAYMENT_ID_OBRIGATORIO");

  const { response, data: payment } = await mercadoPagoFetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, { method: "GET" });

  if (!response.ok) return res.status(500).json({ ok: false, error: "ERRO_MP_CONSULTAR_PAGAMENTO", details: payment });
  if (payment.status !== "approved") return sendError(res, 400, "PAGAMENTO_NAO_APROVADO", { statusAtual: payment.status || null });

  await approveReferralRewardFromPayment(payment);

  const transactionAmount = Number(payment.transaction_amount || 0);
  const paidProductId     = String(payment.metadata?.product_id || PRODUCT_ID);
  const paidCatalogEntry  = PRODUCT_CATALOG[paidProductId];

  if (!paidCatalogEntry || paidCatalogEntry.type !== "license") {
    return sendError(res, 400, "PRODUTO_NAO_GERA_LICENCA", { produto: paidProductId });
  }

  if (Math.abs(transactionAmount - paidCatalogEntry.price) > 0.01) {
    return sendError(res, 400, "VALOR_DIVERGENTE", { valor_recebido: transactionAmount, valor_esperado: paidCatalogEntry.price });
  }

  const email             = String(payment.payer?.email || payment.metadata?.customer_email || "").trim().toLowerCase();
  const nome              = String(payment.metadata?.customer_name || payment.payer?.first_name || "").trim().slice(0, 80);
  const externalReference = String(payment.external_reference || "").trim();

  if (!email || !externalReference) return sendError(res, 400, "DADOS_INSUFICIENTES_PARA_LICENCA");

  const licenseCode = generateLicenseCode(payment.id, externalReference, email);

  const payload = {
    token_type: "license",
    product: PRODUCT_ID, product_title: PRODUCT_TITLE,
    payment_id: String(payment.id), external_reference: externalReference,
    email, nome, license_code: licenseCode,
    amount: PRODUCT_PRICE, currency: PRODUCT_CURRENCY,
    iat: Date.now(), exp: Date.now() + LICENSE_VALIDITY_MS
  };

  const licenseToken = signPayload(payload, LICENSE_SECRET);

  await saveLicenseRecord({ licenseCode, licenseToken, paymentId: String(payment.id), externalReference, email, nome, product: PRODUCT_ID, amount: PRODUCT_PRICE, currency: PRODUCT_CURRENCY, exp: payload.exp });

  return res.json({ ok: true, licenseToken, licenseCode, email, ref: externalReference });
}));

// POST /verificar-licenca
router.post("/verificar-licenca", (req, res) => {
  try {
    const licenseToken = String(req.body?.licenseToken || "").trim();
    if (!licenseToken) return sendError(res, 400, "LICENCA_OBRIGATORIA");

    const verification = verifySignedToken(licenseToken, LICENSE_SECRET);
    if (!verification.valid) return sendError(res, 401, verification.error || "LICENCA_INVALIDA");

    const payload = verification.payload;
    if (payload.token_type !== "license" || payload.product !== PRODUCT_ID) return sendError(res, 401, "LICENCA_NAO_AUTORIZADA");

    return res.json({ ok: true, valid: true, licenseCode: payload.license_code, email: payload.email, nome: payload.nome || "", product: payload.product });
  } catch (error) {
    logError("verificar_licenca_error", error);
    return sendError(res, 500, "ERRO_INTERNO_VERIFICAR_LICENCA");
  }
});

// POST /validar-codigo-licenca
router.post("/validar-codigo-licenca", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;

  const licenseCode = String(req.body?.licenseCode || "").trim().toUpperCase();
  // Prefere uid do Bearer Firebase quando presente — defesa contra atacante
  // claimar licenseCode com uid forjado. Se Bearer ausente (clientes legados),
  // cai pro body uid + loga warn pra observabilidade.
  const bearerUid = await tryDecodeBearerUid(req);
  const uid = bearerUid || normalizeUid(req.body?.uid);
  if (!bearerUid && req.body?.uid) {
    logWarn("license_validar_sem_bearer", { ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress, licenseCode: licenseCode.slice(0, 8) + "..." });
  }
  const email       = normalizeEmail(req.body?.email);

  if (!licenseCode) return sendError(res, 400, "CODIGO_OBRIGATORIO");

  const ownership = await claimOrValidateLicenseOwnership({ licenseCode, uid, email });
  if (!ownership.ok) return sendError(res, ownership.status, ownership.error);

  const license = ownership.license;
  return res.json({ ok: true, valid: true, claimedNow: ownership.claimedNow, licenseCode: license.licenseCode, email: license.email, nome: license.nome || "", product: license.product, boundToUid: license.boundToUid || "", boundToEmail: license.boundToEmail || "" });
}));

// POST /emitir-acesso
router.post("/emitir-acesso", (req, res) => {
  try {
    const licenseToken = String(req.body?.licenseToken || "").trim();
    if (!licenseToken) return sendError(res, 400, "LICENCA_OBRIGATORIA");

    const verification = verifySignedToken(licenseToken, LICENSE_SECRET);
    if (!verification.valid) return sendError(res, 401, "LICENCA_INVALIDA", { detail: verification.error || null });

    const license = verification.payload;
    if (license.token_type !== "license" || license.product !== PRODUCT_ID) return sendError(res, 401, "LICENCA_NAO_AUTORIZADA");

    const accessPayload = {
      token_type: "game_access", product: PRODUCT_ID,
      license_code: license.license_code, email: license.email, nome: license.nome || "",
      uid: "", iat: Date.now(), exp: Date.now() + ACCESS_VALIDITY_MS
    };

    const accessToken = signPayload(accessPayload, ACCESS_TOKEN_SECRET);
    return res.json({ ok: true, accessToken, expiresAt: accessPayload.exp });
  } catch (error) {
    logError("emitir_acesso_error", error);
    return sendError(res, 500, "ERRO_INTERNO_EMITIR_ACESSO");
  }
});

// POST /emitir-acesso-por-codigo
router.post("/emitir-acesso-por-codigo", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;

  const licenseCode = String(req.body?.licenseCode || "").trim().toUpperCase();
  // Mesmo padrao do /validar-codigo-licenca — prefere uid do Bearer quando presente.
  const bearerUid = await tryDecodeBearerUid(req);
  const uid = bearerUid || normalizeUid(req.body?.uid);
  if (!bearerUid && req.body?.uid) {
    logWarn("license_emitir_sem_bearer", { ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress, licenseCode: licenseCode.slice(0, 8) + "..." });
  }
  const email       = normalizeEmail(req.body?.email);

  if (!licenseCode) return sendError(res, 400, "CODIGO_OBRIGATORIO");

  const ownership = await claimOrValidateLicenseOwnership({ licenseCode, uid, email });
  if (!ownership.ok) return sendError(res, ownership.status, ownership.error);

  const license = ownership.license;

  const accessPayload = {
    token_type: "game_access", product: PRODUCT_ID,
    license_code: license.licenseCode, email: license.email, nome: license.nome || "",
    uid, iat: Date.now(), exp: Date.now() + ACCESS_VALIDITY_MS
  };

  const accessToken = signPayload(accessPayload, ACCESS_TOKEN_SECRET);
  return res.json({ ok: true, accessToken, expiresAt: accessPayload.exp, email: license.email, nome: license.nome || "", licenseCode: license.licenseCode, claimedNow: ownership.claimedNow });
}));

// POST /verificar-acesso
router.post("/verificar-acesso", (req, res) => {
  try {
    const accessToken = String(req.body?.accessToken || "").trim();
    if (!accessToken) return sendError(res, 400, "ACESSO_OBRIGATORIO");

    const verification = verifySignedToken(accessToken, ACCESS_TOKEN_SECRET);
    if (!verification.valid) return sendError(res, 401, verification.error || "ACESSO_INVALIDO");

    const payload = verification.payload;
    if (payload.token_type !== "game_access" || payload.product !== PRODUCT_ID) return sendError(res, 401, "ACESSO_NEGADO");

    return res.json({ ok: true, liberado: true, email: payload.email, nome: payload.nome || "", licenseCode: payload.license_code, uid: payload.uid || "" });
  } catch (error) {
    logError("verificar_acesso_error", error);
    return sendError(res, 500, "ERRO_INTERNO_VERIFICAR_ACESSO");
  }
});

// POST /registrar-compra
router.post("/registrar-compra", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const { getDb } = require("../services/firestore");
  const admin = require("firebase-admin");

  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const ref = String(req.body?.ref || "").trim();
  if (!ref) return sendError(res, 400, "REF_OBRIGATORIA");

  const pagamento = pagamentosAprovados.get(ref);
  if (!pagamento || !pagamento.approved) return sendError(res, 400, "COMPRA_NAO_APROVADA");

  const productId    = pagamento.produto || PRODUCT_ID;
  const catalogEntry = PRODUCT_CATALOG[productId];
  if (!catalogEntry || catalogEntry.type === "license") return sendError(res, 400, "PRODUTO_NAO_REGISTRAVEL");

  const compraEntry = { ref, produto: productId, titulo: catalogEntry.title, tipo: catalogEntry.type, valor: catalogEntry.price, ts: Date.now() };

  const db = getDb();
  await db.collection("users").doc(uid).set({ compras: admin.firestore.FieldValue.arrayUnion(compraEntry) }, { merge: true });
  return res.json({ ok: true, compra: compraEntry });
}));

// GET /minhas-compras
router.get("/minhas-compras", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const { getDb } = require("../services/firestore");

  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const db       = getDb();
  const userSnap = await db.collection("users").doc(uid).get();
  const compras  = userSnap.exists ? (userSnap.data().compras || []) : [];
  return res.json({ ok: true, compras });
}));

module.exports = router;
