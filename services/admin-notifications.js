"use strict";
const support = require("./workplace-support");
// These are actionable queues, not counts of everyone ever registered.
const QUEUES = {
  crpCrm: ["therapy_verifications", "status", "pending"],
  estudante: ["therapists", "plano", "student-pending-review"],
  recemFormado: ["therapists", "recemFormadoDoc.decision", "pending-review"],
  semConselho: ["therapists", "formacaoDoc.decision", "pending-review"],
  leadsEstudante: ["therapy_student_leads", "status", "new"],
  empresa: ["therapists", "plano", "empresa-pending-review"],
  empresas: ["therapy_institution_leads", "status", "new"],
  denuncias: ["therapy_message_reports", "status", "open"],
  colaboradores: ["therapy_colaboradores", "status", "pendente"],
  repasses: ["therapy_payouts", "status", ["pending", "failed"]],
  reembolsos: ["therapy_payment_refund_tasks", "status", "review_required"],
  nr1: ["nr1_campaigns", "status", "closed"],
  estudantes: ["therapy_student_cases", "status", ["pending_triage", "waiting_assignment", "referral_required"]],
};
function needsAttention(item) {
  if (["closed", "cancelled", "resolved", "waiting_employee"].includes(item.status)) return false;
  if (item.status === "open" || !item.firstResponseAt) return true;
  const latest = [...(item.events || [])].reverse().find(e => ["message", "feedback", "update"].includes(e.type));
  return latest?.actor === "employee";
}
async function counts(db, secret) {
  const result = {};
  await Promise.all(Object.entries(QUEUES).map(async ([key, [collection, field, value]]) => {
    try {
      const query = db.collection(collection).where(field, Array.isArray(value) ? "in" : "==", value);
      result[key] = { count: (await query.count().get()).data().count };
    } catch { result[key] = { error: true }; }
  }));
  try {
    const snap = await db.collection(support.COLLECTION).where("recipient", "==", "care").limit(5001).get();
    if (snap.docs.length > 5000) throw new Error("queue requires indexing");
    const items = snap.docs.map(doc => support.open(doc.id, doc.data(), secret));
    result.apoio = { count: items.filter(needsAttention).length };
  } catch { result.apoio = { error: true }; }
  return result;
}
module.exports = { QUEUES, needsAttention, counts };
