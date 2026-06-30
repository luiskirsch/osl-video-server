const express = require("express");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const crypto = require("crypto");
const { logError, logWarn, logInfo } = require("../logger");
const { asyncHandler, sendError, normalizeEmail } = require("../utils");
const { ensureDb } = require("../services/firestore");
const { mercadoPagoFetch } = require("../services/payments");
const { generateExternalReference, requireAdmin } = require("../services/auth");
const { getAffiliateByCode, registerPendingReferral, approveReferralRewardFromPayment } = require("../services/affiliate");
const { pagamentosAprovados } = require("../game/state");
const { PRODUCT_ID, PRODUCT_CATALOG, PRODUCT_CURRENCY, FRONTEND_BASE_URL, BACKEND_BASE_URL, MP_WEBHOOK_SECRET, PASS_VALIDITY_MS, IS_PRODUCTION } = require("../config");
const { t: i18nT, detectLocale } = require("../services/i18n");

// Security #1: valida x-signature do Mercado Pago.
// Template oficial: "id:<data.id>;request-id:<x-request-id>;ts:<ts>;"
// HMAC-SHA256 com MP_WEBHOOK_SECRET (configurado no painel Mercado Pago).
// Em produção, assinatura é sempre obrigatória — sem isso, qualquer um pode
// forjar um webhook de "pagamento aprovado". Em staging fica opt-in via
// MP_WEBHOOK_REQUIRE_SIG=1 pra não travar ambiente de teste sem o secret.
const MP_WEBHOOK_REQUIRE_SIG = IS_PRODUCTION || String(process.env.MP_WEBHOOK_REQUIRE_SIG || "").trim() === "1";

function verifyMercadoPagoSignature(req, paymentId) {
  if (!MP_WEBHOOK_SECRET) {
    if (MP_WEBHOOK_REQUIRE_SIG) {
      logError("mp_webhook_secret_missing_but_required", new Error("MP_WEBHOOK_SECRET vazio com REQUIRE=1"));
      return { ok: false, reason: "MP_WEBHOOK_SECRET_AUSENTE" };
    }
    logWarn("mp_webhook_secret_missing", { hint: "Setar MP_WEBHOOK_SECRET pra ativar verificação de assinatura" });
    return { ok: true, verified: false, reason: "SECRET_NAO_CONFIGURADO" };
  }
  const sigHeader = String(req.headers["x-signature"] || "");
  const reqId     = String(req.headers["x-request-id"] || "");
  if (!sigHeader || !reqId) {
    return { ok: false, reason: "HEADERS_AUSENTES" };
  }
  // Parse "ts=TIMESTAMP,v1=HEX" (em qualquer ordem, com espaços possíveis)
  const parts = Object.fromEntries(
    sigHeader.split(",").map(p => p.trim().split("="))
  );
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1) return { ok: false, reason: "SIG_FORMATO_INVALIDO" };

  // Tolerância de 5 min pra timestamp
  const tsMs = Number(ts) * (String(ts).length > 12 ? 1 : 1000);
  if (Math.abs(Date.now() - tsMs) > 5 * 60 * 1000) {
    return { ok: false, reason: "SIG_EXPIRADA" };
  }

  const template = `id:${paymentId};request-id:${reqId};ts:${ts};`;
  const expected = crypto.createHmac("sha256", MP_WEBHOOK_SECRET).update(template).digest("hex");
  // Comparação tempo-constante
  let match = false;
  try {
    match = crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(v1, "hex"));
  } catch { match = false; }
  return match ? { ok: true, verified: true } : { ok: false, reason: "SIG_INVALIDA" };
}

const router = express.Router();

// Security #11: rate limit em /criar-pagamento pra evitar abuso de criação de cobranças MP
const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,                     // 5 pedidos/min/IP+email
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: "RATE_LIMIT_EXCEDIDO", hint: "Aguarde 1 min antes de criar outro pagamento" },
  // express-rate-limit v8 exige ipKeyGenerator() helper pra normalizar IPv6.
  keyGenerator: (req) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    return email || ipKeyGenerator(req) || "anon";
  }
});

// POST /criar-pagamento
router.post("/criar-pagamento", paymentLimiter, asyncHandler(async (req, res) => {
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
  // i18n: title/description vão pra checkout do Mercado Pago localizados
  // baseado no locale do cliente (X-Locale header / Accept-Language).
  // Fallback PT pra PRODUCT_CATALOG (config.js) garante compat.
  const productTitle       = i18nT(req, `products:${productId}.title`, catalogEntry.title);
  const productDescription = i18nT(req, `products:${productId}.description`, catalogEntry.description);
  const productPrice       = catalogEntry.price;

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

  // Security #1: valida assinatura do MP antes de processar
  if (type === "payment" && paymentId) {
    const sig = verifyMercadoPagoSignature(req, paymentId);
    if (!sig.ok) {
      logWarn("mp_webhook_signature_rejected", { reason: sig.reason, paymentId });
      return res.status(401).json({ ok: false, error: "SIGNATURE_INVALIDA" });
    }
    if (sig.verified === false) {
      logWarn("mp_webhook_unverified", { reason: sig.reason || "unknown", paymentId });
    }
  }

  if (type === "payment" && paymentId) {
    const { response, data: payment } = await mercadoPagoFetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, { method: "GET" });

    if (!response.ok) {
      logWarn("mercado_pago_webhook_lookup_failed", { payment });
      return res.sendStatus(200);
    }

    const status = String(payment.status || "").trim();
    const ref    = String(payment.external_reference || "").trim();

    if (status === "approved" && ref) {
      // Idempotência: se já processamos esse paymentId, não re-processa.
      const existing = pagamentosAprovados.get(ref);
      if (existing && existing.paymentId === String(payment.id)) {
        logInfo("mp_webhook_duplicate_ignored", { ref, paymentId: payment.id });
        return res.sendStatus(200);
      }

      const productIdFromWebhook = String(payment.metadata?.product_id || PRODUCT_ID);
      const approvedEmail        = String(payment.payer?.email || payment.metadata?.customer_email || "").trim().toLowerCase();
      const approvedRoomId       = String(payment.metadata?.room_id || "").trim().toUpperCase();

      pagamentosAprovados.set(ref, {
        approved: true, paymentId: String(payment.id), status, ref,
        produto: productIdFromWebhook, email: approvedEmail, roomId: approvedRoomId, updatedAt: Date.now()
      });

      const { getDb } = require("../services/firestore");
      const db = getDb();

      // Passe mensal — salva no Firestore com validade configurada (PASS_VALIDITY_MS).
      // merge:true preserva campos não-relacionados se o doc já existir (correção P1).
      if (productIdFromWebhook === "gravacao-mensal" && approvedEmail && db) {
        const expiresAt = Date.now() + PASS_VALIDITY_MS;
        try {
          await db.collection("recording_passes").doc(approvedEmail).set({
            email: approvedEmail, paymentId: String(payment.id), ref,
            activatedAt: Date.now(), expiresAt, type: "gravacao-mensal"
          }, { merge: true });
          logInfo("recording_pass_activated", { email: approvedEmail, expiresAt });
        } catch (err) {
          logError("recording_pass_save_error", err, { email: approvedEmail });
        }
      }

      if (productIdFromWebhook === "streaming-mensal" && approvedEmail && db) {
        const expiresAt = Date.now() + PASS_VALIDITY_MS;
        try {
          await db.collection("streaming_passes").doc(approvedEmail).set({
            email: approvedEmail, paymentId: String(payment.id), ref,
            activatedAt: Date.now(), expiresAt, type: "streaming-mensal"
          }, { merge: true });
          logInfo("streaming_pass_activated", { email: approvedEmail, expiresAt });
        } catch (err) {
          logError("streaming_pass_save_error", err, { email: approvedEmail });
        }
      }

      if (db) {
        try {
          await approveReferralRewardFromPayment(payment);
          logInfo("affiliate_auto_approved", { ref });
        } catch (refError) {
          // #B1: enfileira pra retry em vez de só logar e perder. Webhook
          // ainda devolve 200 (idempotência do MP); o scheduler retoma.
          logError("affiliate_auto_approve_error", refError, { ref });
          try {
            const { enqueuePendingReferral } = require("../services/affiliate");
            await enqueuePendingReferral(payment, refError);
          } catch (enqErr) {
            logError("affiliate_enqueue_unhandled", enqErr, { ref });
          }
        }
      }

      logInfo("payment_approved_in_memory", { ref });
    } else {
      logInfo("payment_received_not_approved_yet", { paymentId, status, ref });
    }
  }

  return res.sendStatus(200);
}));

// GET /teste-pagamento/:paymentId — rota de debug, exige admin (vaza PII completa do MP)
router.get("/teste-pagamento/:paymentId", requireAdmin, asyncHandler(async (req, res) => {
  const paymentId = String(req.params.paymentId || "").trim();
  if (!paymentId) return sendError(res, 400, "PAYMENT_ID_OBRIGATORIO");

  const { response, data } = await mercadoPagoFetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, { method: "GET" });
  if (!response.ok) return res.status(500).json({ ok: false, error: "ERRO_MP_CONSULTAR_PAGAMENTO", details: data });
  return res.json({ ok: true, data });
}));

// GET /forcar-afiliado/:paymentId — rota operacional, exige admin (aprova recompensa manualmente)
router.get("/forcar-afiliado/:paymentId", requireAdmin, asyncHandler(async (req, res) => {
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
