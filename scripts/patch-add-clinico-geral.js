/**
 * Patch: adiciona 3 sessões de "Clínico Geral" na empresa demo
 * (sem apagar dados existentes)
 */
require("dotenv").config();
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { cert } = require("firebase-admin/app");

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, "\n");
initializeApp({ credential: cert({ projectId: sa.project_id, clientEmail: sa.client_email, privateKey: sa.private_key }) });
const db = getFirestore();

const EMPRESA_ID = "zjUHicOuwehjspdtxbfo";
const now = Date.now();
const day = 24 * 3600 * 1000;

const NOVAS_SESSOES = [
  { uid: "demo-patient-uid-003", email: "fernanda.costa@preludiodemo.com.br",  nome: "Fernanda Costa",      daysAgo: 7  },
  { uid: "demo-patient-uid-007", email: "larissa.ferreira@preludiodemo.com.br",nome: "Larissa Ferreira",    daysAgo: 12 },
  { uid: "demo-patient-uid-009", email: "natalia.pereira@preludiodemo.com.br", nome: "Natália Pereira",     daysAgo: 19 },
];

async function main() {
  const batch = db.batch();
  for (const s of NOVAS_SESSOES) {
    const ref = db.collection("therapy_sessions").doc();
    batch.set(ref, {
      patientUid: s.uid,
      patientEmail: s.email,
      patientNome: s.nome,
      therapistUid: "demo-therapist-uid",
      therapistEspecialidade: "Clínico Geral",
      status: "completed",
      scheduledAt: now - s.daysAgo * day,
      demo: true,
      createdAt: Timestamp.fromMillis(now - s.daysAgo * day),
    });
  }
  await batch.commit();
  console.log("✓ 3 sessões de Clínico Geral adicionadas. Atualize o painel.");
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
