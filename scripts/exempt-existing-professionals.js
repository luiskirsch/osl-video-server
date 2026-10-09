// Isenta de mensalidade TODOS os profissionais cadastrados até agora
// (legacyExempt). Novos cadastros continuam pagando.
//   railway run node scripts/exempt-existing-professionals.js
"use strict";
const admin = require("firebase-admin");
const { getDb } = require("../services/firestore");
(async () => {
  const db = getDb(); const snap = await db.collection("therapists").get();
  let n = 0, batch = db.batch(), inBatch = 0;
  for (const d of snap.docs) {
    batch.set(d.ref, { legacyExempt: true, legacyExemptSince: Date.now(), professionalPaymentRequired: false, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    n++; inBatch++;
    if (inBatch === 400) { await batch.commit(); batch = db.batch(); inBatch = 0; }
  }
  if (inBatch) await batch.commit();
  await db.collection("therapy_audit").add({ type: "admin_legacy_exempt_all", count: n, at: admin.firestore.FieldValue.serverTimestamp() });
  console.log("Profissionais isentos:", n);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
