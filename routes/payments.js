const express = require("express");
const { logError, logWarn, logInfo } = require("../logger");
const { asyncHandler, sendError, normalizeEmail } = require("../utils");
const { ensureDb } = require("../services/firestore");
const { mercadoPagoFetch } = require("../services/payments");
const { generateExternalReference } = require("../services/auth");
const { getAffiliateByCode, registerPendingReferral, approveReferralRewardFromPayment } = require("../services/affiliate");
const { pagamentosAprovados } = require("../game/state");
const { PRODUCT_ID, PRODUCT_CATALOG, PRODUCT_CURRENCY, FRONTEND_BASE_URL, BACKEND_BASE_URL } = require("../config");

const router = express.Router();

// POST /criar-pagamento
router.post("/criar-pagamento", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;

  const nome          = String(req.body?.nome    || "").trim().slice(0, 80);
  const email         = String(req.body?.email   || "").trim().toLowerCase().slice(0, 160);
  const refCodeInput  = String(req.body?.refCode || "").trim().toUpperCase();
  const produtoInput  = String(req.body?.produto || "").trim();
  const roomIdInput   = String(req.body?.roomId  || "").trim().toUpperCase();

  if (!nome)  return sendError(res, 400, "NOME_OBRIGATORIO");
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendError(res, 400, "EMAIL_INVALIDO");

  const catalogEntry   = PRODUCT_CATALOG[produtoInput] || PRODUCT_CATALOG[PRODUCT_ID];
  const productId      = produtoInput && PRODUCT_CATALOG[produtoInput] ? produtoInput : PRODUCT_ID;
  const productTitle   = catalogEntry.title;
  const productDescription = catalogEntry.description;
  const productPrice   = catalogEntry.price;

  let referralData = null;

  if (refCodeInput) {
    referralData = await getAffiliateByCode(refCodeInput);
    if (!referralData) return sendError(res, 400, "CODIGO_INDICACAO_INVALIDO");
    if (normalizeEmail(referralData.data.email) === email) return sendError(res, 400, "AUTOINDICACAO_NAO_PERMITIDA");
  }

  const externalReference = generateExternalReference();

  const body = {
    items: [{ id: productId, title: productTitle, description: productDescription, category_id: "entertainment", quantity: 1, currency_id: PRODUCT_CURRENCY, unit_price: productPrice }],
    payer: { name: nome, email },
    metadata: {
      product_id: productId, customer_name: nome, customer_email: email,
      ref_code: referralData?.data?.refCode || "", referrer_uid: referralData?.id || "",
      room_id: roomIdInput || ""
    },
    external_reference: externalReference,
    notification_url: `${BACKEND_BASE_URL}/webhook`,
    back_urls: {
      success: `${FRONTEND_BASE_URL}/sucesso.html`,
      failure: `${FRONTEND_BASE_URL}/erro.html`,
      pending: `${FRONTEND_BASE_URL}/pendente.html`
    },
    auto_return: "approved",
    statement_descriptor: "SEXTO LUGAR"
  };

  const { response, data } = await mercadoPagoFetch("https://api.mercadopago.com/checkout/preferences", { method: "POST", body: JSON.stringify(body) });

  if (!response.ok) {
    return res.status(500).json({
      ok: false,
      error: "ERRO_MP_CRIAR_PAGAMENTO",
      details: data,
      message: data?.message || data?.error || data?.cause?.[0]?.description || data?.cause?.[0]?.code || "Falha ao criar preferência no Mercado Pago"
    });
  }

  if (referralData) {
    await registerPendingReferral({
      paymentId: "", externalReference,
      buyerEmail: email, buyerName: nome,
      refCode: referralData.data.refCode, referrerUid: referralData.id,
      amount: productPrice
    });
  }

  return res.json({ ok: true, url: data.init_point, sandbox_url: data.sandbox_init_point || null, ref: externalReference, produto: productId, referralApplied: !!referralData });
}));

// GET /status-pagamento/:ref
router.get("/status-pagamento/:ref", (req, res) => {
  try {
    const ref = String(req.params.ref || "").trim();
    if (!ref) return sendError(res, 400, "REF_OBRIGATORIA");

    const pagamento = pagamentosAprovados.get(ref);
    if (!pagamento) return res.json({ ok: true, found: false, approved: false });

    return res.json({ ok: true, found: true, approved: true, paymentId: pagamento.paymentId, status: pagamento.status, ref: pagamento.ref, produto: pagamento.produto || null });
  } catch (error) {
    logError("status_pagamento_error", error);
    return sendError(res, 500, "ERRO_INTERNO_STATUS_PAGAMENTO");
  }
});

// GET /verificar-compra/:ref
router.get("/verificar-compra/:ref", (req, res) => {
  try {
    const ref = String(req.params.ref || "").trim();
    if (!ref) return sendError(res, 400, "REF_OBRIGATORIA");

    const pagamento = pagamentosAprovados.get(ref);
    if (!pagamento) return res.json({ ok: true, found: false, approved: false });

    const productId    = pagamento.produto || PRODUCT_ID;
    const catalogEntry = PRODUCT_CATALOG[productId] || PRODUCT_CATALOG[PRODUCT_ID];

    return res.json({ ok: true, found: true, approved: true, paymentId: pagamento.paymentId, ref: pagamento.ref, produto: productId, tipo: catalogEntry.type, titulo: catalogEntry.title, valor: catalogEntry.price });
  } catch (error) {
    logError("verificar_compra_error", error);
    return sendError(res, 500, "ERRO_INTERNO_VERIFICAR_COMPRA");
  }
});

// POST /webhook — Mercado Pago
router.post("/webhook", asyncHandler(async (req, res) => {
  logInfo("mercado_pago_webhook_received", { body: req.body || {} });

  const body      = req.body || {};
  const type      = body.type || body.topic || null;
  const paymentId = body.data?.id || body["data.id"] || body.id || req.query["data.id"] || req.query.id || null;

  if (type === "payment" && paymentId) {
    const { response, data: payment } = await mercadoPagoFetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, { method: "GET" });

    if (!response.ok) {
      logWarn("mercado_pago_webhook_lookup_failed", { payment });
      return res.sendStatus(200);
    }

    const status = String(payment.status || "").trim();
    const ref    = String(payment.external_reference || "").trim();

    if (status === "approved" && ref) {
      const productIdFromWebhook = String(payment.metadata?.product_id || PRODUCT_ID);
      const approvedEmail        = String(payment.payer?.email || payment.metadata?.customer_email || "").trim().toLowerCase();
      const approvedRoomId       = String(payment.metadata?.room_id || "").trim().toUpperCase();

      pagamentosAprovados.set(ref, {
        approved: true, paymentId: String(payment.id), status, ref,
        produto: productIdFromWebhook, email: approvedEmail, roomId: approvedRoomId, updatedAt: Date.now()
      });

      // Passe mensal — salva no Firestore com validade de 30 dias
      const { getDb } = require("../services/firestore");
      const db = getDb();
      if (productIdFromWebhook === "gravacao-mensal" && approvedEmail && db) {
        const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
        db.collection("recording_passes").doc(approvedEmail).set({
          email: approvedEmail, paymentId: String(payment.id), ref,
          activatedAt: Date.now(), expiresAt, type: "gravacao-mensal"
        }, { merge: false }).catch(err => logError("recording_pass_save_error", err));
        logInfo("recording_pass_activated", { email: approvedEmail, expiresAt });
      }

      if (productIdFromWebhook === "streaming-mensal" && approvedEmail && db) {
        const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
        db.collection("streaming_passes").doc(approvedEmail).set({
          email: approvedEmail, paymentId: String(payment.id), ref,
          activatedAt: Date.now(), expiresAt, type: "streaming-mensal"
        }, { merge: false }).catch(err => logError("streaming_pass_save_error", err));
        logInfo("streaming_pass_activated", { email: approvedEmail, expiresAt });
      }

      if (db) {
        try {
          await approveReferralRewardFromPayment(payment);
          logInfo("affiliate_auto_approved", { ref });
        } catch (refError) {
          logError("affiliate_auto_approve_error", refError, { ref });
        }
      }

      logInfo("payment_approved_in_memory", { ref });
    } else {
      logInfo("payment_received_not_approved_yet", { paymentId, status, ref });
    }
  }

  return res.sendStatus(200);
}));

// GET /teste-pagamento/:paymentId
router.get("/teste-pagamento/:paymentId", asyncHandler(async (req, res) => {
  const paymentId = String(req.params.paymentId || "").trim();
  if (!paymentId) return sendError(res, 400, "PAYMENT_ID_OBRIGATORIO");

  const { response, data } = await mercadoPagoFetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, { method: "GET" });
  if (!response.ok) return res.status(500).json({ ok: false, error: "ERRO_MP_CONSULTAR_PAGAMENTO", details: data });
  return res.json({ ok: true, data });
}));

// GET /forcar-afiliado/:paymentId
router.get("/forcar-afiliado/:paymentId", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;

  const paymentId = String(req.params.paymentId || "").trim();
  if (!paymentId) return sendError(res, 400, "PAYMENT_ID_OBRIGATORIO");

  const { response, data: payment } = await mercadoPagoFetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, { method: "GET" });
  if (!response.ok) return res.status(500).json({ ok: false, error: "ERRO_MP_CONSULTAR_PAGAMENTO", details: payment });
  if (String(payment.status || "").trim() !== "approved") return sendError(res, 400, "PAGAMENTO_NAO_APROVADO", { statusAtual: payment.status || null });

  await approveReferralRewardFromPayment(payment);
  return res.json({ ok: true, message: "Afiliado aprovado manualmente" });
}));

module.exports = router;
