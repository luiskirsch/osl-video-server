const crypto = require("crypto");
const admin  = require("firebase-admin");
const { logInfo, logWarn, logError } = require("../logger");
const { normalizeUid, normalizeEmail } = require("../utils");
const {
  PRODUCT_PRICE, REFERRAL_REWARD_COINS, REFERRAL_COMMISSION_PERCENT
} = require("../config");
const { getDb } = require("./firestore");

function generateReferralCodeFromUid(uid) {
  const clean = String(uid || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const base  = clean || crypto.randomBytes(4).toString("hex").toUpperCase();
  return `OSL${base.slice(0, 8)}`;
}

async function getAffiliateByCode(refCode) {
  const db   = getDb();
  const code = String(refCode || "").trim().toUpperCase();
  if (!code) return null;

  const snap = await db.collection("affiliates").where("refCode", "==", code).limit(1).get();
  if (snap.empty) return null;

  const docSnap = snap.docs[0];
  return { id: docSnap.id, ref: docSnap.ref, data: docSnap.data() };
}

async function ensureAffiliateProfile({ uid, email = "", nome = "" }) {
  const db = getDb();
  const normalizedUid   = normalizeUid(uid);
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedUid) throw new Error("UID_OBRIGATORIO_AFFILIATE");

  const ref  = db.collection("affiliates").doc(normalizedUid);
  const snap = await ref.get();

  if (snap.exists) {
    const current = snap.data();
    await ref.set(
      {
        email: normalizedEmail || current.email || "",
        nome: String(nome || "").trim().slice(0, 80) || current.nome || "",
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
    const refreshed = await ref.get();
    return refreshed.data();
  }

  const refCode = generateReferralCodeFromUid(normalizedUid);
  await ref.set(
    {
      uid: normalizedUid,
      email: normalizedEmail,
      nome: String(nome || "").trim().slice(0, 80),
      refCode,
      coins: 0,
      referralsApproved: 0,
      referralsPending: 0,
      commissionApproved: 0,
      withdrawableCoins: 0,
      totalPaidOutBRL: 0,
      pixKey: "",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );
  const created = await ref.get();
  return created.data();
}

async function registerPendingReferral({
  paymentId = "",
  externalReference = "",
  buyerEmail = "",
  buyerName = "",
  refCode = "",
  referrerUid = "",
  amount = PRODUCT_PRICE
}) {
  if (!refCode || !referrerUid) return;
  const referralId = externalReference || paymentId;
  if (!referralId) return;

  const db          = getDb();
  const referralRef = db.collection("referrals").doc(referralId);
  const referralSnap = await referralRef.get();

  if (!referralSnap.exists) {
    await referralRef.set({
      referralId,
      paymentId: String(paymentId || ""),
      externalReference: String(externalReference || ""),
      buyerEmail: normalizeEmail(buyerEmail),
      buyerName: String(buyerName || "").trim().slice(0, 80),
      refCode: String(refCode || "").trim().toUpperCase(),
      referrerUid: String(referrerUid || "").trim(),
      status: "pending",
      coinsAwarded: 0,
      commissionAmount: Number(amount || 0) * REFERRAL_COMMISSION_PERCENT,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await db.collection("affiliates").doc(referrerUid).set(
      { referralsPending: admin.firestore.FieldValue.increment(1), updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
  }
}

async function approveReferralRewardFromPayment(payment) {
  if (!payment) return;

  const paymentId         = String(payment.id || "").trim();
  const externalReference = String(payment.external_reference || "").trim();
  const metadata          = payment.metadata || {};
  const refCode           = String(metadata.ref_code || "").trim().toUpperCase();
  const referrerUid       = String(metadata.referrer_uid || "").trim();

  if (!paymentId || !externalReference || !refCode || !referrerUid) {
    logInfo("payment_without_affiliate_metadata");
    return;
  }

  const db           = getDb();
  const referralRef  = db.collection("referrals").doc(externalReference);
  const affiliateRef = db.collection("affiliates").doc(referrerUid);

  await db.runTransaction(async (tx) => {
    const referralSnap  = await tx.get(referralRef);
    const affiliateSnap = await tx.get(affiliateRef);

    if (!affiliateSnap.exists) throw new Error("AFILIADO_NAO_ENCONTRADO");

    const commissionAmount = Number(payment.transaction_amount || PRODUCT_PRICE) * REFERRAL_COMMISSION_PERCENT;

    if (!referralSnap.exists) {
      tx.set(referralRef, {
        referralId: externalReference,
        paymentId,
        externalReference,
        buyerEmail: normalizeEmail(payment.payer?.email || metadata.customer_email || ""),
        buyerName: String(metadata.customer_name || payment.payer?.first_name || "").trim().slice(0, 80),
        refCode,
        referrerUid,
        status: "approved",
        coinsAwarded: REFERRAL_REWARD_COINS,
        commissionAmount,
        approvedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    } else {
      const referral = referralSnap.data();
      if (referral.status === "approved") { logInfo("referral_already_approved", { externalReference }); return; }
      tx.set(referralRef, {
        paymentId, status: "approved", coinsAwarded: REFERRAL_REWARD_COINS, commissionAmount,
        approvedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }

    tx.set(affiliateRef, {
      coins: admin.firestore.FieldValue.increment(REFERRAL_REWARD_COINS),
      withdrawableCoins: admin.firestore.FieldValue.increment(REFERRAL_REWARD_COINS),
      referralsApproved: admin.firestore.FieldValue.increment(1),
      referralsPending: admin.firestore.FieldValue.increment(-1),
      commissionApproved: admin.firestore.FieldValue.increment(commissionAmount),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });
}

// ─────────────────────────────────────────────────────────────────────────
// #B1: fila persistente de retry pra aprovação de comissão. Webhook do MP
// roda 1x; se Firestore estiver fora ou approveReferralRewardFromPayment
// jogar erro transiente, o afiliado perdia a comissão sem nenhuma chance
// de retry. Agora gravamos snapshot do payment em pending_referrals e o
// scheduler reprocessa com backoff exponencial.
//
// Modelo: pending_referrals/{externalReference}
//   { externalReference, paymentSnapshot, attemptCount, lastError,
//     lastAttemptAt, nextAttemptAt, failedPermanently }
//
// Backoff: 1min, 5min, 30min, 2h, 12h. Após 5 tentativas falhadas →
// failedPermanently=true. Revisão manual via Firestore Console.
// ─────────────────────────────────────────────────────────────────────────
const RETRY_BACKOFF_MS = [60_000, 5*60_000, 30*60_000, 2*60*60_000, 12*60*60_000];
const MAX_RETRY_ATTEMPTS = RETRY_BACKOFF_MS.length;

async function enqueuePendingReferral(payment, error) {
  const db = getDb();
  if (!db) return;
  const externalReference = String(payment?.external_reference || "").trim();
  if (!externalReference) return;

  // paymentSnapshot é o mínimo necessário pra retry: id, external_reference,
  // metadata, transaction_amount, payer.email. Não persistimos o payload
  // inteiro pra evitar dados sensíveis e tamanhos grandes.
  const paymentSnapshot = {
    id: String(payment.id || ""),
    external_reference: externalReference,
    metadata: payment.metadata || {},
    transaction_amount: Number(payment.transaction_amount || 0),
    payer: { email: payment.payer?.email || "", first_name: payment.payer?.first_name || "" }
  };

  try {
    const ref = db.collection("pending_referrals").doc(externalReference);
    const snap = await ref.get();
    const now = Date.now();
    if (snap.exists) {
      // Já enfileirado — só atualiza erro e retry count (não regrida nextAttemptAt).
      const cur = snap.data();
      if (cur.failedPermanently) return;
      const attempt = Math.min((cur.attemptCount || 0) + 1, MAX_RETRY_ATTEMPTS);
      const failedPermanently = attempt >= MAX_RETRY_ATTEMPTS;
      const backoff = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)];
      await ref.set({
        attemptCount: attempt,
        lastError: String(error?.message || error || "unknown"),
        lastAttemptAt: now,
        nextAttemptAt: failedPermanently ? null : now + backoff,
        failedPermanently,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } else {
      await ref.set({
        externalReference,
        paymentSnapshot,
        attemptCount: 1,
        lastError: String(error?.message || error || "unknown"),
        lastAttemptAt: now,
        nextAttemptAt: now + RETRY_BACKOFF_MS[0],
        failedPermanently: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    logWarn("affiliate_enqueued_for_retry", { externalReference });
  } catch (queueErr) {
    logError("affiliate_enqueue_failed", queueErr, { externalReference });
  }
}

async function processPendingReferrals() {
  const db = getDb();
  if (!db) return { processed: 0, succeeded: 0, failed: 0 };
  const now = Date.now();
  // Filtro em só 1 campo pra evitar exigência de composite index. Pending
  // referrals tipicamente tem <100 docs (são casos de erro); filtrar nextAttemptAt
  // client-side é barato.
  const snap = await db.collection("pending_referrals")
    .where("failedPermanently", "==", false)
    .limit(200)
    .get();

  let processed = 0, succeeded = 0, failed = 0;
  for (const doc of snap.docs) {
    if ((doc.data().nextAttemptAt || 0) > now) continue;
    processed++;
    const data = doc.data();
    try {
      await approveReferralRewardFromPayment(data.paymentSnapshot);
      // Sucesso: remove da fila.
      await doc.ref.delete();
      succeeded++;
      logInfo("affiliate_retry_succeeded", { externalReference: data.externalReference, attempt: data.attemptCount });
    } catch (err) {
      failed++;
      const attempt = Math.min((data.attemptCount || 0) + 1, MAX_RETRY_ATTEMPTS);
      const failedPermanently = attempt >= MAX_RETRY_ATTEMPTS;
      const backoff = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)];
      await doc.ref.set({
        attemptCount: attempt,
        lastError: String(err?.message || err),
        lastAttemptAt: now,
        nextAttemptAt: failedPermanently ? null : now + backoff,
        failedPermanently,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      if (failedPermanently) {
        logError("affiliate_retry_exhausted", err, { externalReference: data.externalReference, attempts: attempt });
      } else {
        logWarn("affiliate_retry_failed_will_retry", { externalReference: data.externalReference, attempt, nextAttemptAt: now + backoff });
      }
    }
  }
  if (processed > 0) {
    logInfo("affiliate_retry_tick", { processed, succeeded, failed });
  }
  return { processed, succeeded, failed };
}

module.exports = {
  generateReferralCodeFromUid, getAffiliateByCode,
  ensureAffiliateProfile, registerPendingReferral, approveReferralRewardFromPayment,
  enqueuePendingReferral, processPendingReferrals
};
