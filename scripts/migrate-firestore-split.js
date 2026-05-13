// Script de migração: copia todas as collections terapia (therapy_*) de um
// projeto Firebase de origem para um novo projeto separado. Usado quando for
// separar staging ↔ prod (ver docs/ROADMAP-PENDENTE.md item 4).
//
// Uso:
//   1. Baixe service account JSON dos DOIS projetos no Firebase Console.
//      Console → Project Settings → Service Accounts → "Generate new private key"
//   2. Salve como service-account-source.json e service-account-target.json
//      na raiz do osl-video-server (NÃO commite — .gitignore já cobre *.json
//      via .firebase mas confirme).
//   3. node scripts/migrate-firestore-split.js [--dry-run]
//
// Importante:
//   - É SEGURO rodar (read-only no source, write-only no target).
//   - --dry-run faz tudo sem escrever. Recomendado primeiro.
//   - Coleções de auditoria (therapy_audit, etc) NÃO são copiadas — começam
//     limpas no novo projeto (audit antigo fica no projeto antigo).
//   - User accounts (Firebase Auth) NÃO migram automaticamente. Precisa
//     `firebase auth:export` + `firebase auth:import` separadamente.
//   - Storage objects (logos, etc) NÃO migram. Não usamos Storage hoje além
//     de logoBase64 inline em therapist doc, então OK.

const admin = require("firebase-admin");
const path = require("path");

const COLLECTIONS = [
  "therapists",
  "therapy_patients",
  "therapy_sessions",
  "therapy_session_notes",
  "therapy_anamneses",
  "therapy_scale_responses",
  "therapy_scheduling_requests",
  "therapy_transactions",
  "therapy_receipts",
  "therapy_receipt_counters",
  "therapy_clinics",
  "therapy_clinic_members",
  "therapy_documents",
  "therapy_receitas",
  "therapy_recipe_counters",
  "therapy_lista_espera",
  "therapy_nps_responses",
  "therapy_push_subscriptions",
  "therapy_birthday_optins",
  "therapy_note_templates"
  // NÃO inclui: therapy_audit, therapy_email_log (começam limpos no destino)
];

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const sourcePath = path.resolve("service-account-source.json");
  const targetPath = path.resolve("service-account-target.json");

  let sourceCred, targetCred;
  try { sourceCred = require(sourcePath); }
  catch { console.error("Não achei", sourcePath); process.exit(1); }
  try { targetCred = require(targetPath); }
  catch { console.error("Não achei", targetPath); process.exit(1); }

  const sourceApp = admin.initializeApp({
    credential: admin.credential.cert(sourceCred)
  }, "source");
  const targetApp = admin.initializeApp({
    credential: admin.credential.cert(targetCred)
  }, "target");

  const src = sourceApp.firestore();
  const tgt = targetApp.firestore();

  console.log(`Origem:  ${sourceCred.project_id}`);
  console.log(`Destino: ${targetCred.project_id}`);
  console.log(`Modo:    ${dryRun ? "DRY-RUN (sem escrita)" : "ESCRITA REAL"}`);
  console.log();

  let totalRead = 0;
  let totalWritten = 0;

  for (const collName of COLLECTIONS) {
    process.stdout.write(`${collName.padEnd(36)} `);
    const snap = await src.collection(collName).get();
    const docs = snap.docs;
    totalRead += docs.length;

    if (!docs.length) {
      console.log("vazio");
      continue;
    }

    if (dryRun) {
      console.log(`${docs.length} doc(s) [seria copiado]`);
      continue;
    }

    // Batched writes (max 500 por batch no Firestore).
    let written = 0;
    for (let i = 0; i < docs.length; i += 400) {
      const slice = docs.slice(i, i + 400);
      const batch = tgt.batch();
      for (const d of slice) {
        const data = d.data();
        // Remove campos serverTimestamp legacy se ainda Firestore types — re-stamp
        // como Date pra preservar.
        batch.set(tgt.collection(collName).doc(d.id), data);
      }
      await batch.commit();
      written += slice.length;
      process.stdout.write(`.`);
    }
    totalWritten += written;
    console.log(` ${written} doc(s) copiado(s)`);
  }

  console.log();
  console.log(`Total lido:    ${totalRead} docs`);
  console.log(`Total escrito: ${totalWritten} docs`);
  if (dryRun) console.log(`(DRY-RUN — nada foi escrito)`);

  await sourceApp.delete();
  await targetApp.delete();
}

main().catch(err => {
  console.error("Falhou:", err);
  process.exit(1);
});
