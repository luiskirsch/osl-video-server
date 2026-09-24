"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const therapyRouter = require("../routes/therapy");
const {
  THERAPY_PLAN_EMPRESA_AMOUNT,
  THERAPY_PLAN_EMPRESA_TRIAL_DAYS,
  THERAPY_TRIAL_DAYS_PROFISSIONAL
} = require("../config");

const { evaluatePlanAccess, institutionalTrialStartDate, professionalTrialStartDate } = therapyRouter._test;

test("plano institucional custa R$ 10 e oferece 7 dias", () => {
  assert.equal(THERAPY_PLAN_EMPRESA_AMOUNT, 10);
  assert.equal(THERAPY_PLAN_EMPRESA_TRIAL_DAYS, 7);
});

test("plano institucional exige meio de pagamento autorizado para consultas", () => {
  assert.deepEqual(evaluatePlanAccess({ plano: "empresa" }), {
    ok: false,
    reason: "MEIO_PAGAMENTO_OBRIGATORIO",
    plano: "empresa"
  });
  assert.deepEqual(evaluatePlanAccess({ plano: "empresa", mpPreapprovalStatus: "authorized" }), {
    ok: true,
    plano: "empresa"
  });
});

test("teste institucional agenda a primeira cobrança para 7 dias e não se repete", () => {
  const now = Date.parse("2026-09-23T12:00:00.000Z");
  assert.equal(institutionalTrialStartDate({}, now), "2026-09-30T12:00:00.000Z");
  assert.equal(institutionalTrialStartDate({ empresaTrialUsedAt: now }, now), null);
});

test("plano profissional custa 30 dias grátis e exige meio de pagamento no trial", () => {
  assert.equal(THERAPY_TRIAL_DAYS_PROFISSIONAL, 30);
  assert.deepEqual(evaluatePlanAccess({ plano: "trial", intendedTier: "profissional", trialUntil: Date.now() + 86_400_000 }), {
    ok: false,
    reason: "MEIO_PAGAMENTO_OBRIGATORIO",
    plano: "trial"
  });
  assert.deepEqual(evaluatePlanAccess({ plano: "trial", intendedTier: "profissional", mpPreapprovalStatus: "authorized" }), {
    ok: true,
    plano: "trial"
  });
  assert.deepEqual(evaluatePlanAccess({ plano: "pro" }), { ok: true, plano: "pro" });
});

test("teste profissional agenda a primeira cobrança para 30 dias e não se repete", () => {
  const now = Date.parse("2026-09-24T12:00:00.000Z");
  assert.equal(professionalTrialStartDate({}, now), "2026-10-24T12:00:00.000Z");
  assert.equal(professionalTrialStartDate({ professionalTrialUsedAt: now }, now), null);
});
