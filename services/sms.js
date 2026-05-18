// Espaço Prelúdio — Serviço SMS abstrato.
//
// Modelo: cada profissional configura SEU PROPRIO provider de SMS (não é
// shared como WhatsApp Z-API). Razão: SMS no Brasil custa R$ 0,09-0,15 por
// mensagem — não dá pra a plataforma absorver esse custo sem inflar plano.
//
// Profissional configura accountSid + authToken + fromNumber em perfil.
// Backend usa essas credenciais pra enviar via provider.
//
// Providers suportados (Fase 1):
//   - twilio (mais comum, doc em PT, $0.0079 USD ≈ R$ 0.04 por SMS BR)
//
// Futuro (Fase 2):
//   - zenvia (BR-first, ~R$ 0,06)
//   - totalvoice (BR, ~R$ 0,08)
//   - messagebird
//
// Toda config + envio fica plaintext server-side por enquanto. Token Twilio
// no Firestore como `therapist.smsConfig.authTokenEncrypted` — cifrado com
// chave dedicada do servidor (já existe padrão similar pra NFS-e).

const https = require("https");

// Encode form-urlencoded body pra Twilio API.
function _formUrlEncode(obj) {
  return Object.entries(obj)
    .filter(([_, v]) => v != null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

// Sanity: telefone BR pra E.164. Aceita "+5548999998888", "55 48 999998888",
// "(48) 99999-8888". Default DDI Brasil.
function normalizePhoneToE164(input, defaultCountryCode = "55") {
  if (!input) return null;
  const digits = String(input).replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith(defaultCountryCode)) return "+" + digits;
  // Se 10 ou 11 dígitos, assume BR local
  if (digits.length === 10 || digits.length === 11) return "+" + defaultCountryCode + digits;
  // Outros: trata como já-internacional
  return "+" + digits;
}

/**
 * Envia SMS via Twilio.
 * @param {object} cfg — { accountSid, authToken, fromNumber }
 * @param {object} msg — { to, body }
 * @returns {Promise<{ok, sid?, error?, httpStatus?}>}
 */
function sendViaTwilio(cfg, msg) {
  return new Promise((resolve) => {
    const { accountSid, authToken, fromNumber } = cfg || {};
    if (!accountSid || !authToken || !fromNumber) {
      return resolve({ ok: false, error: "TWILIO_CONFIG_AUSENTE" });
    }
    const toE164 = normalizePhoneToE164(msg.to);
    if (!toE164) return resolve({ ok: false, error: "TELEFONE_INVALIDO" });

    const body = _formUrlEncode({
      From: fromNumber,
      To: toE164,
      Body: msg.body
    });
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
    const path = `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;

    const req = https.request({
      method: "POST",
      hostname: "api.twilio.com",
      path,
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300 && parsed.sid) {
            resolve({ ok: true, sid: parsed.sid, httpStatus: res.statusCode });
          } else {
            resolve({
              ok: false,
              error: parsed.code ? `TWILIO_${parsed.code}` : "TWILIO_ERRO",
              detail: parsed.message || data.slice(0, 200),
              httpStatus: res.statusCode
            });
          }
        } catch {
          resolve({ ok: false, error: "TWILIO_RESPOSTA_INVALIDA", httpStatus: res.statusCode });
        }
      });
    });
    req.on("error", (err) => resolve({ ok: false, error: "TWILIO_NETWORK", detail: err.message }));
    req.setTimeout(15_000, () => { req.destroy(); resolve({ ok: false, error: "TWILIO_TIMEOUT" }); });
    req.write(body);
    req.end();
  });
}

// Registry de providers — Fase 2 adiciona zenvia, totalvoice, etc.
const PROVIDERS = {
  twilio: sendViaTwilio
};

/**
 * Envia SMS escolhendo provider conforme config do profissional.
 *
 * @param {object} smsConfig — therapist.smsConfig
 *   { provider: "twilio", accountSid, authToken, fromNumber, enabled }
 * @param {object} msg — { to, body }
 * @returns {Promise<{ok, sid?, error?, detail?, httpStatus?, skipped?}>}
 */
async function sendSms(smsConfig, msg) {
  if (!smsConfig || !smsConfig.enabled) {
    return { ok: false, skipped: true, error: "SMS_DESABILITADO" };
  }
  const provider = smsConfig.provider || "twilio";
  const fn = PROVIDERS[provider];
  if (!fn) return { ok: false, error: "PROVIDER_NAO_SUPORTADO", detail: `Suportados: ${Object.keys(PROVIDERS).join(", ")}` };
  if (!msg?.to || !msg?.body) return { ok: false, error: "MSG_INVALIDA" };
  // Trunca body em 160 chars (1 SMS = 160 chars GSM-7). Mais que isso
  // o Twilio quebra em múltiplos SMS = múltiplas cobranças. Avisa silencioso.
  const body = String(msg.body).slice(0, 160);
  return fn(smsConfig, { to: msg.to, body });
}

module.exports = {
  sendSms,
  normalizePhoneToE164,
  // Exposto pra testes
  _sendViaTwilio: sendViaTwilio,
  _providers: PROVIDERS
};
