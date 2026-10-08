"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isDirectoryEligibleFor, isPayingProfessional } = require("../services/public-directory");

test("the curated program network is what students and employees see", () => {
  const inNetwork = { verificationStatus: "verified", adminDirectoryVisible: true, plano: "empresa", mpPreapprovalStatus: "pending" };
  assert.equal(isDirectoryEligibleFor("programa", inNetwork), true);
  assert.equal(isDirectoryEligibleFor("pacientes", inNetwork), false);
});

test("paying professionals outside the network appear only for private patients", () => {
  const paying = { verificationStatus: "verified", adminDirectoryBlocked: true, plano: "empresa", mpPreapprovalStatus: "pending" };
  assert.equal(isDirectoryEligibleFor("pacientes", paying), true);
  assert.equal(isDirectoryEligibleFor("programa", paying), false);
});

test("patients never see unverified, non-paying or patient-hidden professionals", () => {
  const base = { verificationStatus: "verified", adminDirectoryBlocked: true, mpPreapprovalStatus: "authorized" };
  assert.equal(isDirectoryEligibleFor("pacientes", { ...base, verificationStatus: "pending-review" }), false);
  assert.equal(isDirectoryEligibleFor("pacientes", { ...base, mpPreapprovalStatus: "cancelled", plano: "trial" }), false);
  assert.equal(isDirectoryEligibleFor("pacientes", { ...base, adminPatientDirectoryHidden: true }), false);
});

test("paying is defined by an active subscription, pro plan or admin courtesy", () => {
  const now = Date.now();
  assert.equal(isPayingProfessional({ plano: "trial", mpPreapprovalStatus: "pending" }, now), true);
  assert.equal(isPayingProfessional({ plano: "trial" }, now), false);
  assert.equal(isPayingProfessional({ plano: "student-active" }, now), false);
  assert.equal(isPayingProfessional({ plano: "canceled", adminGrantedUntil: now + 1000 }, now), true);
});
