"use strict";

// Mercado Pago "Conectar conta" (OAuth) para profissionais pagantes: a
// cobrança PIX do paciente é criada NA CONTA DO PROFISSIONAL (o dinheiro cai
// direto para ele) e o Mercado Pago avisa a plataforma quando é paga.
//
// Requer o aplicativo da plataforma no Mercado Pago:
//   MP_CLIENT_ID_THERAPY / MP_CLIENT_SECRET_THERAPY
//   URL de redirecionamento cadastrada = BACKEND_BASE_URL + /therapy/mp/oauth/callback

const MP_API = "https://api.mercadopago.com";
const REFRESH_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;

function config() {
  return {
    clientId: process.env.MP_CLIENT_ID_THERAPY || "",
    clientSecret: process.env.MP_CLIENT_SECRET_THERAPY || "",
    backendBase: process.env.BACKEND_BASE_URL || "https://osl-video-server-production.up.railway.app"
  };
}

function isConfigured() {
  const c = config();
  return Boolean(c.clientId && c.clientSecret);
}

function redirectUri() {
  return `${config().backendBase.replace(/\/+$/, "")}/therapy/mp/oauth/callback`;
}

function buildAuthUrl(state) {
  const c = config();
  const qs = new URLSearchParams({
    client_id: c.clientId, response_type: "code", platform_id: "mp",
    state, redirect_uri: redirectUri()
  });
  return `https://auth.mercadopago.com.br/authorization?${qs}`;
}

async function mpRequest(path, { method = "GET", token = null, body = null, idempotencyKey = null } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (idempotencyKey) headers["X-Idempotency-Key"] = idempotencyKey;
  const r = await fetch(`${MP_API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.message || data.error || `MP_HTTP_${r.status}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

function tokenRecord(data, now = Date.now()) {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    userId: String(data.user_id || ""),
    expiresAt: now + Number(data.expires_in || 0) * 1000,
    updatedAt: now
  };
}

async function exchangeCode(code) {
  const c = config();
  const data = await mpRequest("/oauth/token", {
    method: "POST",
    body: { client_id: c.clientId, client_secret: c.clientSecret, grant_type: "authorization_code", code, redirect_uri: redirectUri() }
  });
  return tokenRecord(data);
}

async function refresh(record) {
  const c = config();
  const data = await mpRequest("/oauth/token", {
    method: "POST",
    body: { client_id: c.clientId, client_secret: c.clientSecret, grant_type: "refresh_token", refresh_token: record.refreshToken }
  });
  return tokenRecord(data);
}

// Devolve um access token válido, renovando quando faltar menos de 7 dias.
// `save(record)` persiste o registro renovado.
async function validAccessToken(record, save, now = Date.now()) {
  if (!record?.accessToken) return null;
  if (Number(record.expiresAt) - now > REFRESH_AHEAD_MS) return record.accessToken;
  const fresh = await refresh(record);
  await save(fresh);
  return fresh.accessToken;
}

async function accountNickname(token) {
  const me = await mpRequest("/users/me", { token }).catch(() => null);
  return me?.nickname || me?.first_name || null;
}

async function createPixPayment(token, { amountCents, description, payerEmail, externalReference, notificationUrl, expiresAt, idempotencyKey }) {
  return mpRequest("/v1/payments", {
    method: "POST", token, idempotencyKey,
    body: {
      transaction_amount: Math.round(Number(amountCents)) / 100,
      payment_method_id: "pix",
      description: String(description || "Consulta").slice(0, 200),
      payer: { email: payerEmail },
      external_reference: externalReference,
      notification_url: notificationUrl,
      date_of_expiration: new Date(expiresAt).toISOString().replace("Z", "-00:00")
    }
  });
}

async function getPayment(token, paymentId) {
  return mpRequest(`/v1/payments/${encodeURIComponent(paymentId)}`, { token });
}

module.exports = {
  isConfigured, redirectUri, buildAuthUrl, exchangeCode, validAccessToken,
  accountNickname, createPixPayment, getPayment
};
