// Wrapper REST da API Asaas (https://docs.asaas.com). Cada terapeuta tem
// sua própria conta Asaas + apiKey — nós orquestramos chamadas usando a
// key do terapeuta dono da transação. Espaço Prelúdio nunca é o merchant;
// o dinheiro vai direto pro Asaas do terapeuta.
//
// Ambientes:
//   - sandbox:    https://api-sandbox.asaas.com/v3
//   - production: https://api.asaas.com/v3
//
// Falhas de rede / 4xx / 5xx retornam { ok: false, status, error } sem
// throw — caller decide se propaga. apiKey ausente vira { ok: false, skipped: true }.

const { logInfo, logError } = require("../logger");

const BASE_BY_ENV = {
  sandbox:    "https://api-sandbox.asaas.com/v3",
  production: "https://api.asaas.com/v3"
};

function baseUrl(env) {
  return BASE_BY_ENV[env === "production" ? "production" : "sandbox"];
}

async function asaasFetch({ apiKey, env, path, method = "GET", body = null }) {
  if (!apiKey) return { ok: false, skipped: true, error: "ASAAS_API_KEY_AUSENTE" };
  const url = `${baseUrl(env)}${path}`;
  const headers = {
    "access_token": apiKey,
    "Content-Type": "application/json",
    "User-Agent":   "EspacoPreludio/1.0"
  };
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errMsg = data?.errors?.[0]?.description || data?.message || `HTTP ${res.status}`;
      logError("asaas_request_failed", new Error(errMsg), { path, status: res.status });
      return { ok: false, status: res.status, error: errMsg, raw: data };
    }
    return { ok: true, data };
  } catch (e) {
    logError("asaas_request_exception", e, { path });
    return { ok: false, error: e.message };
  }
}

// Lookup ou cria customer no Asaas. Idempotente via externalReference =
// hash patientId-or-email-pelo-terapeuta. Retorna { customerId }.
async function ensureCustomer({ apiKey, env, externalReference, name, email, phone, cpfCnpj }) {
  if (!apiKey) return { ok: false, skipped: true, error: "ASAAS_API_KEY_AUSENTE" };
  if (!externalReference) return { ok: false, error: "EXTERNAL_REFERENCE_OBRIGATORIO" };
  // Busca por externalReference (1 customer por paciente do terapeuta).
  const search = await asaasFetch({
    apiKey, env,
    path: `/customers?externalReference=${encodeURIComponent(externalReference)}&limit=1`
  });
  if (search.ok && search.data?.data?.length > 0) {
    return { ok: true, customerId: search.data.data[0].id, created: false };
  }
  // Cria novo.
  const create = await asaasFetch({
    apiKey, env,
    path: "/customers",
    method: "POST",
    body: {
      name: (name || "Cliente").slice(0, 100),
      email: email || undefined,
      phone: phone || undefined,
      cpfCnpj: cpfCnpj || undefined,
      externalReference
    }
  });
  if (!create.ok) return create;
  return { ok: true, customerId: create.data.id, created: true };
}

// Cria cobrança Pix. value em centavos é convertido pra reais (Asaas usa decimal).
// externalReference é nosso txId — usado pra correlacionar webhook → tx.
async function createPaymentPix({ apiKey, env, customerId, valueCents, description, dueDate, externalReference }) {
  if (!apiKey) return { ok: false, skipped: true, error: "ASAAS_API_KEY_AUSENTE" };
  const valueReais = Math.round(Number(valueCents)) / 100;
  if (!(valueReais > 0)) return { ok: false, error: "VALOR_INVALIDO" };
  const due = dueDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return asaasFetch({
    apiKey, env,
    path: "/payments",
    method: "POST",
    body: {
      customer: customerId,
      billingType: "PIX",
      value: valueReais,
      dueDate: due,
      description: (description || "Consulta").slice(0, 500),
      externalReference: externalReference || undefined
    }
  });
}

async function getPayment({ apiKey, env, paymentId }) {
  return asaasFetch({ apiKey, env, path: `/payments/${encodeURIComponent(paymentId)}` });
}

async function getPixQrCode({ apiKey, env, paymentId }) {
  return asaasFetch({ apiKey, env, path: `/payments/${encodeURIComponent(paymentId)}/pixQrCode` });
}

async function cancelPayment({ apiKey, env, paymentId }) {
  return asaasFetch({ apiKey, env, path: `/payments/${encodeURIComponent(paymentId)}`, method: "DELETE" });
}

// Pinga /myAccount pra validar a apiKey. Usado quando o terapeuta salva a
// key no perfil — feedback imediato de chave inválida.
async function validateApiKey({ apiKey, env }) {
  const r = await asaasFetch({ apiKey, env, path: "/myAccount" });
  if (r.ok) return { ok: true, account: { name: r.data?.name || null, email: r.data?.email || null } };
  return r;
}

// Mapeia status do Asaas pro modelo interno de transação.
//   PENDING / AWAITING_RISK_ANALYSIS → "pendente"
//   CONFIRMED / RECEIVED / RECEIVED_IN_CASH → "pago"
//   OVERDUE                                  → "atrasado"
//   REFUNDED / REFUND_REQUESTED              → "reembolsado"
//   DELETED / CANCELED                       → "cancelado"
function mapAsaasStatusToTx(asaasStatus) {
  const s = String(asaasStatus || "").toUpperCase();
  if (s === "CONFIRMED" || s === "RECEIVED" || s === "RECEIVED_IN_CASH") return "pago";
  if (s === "OVERDUE")                                                    return "atrasado";
  if (s === "REFUNDED" || s === "REFUND_REQUESTED")                       return "reembolsado";
  if (s === "DELETED" || s === "CANCELED")                                return "cancelado";
  return "pendente";
}

module.exports = {
  ensureCustomer,
  createPaymentPix,
  getPayment,
  getPixQrCode,
  cancelPayment,
  validateApiKey,
  mapAsaasStatusToTx,
  baseUrl
};
