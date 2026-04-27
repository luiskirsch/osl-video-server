const crypto = require("crypto");
const admin  = require("firebase-admin");
const { logInfo } = require("../logger");
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

module.exports = {
  generateReferralCodeFromUid, getAffiliateByCode,
  ensureAffiliateProfile, registerPendingReferral, approveReferralRewardFromPayment
};
