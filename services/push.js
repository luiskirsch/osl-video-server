// Wrapper Web Push (https://datatracker.ietf.org/doc/html/rfc8030).
// Inicializa web-push com VAPID keys do env. Se keys ausentes, no-op
// (sendPush retorna { ok: false, skipped: true } sem quebrar caller).
//
// Subscriptions são salvas em therapists.pushSubscriptions[] (array de
// { endpoint, keys: { p256dh, auth }, addedAt }). Limpeza automática:
// se sendPush retorna 410/404, remove a subscription do array (gone).

const { logInfo, logWarn, logError } = require("../logger");
const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = require("../config");

let webpush = null;
let initialized = false;
let initError = null;

function ensureInit() {
  if (initialized) return !initError;
  initialized = true;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    initError = "VAPID_KEYS_AUSENTES";
    return false;
  }
  try {
    webpush = require("web-push");
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    return true;
  } catch (e) {
    initError = e.message || "WEB_PUSH_FALHOU_AO_CARREGAR";
    logError("push_init_failed", e);
    return false;
  }
}

function isConfigured() {
  return ensureInit();
}

function getPublicKey() {
  return VAPID_PUBLIC_KEY || null;
}

// Envia push pra UMA subscription. Retorna { ok, gone?, error? }.
// gone=true significa que a subscription expirou — caller deve removê-la.
async function sendPush(subscription, payload) {
  if (!ensureInit()) return { ok: false, skipped: true, error: initError };
  if (!subscription || !subscription.endpoint) return { ok: false, error: "SUBSCRIPTION_INVALIDA" };
  try {
    const body = typeof payload === "string" ? payload : JSON.stringify(payload || {});
    await webpush.sendNotification(subscription, body, { TTL: 60 });
    return { ok: true };
  } catch (e) {
    // statusCode 410 (Gone) ou 404 → subscription cancelada
    if (e?.statusCode === 410 || e?.statusCode === 404) {
      return { ok: false, gone: true, error: "SUBSCRIPTION_EXPIRADA" };
    }
    logWarn("push_send_failed", { statusCode: e?.statusCode, message: e?.message });
    return { ok: false, error: e?.message || "PUSH_FALHOU", statusCode: e?.statusCode };
  }
}

// Envia push pra TODAS as subscriptions de um array. Idempotente — se
// alguma retornar gone, devolve a lista de endpoints pra caller limpar.
async function sendPushToAll(subscriptions, payload) {
  if (!Array.isArray(subscriptions) || subscriptions.length === 0) return { sent: 0, expired: [] };
  const results = await Promise.allSettled(subscriptions.map(s => sendPush(s, payload)));
  let sent = 0;
  const expired = [];
  results.forEach((r, idx) => {
    const sub = subscriptions[idx];
    if (r.status === "fulfilled") {
      if (r.value.ok) sent++;
      else if (r.value.gone) expired.push(sub.endpoint);
    }
  });
  return { sent, expired };
}

module.exports = {
  isConfigured,
  getPublicKey,
  sendPush,
  sendPushToAll
};
