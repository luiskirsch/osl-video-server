require("dotenv").config();
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { cert } = require("firebase-admin/app");

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, "\n");
initializeApp({ credential: cert({ projectId: sa.project_id, clientEmail: sa.client_email, privateKey: sa.private_key }) });
const db = getFirestore();

async function main() {
  const snap = await db.collection("therapy_empresas").get();
  snap.forEach(doc => {
    const d = doc.data();
    console.log(`ID: ${doc.id} | Nome: ${d.nome} | Email: ${d.loginEmail} | Status: ${d.status}`);
  });
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
