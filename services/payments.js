const { httpFetch } = require("../utils");
const { MP_ACCESS_TOKEN_JOGO, MP_ACCESS_TOKEN_THERAPY } = require("../config");

// Fabrica uma fn fetch do MP atrelada a um token específico. Cada produto
// (jogo vs therapy) aponta pra uma aplicação MP distinta — dinheiro vai
// pra contas separadas. Veja config.js pra detalhes do fallback legado.
function makeMpFetch(token, label) {
  return async function mercadoPagoFetchImpl(url, options = {}) {
    if (!token) throw new Error(`MP_ACCESS_TOKEN_NAO_CONFIGURADO_${label}`);
    const response = await httpFetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(options.headers || {})
      }
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  };
}

const mercadoPagoFetchJogo    = makeMpFetch(MP_ACCESS_TOKEN_JOGO,    "JOGO");
const mercadoPagoFetchTherapy = makeMpFetch(MP_ACCESS_TOKEN_THERAPY, "THERAPY");

// Alias legado — aponta pro jogo. Mantido pra não quebrar imports de
// routes/payments.js e routes/license.js que ainda usam o nome antigo.
// Novos call sites devem importar Jogo/Therapy explicitamente.
const mercadoPagoFetch = mercadoPagoFetchJogo;

async function approvedGamePayment(ref, caller) {
  const cached = require("../game/state").pagamentosAprovados.get(ref);
  if (cached) return cached;
  if (!/^OSL-[0-9]+-[A-F0-9]{10}$/.test(ref)) return null;
  const db = require("./firestore").getDb();
  if (!db) return null;
  const receipt = (await db.collection("processed_payments").doc(ref).get()).data();
  if (["gravacao-download", "segunda-chance", "carta-bloqueada", "carta-final"].includes(receipt?.produto) && receipt.sessionId && receipt.roomId && receipt.email) {
    return { ...receipt, approved: true, status: "approved" };
  }
  if (!caller?.uid || !caller.email || receipt) return null;
  const checkout = (await db.collection("recording_checkouts").doc(ref).get()).data();
  if (!checkout || checkout.uid !== caller.uid || checkout.email !== caller.email.toLowerCase()) return null;
  const params = new URLSearchParams({ external_reference: ref, status: "approved" });
  const { response, data } = await mercadoPagoFetchJogo("https://api.mercadopago.com/v1/payments/search?" + params);
  if (!response.ok) throw new Error("MP_CONSULTA_INDISPONIVEL");
  const payment = data.results?.find(p => p.status === "approved" && p.external_reference === ref &&
    p.metadata?.product_id === "gravacao-download" && p.metadata.customer_email === checkout.email &&
    p.metadata.room_id === checkout.roomId && p.metadata.session_id === checkout.sessionId &&
    p.transaction_amount === checkout.price && p.currency_id === checkout.currency);
  if (!payment) return null;
  await require("./sessionRecording").attachPurchase(checkout.roomId, { ref, sessionId: checkout.sessionId });
  return { approved: true, status: "approved", paymentId: String(payment.id), ref, produto: "gravacao-download",
    email: checkout.email, roomId: checkout.roomId, sessionId: checkout.sessionId };
}

module.exports = { approvedGamePayment, mercadoPagoFetch, mercadoPagoFetchJogo, mercadoPagoFetchTherapy };
