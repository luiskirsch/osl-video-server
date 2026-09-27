"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const eligibility = require("../services/corporate-eligibility");

test("vinculo, beneficio e escopo NR-1 permanecem independentes", () => {
  assert.deepEqual(eligibility.publicEligibility({
    employmentType: "PJ", benefitEligible: true, nr1Scope: "technical_review"
  }), { employmentType: "pj", benefitEligible: true, nr1Scope: "technical_review" });
  assert.deepEqual(eligibility.publicEligibility({
    employmentType: "clt", benefitEligible: false, nr1Scope: true
  }), { employmentType: "clt", benefitEligible: false, nr1Scope: "included" });
});

test("valores desconhecidos nao viram classificacao juridica por inferencia", () => {
  assert.equal(eligibility.normalizeEmploymentType("freela"), null);
  assert.equal(eligibility.normalizeNr1Scope(undefined), "technical_review");
});
