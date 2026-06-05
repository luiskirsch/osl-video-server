// Espaço Prelúdio — integração Stripe para pagamentos em USD.
//
// Mercado Pago cobre BRL (Brasil). Stripe cobre USD (internacional).
// Fluxo: frontend detecta moeda → chama /stripe/create-checkout →
// redireciona para Stripe Checkout → webhook confirma → atualiza Firestore.

const { logInfo, logWarn, logError } = require("../logger");

let _stripe = null;
function getStripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY não configurada");
  _stripe = require("stripe")(key);
  return _stripe;
}

// Planos USD — product IDs criados no Stripe Dashboard.
const STRIPE_PLANS = {
  profissional: {
    productId: process.env.STRIPE_PRODUCT_PROFISSIONAL || "prod_Ue5U9e3XuIPbk8",
    amount:    4900,   // $49.00 USD em centavos
    label:     "Espaço Prelúdio — Profissional",
  },
  recem_formado: {
    productId: process.env.STRIPE_PRODUCT_RECEM_FORMADO || "prod_Ue5VgWZSTEV1Aq",
    amount:    2900,   // $29.00 USD em centavos
    label:     "Espaço Prelúdio — Recém-formado",
  },
};

/**
 * Cria sessão de Stripe Checkout (modo subscription).
 * @param {object} opts
 * @param {"profissional"|"recem_formado"} opts.tier
 * @param {string}  opts.therapistUid  - UID Firebase do profissional
 * @param {string}  opts.successUrl    - URL após pagamento aprovado
 * @param {string}  opts.cancelUrl     - URL se o usuário cancelar
 * @param {string}  [opts.email]       - Preenche e-mail no checkout
 * @returns {Promise<{url: string, sessionId: string}>}
 */
async function createCheckoutSession({ tier, therapistUid, successUrl, cancelUrl, email }) {
  const plan = STRIPE_PLANS[tier];
  if (!plan) throw new Error("TIER_INVALIDO");

  const stripe = getStripe();
  const params = {
    mode: "subscription",
    line_items: [{
      price_data: {
        currency: "usd",
        product: plan.productId,
        unit_amount: plan.amount,
        recurring: { interval: "month" },
      },
      quantity: 1,
    }],
    metadata: { therapistUid, tier },
    client_reference_id: therapistUid,
    success_url: successUrl,
    cancel_url:  cancelUrl,
    allow_promotion_codes: true,
    subscription_data: {
      metadata: { therapistUid, tier },
    },
  };
  if (email) params.customer_email = email;

  const session = await stripe.checkout.sessions.create(params);
  logInfo("stripe_checkout_created", { sessionId: session.id, tier, therapistUid });
  return { url: session.url, sessionId: session.id };
}

/**
 * Valida e parseia evento do webhook Stripe.
 * Lança erro se assinatura inválida.
 */
function constructWebhookEvent(rawBody, sig) {
  const stripe  = getStripe();
  const secret  = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET não configurada");
  return stripe.webhooks.constructEvent(rawBody, sig, secret);
}

/**
 * Cria sessão do Stripe Billing Portal (gerenciar/cancelar assinatura).
 */
async function createPortalSession({ stripeCustomerId, returnUrl }) {
  const stripe = getStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer:   stripeCustomerId,
    return_url: returnUrl,
  });
  return session.url;
}

module.exports = { createCheckoutSession, constructWebhookEvent, createPortalSession, STRIPE_PLANS };
