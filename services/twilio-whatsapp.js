// services/twilio-whatsapp.js
//
// Envia mensagens WhatsApp via Twilio API (sem SDK — HTTP puro).
// Requer que TWILIO_WHATSAPP_FROM esteja configurado (número WhatsApp
// Business aprovado pela Meta). Enquanto não estiver, vira no-op silencioso.
//
// Variáveis necessárias no Railway:
//   TWILIO_ACCOUNT_SID   — começa com "AC..."
//   TWILIO_AUTH_TOKEN    — token da conta
//   TWILIO_WHATSAPP_FROM — número aprovado, ex: "whatsapp:+14155238886"

const { logWarn, logError } = require("../logger");
const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM } = require("../config");

function isConfigured() {
  return Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_WHATSAPP_FROM);
}

function normalizePhone(input) {
  let digits = String(input || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("55") && digits.length >= 12) return `whatsapp:+${digits}`;
  if (digits.length === 10 || digits.length === 11) return `whatsapp:+55${digits}`;
  return `whatsapp:+${digits}`;
}

// Envia mensagem de texto livre.
// Retorna { ok: bool, skipped?, messageId?, error? }
async function sendText({ to, message }) {
  if (!isConfigured()) {
    logWarn("twilio_whatsapp_nao_configurado", { to });
    return { ok: false, skipped: true, reason: "TWILIO_NAO_CONFIGURADO" };
  }

  const toFormatted = normalizePhone(to);
  if (!toFormatted) return { ok: false, error: "TELEFONE_INVALIDO" };
  if (!message) return { ok: false, error: "MENSAGEM_VAZIA" };

  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const credentials = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

  const body = new URLSearchParams({
    To:   toFormatted,
    From: TWILIO_WHATSAPP_FROM,
    Body: message
  }).toString();

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${credentials}`,
        "Content-Type":  "application/x-www-form-urlencoded"
      },
      body
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      logWarn("twilio_whatsapp_send_failed", { status: res.status, to: toFormatted, code: data?.code, message: data?.message });
      return { ok: false, error: data?.message || `HTTP_${res.status}`, code: data?.code };
    }

    return { ok: true, messageId: data.sid };
  } catch (e) {
    logError("twilio_whatsapp_exception", e, { to: toFormatted });
    return { ok: false, error: e.message };
  }
}

module.exports = { sendText, isConfigured };
