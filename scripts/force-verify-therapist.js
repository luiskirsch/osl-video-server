// Script único: marca um terapeuta como verified no Firestore.
// Uso: TARGET_UID=<uid> node scripts/force-verify-therapist.js
//
// Não usa autenticação Firebase Auth — opera direto via firebase-admin
// que pega credenciais das mesmas envs do servidor (FIREBASE_SERVICE_ACCOUNT
// em base64 ou GOOGLE_APPLICATION_CREDENTIALS).
//
// Idempotente: chamar 2x não faz mal. Não cria therapy_verifications/{id}
// (porque o objetivo é só ativar a flag pra teste do selo público).

const admin = require("firebase-admin");

(async () => {
  const targetUid = process.env.TARGET_UID || "";
  if (!targetUid) {
    console.error("TARGET_UID env var é obrigatório.");
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

  const db = admin.firestore();
  const ref = db.collection("therapists").doc(targetUid);
  const snap = await ref.get();
  if (!snap.exists) {
    console.error(`therapists/${targetUid} não existe.`);
    process.exit(1);
  }

  const before = snap.data();
  console.log("Antes:", {
    verificationStatus: before.verificationStatus,
    verifiedAt: before.verifiedAt?.toMillis ? new Date(before.verifiedAt.toMillis()).toISOString() : null
  });

  await ref.set({
    verificationStatus: "verified",
    verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  const after = (await ref.get()).data();
  console.log("Depois:", {
    verificationStatus: after.verificationStatus,
    verifiedAt: after.verifiedAt?.toMillis ? new Date(after.verifiedAt.toMillis()).toISOString() : null,
    displayName: after.displayName
  });

  console.log("OK.");
  process.exit(0);
})().catch(err => {
  console.error("Erro:", err);
  process.exit(1);
});
