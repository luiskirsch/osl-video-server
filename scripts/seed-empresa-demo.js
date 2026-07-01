/**
 * Seed de dados fictícios para demonstração do painel de empresa.
 * Empresa: Preludio Software Systems LTDA (zjUHicOuwehjspdtxbfo)
 *
 * Cria:
 *   - 15 colaboradores (12 ativos, 3 inativos)
 *   - 10 contas de paciente (vinculadas por e-mail)
 *   - 22 sessões concluídas (nos últimos 30 dias + algumas mais antigas)
 */
require("dotenv").config();
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, Timestamp, FieldValue } = require("firebase-admin/firestore");
const { cert } = require("firebase-admin/app");

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, "\n");
initializeApp({ credential: cert({ projectId: sa.project_id, clientEmail: sa.client_email, privateKey: sa.private_key }) });
const db = getFirestore();

const EMPRESA_ID = "zjUHicOuwehjspdtxbfo";

const now = Date.now();
const day = 24 * 3600 * 1000;

// 15 colaboradores fictícios
const COLABORADORES = [
  { nome: "Ana Paula Ribeiro",    email: "ana.ribeiro@preludiodemo.com.br",    status: "ativo" },
  { nome: "Carlos Eduardo Lima",  email: "carlos.lima@preludiodemo.com.br",    status: "ativo" },
  { nome: "Fernanda Costa",       email: "fernanda.costa@preludiodemo.com.br", status: "ativo" },
  { nome: "Gustavo Mendes",       email: "gustavo.mendes@preludiodemo.com.br", status: "ativo" },
  { nome: "Isabela Souza",        email: "isabela.souza@preludiodemo.com.br",  status: "ativo" },
  { nome: "João Victor Alves",    email: "joao.alves@preludiodemo.com.br",     status: "ativo" },
  { nome: "Larissa Ferreira",     email: "larissa.ferreira@preludiodemo.com.br", status: "ativo" },
  { nome: "Marcos Oliveira",      email: "marcos.oliveira@preludiodemo.com.br", status: "ativo" },
  { nome: "Natália Pereira",      email: "natalia.pereira@preludiodemo.com.br", status: "ativo" },
  { nome: "Pedro Henrique Dias",  email: "pedro.dias@preludiodemo.com.br",     status: "ativo" },
  { nome: "Rafaela Cardoso",      email: "rafaela.cardoso@preludiodemo.com.br", status: "ativo" },
  { nome: "Thiago Barbosa",       email: "thiago.barbosa@preludiodemo.com.br", status: "ativo" },
  { nome: "Viviane Martins",      email: "viviane.martins@preludiodemo.com.br", status: "inativo" },
  { nome: "Diego Rocha",          email: "diego.rocha@preludiodemo.com.br",    status: "inativo" },
  { nome: "Camila Nascimento",    email: "camila.nascimento@preludiodemo.com.br", status: "inativo" },
];

// 10 deles têm conta de paciente (os 10 primeiros ativos)
const COM_CONTA = COLABORADORES.slice(0, 10).map((c, i) => ({
  ...c,
  uid: `demo-patient-uid-${String(i + 1).padStart(3, "0")}`
}));

// Sessões por paciente (scheduledAt em ms)
// 22 sessões: 16 nos últimos 30 dias, 6 mais antigas
const ESPECIALIDADES = [
  "Psicologia Clínica",
  "Psicologia Clínica",
  "Psicologia Clínica",
  "Terapia Cognitivo-Comportamental",
  "Terapia Cognitivo-Comportamental",
  "Neuropsicologia",
  "Psicanálise",
  "Clínico Geral",
];

function esp() { return ESPECIALIDADES[Math.floor(Math.random() * ESPECIALIDADES.length)]; }

const SESSIONS = [
  // últimos 30 dias (sessoesMes)
  { patientIdx: 0, daysAgo: 2  },
  { patientIdx: 1, daysAgo: 3  },
  { patientIdx: 2, daysAgo: 4  },
  { patientIdx: 3, daysAgo: 5  },
  { patientIdx: 4, daysAgo: 6  },
  { patientIdx: 5, daysAgo: 8  },
  { patientIdx: 6, daysAgo: 10 },
  { patientIdx: 7, daysAgo: 11 },
  { patientIdx: 8, daysAgo: 13 },
  { patientIdx: 9, daysAgo: 15 },
  { patientIdx: 0, daysAgo: 16 }, // 2ª sessão do Ana
  { patientIdx: 1, daysAgo: 17 },
  { patientIdx: 2, daysAgo: 18 },
  { patientIdx: 3, daysAgo: 20 },
  { patientIdx: 4, daysAgo: 22 },
  { patientIdx: 5, daysAgo: 25 },
  // mais antigas (só sessoesTotal)
  { patientIdx: 6, daysAgo: 35 },
  { patientIdx: 7, daysAgo: 42 },
  { patientIdx: 8, daysAgo: 50 },
  { patientIdx: 9, daysAgo: 58 },
  { patientIdx: 0, daysAgo: 65 },
  { patientIdx: 1, daysAgo: 70 },
];

async function main() {
  const batch1 = db.batch();

  // --- Colaboradores ---
  console.log("Criando 15 colaboradores...");
  for (const c of COLABORADORES) {
    const ref = db.collection("therapy_colaboradores").doc();
    batch1.set(ref, {
      empresaId: EMPRESA_ID,
      nome: c.nome,
      email: c.email,
      status: c.status,
      createdAt: Timestamp.fromMillis(now - Math.floor(Math.random() * 90) * day),
      updatedAt: Timestamp.fromMillis(now),
    });
  }

  // --- Contas de paciente (10) ---
  console.log("Criando 10 contas de paciente...");
  for (const p of COM_CONTA) {
    const ref = db.collection("therapy_patient_accounts").doc(p.uid);
    batch1.set(ref, {
      uid: p.uid,
      email: p.email,
      nome: p.nome,
      demo: true,
      createdAt: Timestamp.fromMillis(now - 60 * day),
    });
  }

  await batch1.commit();
  console.log("Batch 1 OK");

  // --- Sessões (22) — batch separado ---
  const batch2 = db.batch();
  console.log("Criando 22 sessões concluídas...");
  for (const s of SESSIONS) {
    const patient = COM_CONTA[s.patientIdx];
    const ref = db.collection("therapy_sessions").doc();
    batch2.set(ref, {
      patientUid: patient.uid,
      patientEmail: patient.email,
      patientNome: patient.nome,
      therapistUid: "demo-therapist-uid",
      therapistEspecialidade: esp(),
      status: "completed",
      scheduledAt: now - s.daysAgo * day,
      demo: true,
      createdAt: Timestamp.fromMillis(now - s.daysAgo * day),
    });
  }
  await batch2.commit();
  console.log("Batch 2 OK");

  console.log("\n✓ Seed concluído! Abra empresa-painel.html e atualize.");
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
