// Espaço Prelúdio — rotas Stripe (pagamentos USD internacionais).
//
// IMPORTANTE: /stripe/webhook usa express.raw() e DEVE ser registrado
// ANTES do express.json() global no server.js para receber o body cru
// que o Stripe exige pra validar a assinatura HMAC.

const express  = require("express");
const router   = express.Router();
const webhookRouter = express.Router();
const admin    = require("firebase-admin");
const { verifyFirebaseToken } = require("../services/auth");
const stripeSvc = require("../services/stripe");
const { logInfo, logWarn, logError } = require("../logger");
const { getDb } = require("../services/firestore");

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ─── POST /stripe/create-checkout ────────────────────────────────────────────
// Profissional logado solicita sessão de Stripe Checkout.
// Body: { tier: "profissional" | "recem_formado", billingCycle?: "month" | "year" }
// Retorna: { ok, url } — frontend redireciona para url.
router.post("/stripe/create-checkout", asyncHandler(async (req, res) => {
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const { tier } = req.body;
  if (!["profissional", "recem_formado"].includes(tier)) {
    return res.status(400).json({ ok: false, error: "TIER_INVALIDO" });
  }
  const billingCycle = String(req.body?.billingCycle || "month").trim().toLowerCase() === "year" ? "year" : "month";

  // Pega e-mail do profissional pra preencher no checkout (melhor conversão)
  let email;
  try {
    const snap = await getDb().collection("therapists").doc(uid).get();
    email = snap.data()?.email || undefined;
  } catch (_) { /* best-effort */ }

  const origin = (req.headers.origin || "https://espacopreludio.com.br").replace(/\/$/, "");
  const { url } = await stripeSvc.createCheckoutSession({
    tier,
    billingCycle,
    therapistUid: uid,
    email,
    successUrl: `${origin}/planos.html?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl:  `${origin}/planos.html?stripe=cancel`,
  });

  return res.json({ ok: true, url });
}));

// ─── POST /stripe/webhook ─────────────────────────────────────────────────────
// Recebe eventos do Stripe (pagamento confirmado, cancelamento, etc).
// Body DEVE ser raw (registrado antes do express.json() no server.js).
webhookRouter.post("/stripe/webhook",
  express.raw({ type: "application/json" }),
  asyncHandler(async (req, res) => {
    const sig = req.headers["stripe-signature"];
    if (!sig) return res.status(400).send("Missing stripe-signature");

    let event;
    try {
      event = stripeSvc.constructWebhookEvent(req.body, sig);
    } catch (err) {
      logWarn("stripe_webhook_sig_failed", { error: err.message });
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const db = getDb();
    logInfo("stripe_webhook_received", { type: event.type, id: event.id });

    try {
      switch (event.type) {

        // Checkout concluído → ativa plano
        case "checkout.session.completed": {
          const session = event.data.object;
          if (session.mode !== "subscription") break;
          const { therapistUid, tier, billingCycle } = session.metadata || {};
          if (!therapistUid || !tier) break;

          const proTier = tier === "recem_formado" ? "recem-formado" : "profissional";
          const cycle = billingCycle === "year" ? "year" : "month";
          const plan = stripeSvc.STRIPE_PLANS[tier];
          const proPriceCents = plan ? (cycle === "year" ? plan.amountAnnual : plan.amount) : null;

          await db.collection("therapists").doc(therapistUid).set({
            plano:                  "pro",
            proTier,
            proPriceCents,
            proBillingCycle:        cycle,
            planSource:             "stripe",
            planActive:             true,
            stripeCustomerId:       session.customer,
            stripeSubscriptionId:   session.subscription,
            planActivatedAt:        admin.firestore.FieldValue.serverTimestamp(),
            updatedAt:              admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });

          logInfo("stripe_plan_activated", { therapistUid, tier, billingCycle: cycle, customerId: session.customer });
          break;
        }

        // Pagamento recorrente bem-sucedido → mantém ativo
        case "invoice.payment_succeeded": {
          const inv = event.data.object;
          if (inv.billing_reason === "subscription_create") break; // já tratado acima
          const customerId = inv.customer;
          const snap = await db.collection("therapists")
            .where("stripeCustomerId", "==", customerId).limit(1).get();
          if (!snap.empty) {
            await snap.docs[0].ref.set({
              planActive: true,
              planRenewedAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
          }
          break;
        }

        // Pagamento falhou
        case "invoice.payment_failed": {
          const inv = event.data.object;
          const customerId = inv.customer;
          const snap = await db.collection("therapists")
            .where("stripeCustomerId", "==", customerId).limit(1).get();
          if (!snap.empty) {
            await snap.docs[0].ref.set({
              planActive: false,
              planPaymentFailed: true,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
            logWarn("stripe_payment_failed", { customerId, invoiceId: inv.id });
          }
          break;
        }

        // Assinatura cancelada → expira plano
        case "customer.subscription.deleted": {
          const sub = event.data.object;
          const customerId = sub.customer;
          const snap = await db.collection("therapists")
            .where("stripeCustomerId", "==", customerId).limit(1).get();
          if (!snap.empty) {
            await snap.docs[0].ref.set({
              plano:         "expired",
              planSource:    "stripe",
              planActive:    false,
              planExpiredAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
            logInfo("stripe_plan_expired", { customerId });
          }
          break;
        }

        default:
          break;
      }
    } catch (err) {
      logError("stripe_webhook_handler_failed", err, { type: event.type });
      // Retorna 200 mesmo em erro de handler — evita que Stripe re-envie infinitamente
    }

    return res.json({ received: true });
  })
);

// ─── POST /stripe/portal ──────────────────────────────────────────────────────
// Cria sessão do Stripe Billing Portal (gerenciar/cancelar assinatura).
router.post("/stripe/portal", asyncHandler(async (req, res) => {
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const snap = await getDb().collection("therapists").doc(uid).get();
  const stripeCustomerId = snap.data()?.stripeCustomerId;
  if (!stripeCustomerId) {
    return res.status(404).json({ ok: false, error: "SEM_ASSINATURA_STRIPE" });
  }

  const origin = (req.headers.origin || "https://espacopreludio.com.br").replace(/\/$/, "");
  const url = await stripeSvc.createPortalSession({
    stripeCustomerId,
    returnUrl: `${origin}/perfil.html`,
  });

  return res.json({ ok: true, url });
}));

module.exports = { router, webhookRouter };
