// Diagnóstico: lista todos therapists e seus tissEnabled no staging Firestore
require("dotenv").config();
const admin = require("firebase-admin");

function initAdmin() {
  if (admin.apps.length) return admin.firestore();
  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
  const sa = JSON.parse(raw);
  if (sa.private_key) sa.private_key = String(sa.private_key).replace(/\\n/g, "\n");
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  return admin.firestore();
}

async function run() {
  const db = initAdmin();
  console.log("Firebase project:", JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON).project_id);
  const snap = await db.collection("therapists").get();
  snap.docs.forEach(doc => {
    const d = doc.data();
    console.log(`  uid=${doc.id}  displayName=${d.displayName || "?"}  tissEnabled=${d.tissEnabled}`);
  });
  process.exit(0);
}
run().catch(e => { console.error(e.message); process.exit(1); });
