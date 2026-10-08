"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isDirectoryEligibleFor, isPayingProfessional } = require("../services/public-directory");

const base = { verificationStatus: "verified", adminDirectoryVisible: true };

test("program professionals only appear for students and employees", () => {
  const program = { ...base, plano: "empresa" };
  assert.equal(isDirectoryEligibleFor("programa", program), true);
  assert.equal(isDirectoryEligibleFor("pacientes", program), false);
});

test("paying professionals only appear for private patients", () => {
  const pro = { ...base, plano: "pro" };
  assert.equal(isDirectoryEligibleFor("pacientes", pro), true);
  assert.equal(isDirectoryEligibleFor("programa", pro), false);
});

test("paying means pro, active admin courtesy, or trial with card registered", () => {
  const now = Date.now();
  assert.equal(isPayingProfessional({ plano: "trial", mpPreapprovalStatus: "pending" }, now), true);
  assert.equal(isPayingProfessional({ plano: "trial" }, now), false);
  assert.equal(isPayingProfessional({ plano: "student-active" }, now), false);
  assert.equal(isPayingProfessional({ plano: "canceled", adminGrantedUntil: now + 1000 }, now), true);
  assert.equal(isPayingProfessional({ plano: "empresa", adminGrantedUntil: now + 1000 }, now), false);
});

test("unverified or admin-hidden professionals stay out of both directories", () => {
  assert.equal(isDirectoryEligibleFor("pacientes", { plano: "pro", verificationStatus: "pending-review", adminDirectoryVisible: true }), false);
  assert.equal(isDirectoryEligibleFor("pacientes", { plano: "pro", verificationStatus: "verified", adminDirectoryVisible: false }), false);
});
