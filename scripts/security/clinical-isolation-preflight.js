"use strict";
// Read-only migration inventory. Credentials arrive on stdin, never in argv.
// No patient fields, document identifiers, password hashes or keys are exported.
const fs = require("node:fs");
const { initializeApp, cert, deleteApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

function classifyCollection(name) {
  if (["therapists", "private_files", "attendance_certificates"].includes(name) || /^(?:therapy_|nr1_)/.test(name)) return "clinical";
  if (name === "audit_logs") return "mixed-audit-review";
  return "outside-automatic-scope";
}

function isolationPlan(collections) {
  return {
    readyForCutover: false,
    collections: collections.map(name => ({ name, classification: classifyCollection(name) })).sort((a, b) => a.name.localeCompare(b.name)),
    requiredGates: [
      "Dedicated destination projects with deny-by-default rules and reviewed IAM",
      "Verified encrypted backup and independent restore exercise before copying",
      "Firebase Auth migration preserving UIDs, password hashes and providers",
      "Recursive Firestore copy including subcollections, orphan parents, private file chunks and audit history",
      "Preserve ciphertext, encryption salts, wrapped keys, timestamps and document references",
      "Review mixed audit collections and non-prefixed application dependencies",
      "Coordinate web, mobile, backend jobs, webhooks, rules, indexes and authorized domains",
      "Compare source/target counts and integrity checks under a controlled write freeze",
      "Authenticated acceptance tests and rehearsed rollback before switching production"
    ]
  };
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const config = JSON.parse(input);
  const credential = typeof config.serviceAccount === "string" ? JSON.parse(config.serviceAccount) : config.serviceAccount;
  if (!["osextolugar-game", "sextolugar-staging"].includes(credential.project_id)) throw new Error("UNEXPECTED_SOURCE_PROJECT");
  if (credential.private_key) credential.private_key = credential.private_key.replace(/\\n/g, "\n");
  const app = initializeApp({ credential: cert(credential), projectId: credential.project_id });
  try {
    const db = getFirestore(app);
    const collections = await db.listCollections();
    const report = { project: credential.project_id, metadataOnly: true, createdAt: new Date().toISOString(), ...isolationPlan(collections.map(ref => ref.id)) };
    for (const item of report.collections) {
      if (item.classification !== "outside-automatic-scope") {
        item.topLevelDocuments = (await db.collection(item.name).count().get()).data().count;
      }
    }
    report.secondFactorEnrollment = {
      totalProfessionalProfiles: (await db.collection("therapists").count().get()).data().count,
      enrolledProfiles: (await db.collection("therapists").where("twoFactorEnabled", "==", true).count().get()).data().count,
      mandatoryEnrollment: false
    };
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ project: report.project, readyForCutover: false,
      clinicalCollections: report.collections.filter(item => item.classification === "clinical").length,
      mixedCollections: report.collections.filter(item => item.classification === "mixed-audit-review").length,
      secondFactorEnrollment: report.secondFactorEnrollment }));
  } finally { await deleteApp(app); }
}
module.exports = { classifyCollection, isolationPlan };
if (require.main === module) main().catch(() => { console.error("ISOLATION_PREFLIGHT_FAILED; sensitive details omitted"); process.exitCode = 1; });
