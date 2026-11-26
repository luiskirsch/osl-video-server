const crypto = require("node:crypto");
const { logError, logWarn } = require("../logger");
const { MP_WEBHOOK_SECRET, IS_PRODUCTION } = require("../config");

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
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > 5 * 60 * 1000) {
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

module.exports = { verifyMercadoPagoSignature };
