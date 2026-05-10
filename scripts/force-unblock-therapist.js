// Script único: libera o trial de um terapeuta marcando como plano="pro"
// permanente (sem cobrança real). Usado pra contas de fundador/equipe ou
// cortesias manuais.
//
// Uso (UID direto):    TARGET_UID=<uid>                 node scripts/force-unblock-therapist.js
// Uso (por email):     TARGET_EMAIL=<email>             node scripts/force-unblock-therapist.js
//
// Não usa autenticação Firebase Auth — opera direto via firebase-admin
// que pega credenciais das mesmas envs do servidor (FIREBASE_SERVICE_ACCOUNT
// em base64 ou GOOGLE_APPLICATION_CREDENTIALS).
//
// Idempotente: chamar 2x não faz mal. NÃO toca em trialUntil (evaluatePlanAccess
// libera direto pelo plano="pro" antes de checar trial). Marca proSource pra
// futuro webhook do MercadoPago saber que isso não veio de uma assinatura paga.

const admin = require("firebase-admin");

(async () => {
  const targetUid   = String(process.env.TARGET_UID   || "").trim();
  const targetEmail = String(process.env.TARGET_EMAIL || "").trim().toLowerCase();
  if (!targetUid && !targetEmail) {
    console.error("Informe TARGET_UID ou TARGET_EMAIL.");
    process.exit(1);
  }

  // Inicialização espelhando o server.js — usa FIREBASE_SERVICE_ACCOUNT (base64) se houver.
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT;
    if (raw) {
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch {
        try { parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8")); }
        catch (e) { console.error("FIREBASE_SERVICE_ACCOUNT inválido:", e.message); process.exit(1); }
      }
      admin.initializeApp({ credential: admin.credential.cert(parsed) });
    } else {
      admin.initializeApp();
    }
  }

  // Resolve UID a partir do email se necessário.
  let uid = targetUid;
  if (!uid) {
    try {
      const userRecord = await admin.auth().getUserByEmail(targetEmail);
      uid = userRecord.uid;
      console.log(`Email ${targetEmail} → uid ${uid}`);
    } catch (e) {
      console.error(`Não achei usuário com email ${targetEmail}:`, e.message);
      process.exit(1);
    }
  }

  const db = admin.firestore();
  const ref = db.collection("therapists").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    console.error(`therapists/${uid} não existe.`);
    process.exit(1);
  }

  const before = snap.data();
  console.log("Antes:", {
    displayName: before.displayName,
    email: before.email,
    plano: before.plano,
    trialUntil: before.trialUntil?.toMillis ? new Date(before.trialUntil.toMillis()).toISOString() : null,
    proSource: before.proSource || null
  });

  await ref.set({
    plano: "pro",
    proSource: "founder-manual-bypass",
    proSince: admin.firestore.FieldValue.serverTimestamp(),
    proPriceCents: 0,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  const after = (await ref.get()).data();
  console.log("Depois:", {
    displayName: after.displayName,
    email: after.email,
    plano: after.plano,
    proSource: after.proSource,
    proSince: after.proSince?.toMillis ? new Date(after.proSince.toMillis()).toISOString() : null,
    proPriceCents: after.proPriceCents
  });

  console.log("OK — acesso liberado. evaluatePlanAccess agora retorna canUseFeatures=true.");
  process.exit(0);
})().catch(err => {
  console.error("Erro:", err);
  process.exit(1);
});
