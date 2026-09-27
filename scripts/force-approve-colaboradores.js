// Script único: aprova colaborador(es) por e-mail em therapy_colaboradores
// (status:"ativo" + eligibilityVerifiedAt) e ativa a empresa vinculada se
// ela ainda não estiver com benefício ativo. Só toca em registros que já
// existem — não cria colaborador nem empresa do zero.
//
// Uso: EMAILS="a@x.com,b@y.com" CONFIRM_FIREBASE_PROJECT=<project_id> node scripts/force-approve-colaboradores.js
//
// Credenciais: mesma convenção dos outros scripts admin (force-verify-therapist.js) —
// FIREBASE_SERVICE_ACCOUNT_JSON (ou _BASE64) vindo do .env local, nunca extraído
// de credenciais ambiente/CLI.

const admin = require("firebase-admin");
const { assertFirebaseProjectConfirmed } = require("./confirm-firebase-project");

(async () => {
  const emailsRaw = process.env.EMAILS || "";
  const emails = emailsRaw.split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
  if (!emails.length) {
    console.error("EMAILS env var é obrigatório (separados por vírgula).");
    process.exit(1);
  }

  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) {
      console.error("FIREBASE_SERVICE_ACCOUNT_JSON/BASE64 é obrigatório.");
      process.exit(1);
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch {
      try { parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8")); }
      catch (e) { console.error("FIREBASE_SERVICE_ACCOUNT inválido:", e.message); process.exit(1); }
    }
    assertFirebaseProjectConfirmed(parsed, "force-approve-colaboradores");
    admin.initializeApp({ credential: admin.credential.cert(parsed) });
  }

  const db = admin.firestore();

  for (const email of emails) {
    console.log(`\n── ${email} ──`);
    const snap = await db.collection("therapy_colaboradores").where("email", "==", email).get();
    if (snap.empty) {
      console.log("  Sem registro em therapy_colaboradores — nada a aprovar (colaborador não se cadastrou ainda).");
      continue;
    }

    for (const doc of snap.docs) {
      const c = doc.data();
      console.log(`  Colaborador ${doc.id} — empresa ${c.empresaNome || c.empresaId || "?"} — status atual: ${c.status || "pendente"}`);

      if (c.status !== "ativo") {
        await doc.ref.set({
          status: "ativo",
          eligibilityVerifiedAt: c.eligibilityVerifiedAt || Date.now(),
          eligibilityVerifiedBy: "script:force-approve-colaboradores",
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        console.log("  → status atualizado para ativo.");
      } else {
        console.log("  → já estava ativo.");
      }

      if (c.empresaId) {
        const empresaRef = db.collection("therapy_empresas").doc(c.empresaId);
        const empresaSnap = await empresaRef.get();
        if (!empresaSnap.exists) {
          console.log(`  Empresa ${c.empresaId} não encontrada — pulando ativação de benefício.`);
          continue;
        }
        const empresa = empresaSnap.data();
        const needsActivation = empresa.status !== "ativa" || empresa.benefitStatus !== "active";
        if (needsActivation) {
          await empresaRef.set({
            status: "ativa",
            benefitStatus: "active",
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          console.log(`  → empresa ${empresa.nome || c.empresaId} ativada (status + benefitStatus).`);
        } else {
          console.log(`  Empresa ${empresa.nome || c.empresaId} já estava ativa.`);
        }
      }
    }
  }

  console.log("\nOK.");
  process.exit(0);
})().catch(err => {
  console.error("Erro:", err);
  process.exit(1);
});
