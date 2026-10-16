"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { isolationPlan, classifyCollection } = require("../scripts/security/clinical-isolation-preflight");

test("isolation inventory includes patient identities, notes, private files and future clinical collections", () => {
  for (const name of ["therapists", "therapy_patient_accounts", "therapy_notes", "therapy_future_feature", "private_files", "attendance_certificates", "nr1_participants"]) {
    assert.equal(classifyCollection(name), "clinical");
  }
  assert.equal(classifyCollection("audit_logs"), "mixed-audit-review");
  for (const name of ["users", "salas", "config", "unknown_dependency"]) assert.equal(classifyCollection(name), "outside-automatic-scope");
  const plan = isolationPlan(["private_files", "therapy_notes", "users", "audit_logs"]);
  assert.equal(plan.readyForCutover, false);
  assert.equal(plan.collections.length, 4);
  assert.ok(plan.requiredGates.some(gate => /subcollections/.test(gate)));
  assert.ok(plan.requiredGates.some(gate => /preserving UIDs/.test(gate)));
  assert.ok(plan.requiredGates.some(gate => /rollback/.test(gate)));
});
