"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const therapyRouter = require("../routes/therapy");
const {
  THERAPY_PLAN_EMPRESA_AMOUNT,
  THERAPY_PLAN_EMPRESA_TRIAL_DAYS
} = require("../config");

const { evaluatePlanAccess, institutionalTrialStartDate } = therapyRouter._test;

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

test("regras existentes do plano profissional continuam válidas", () => {
  assert.deepEqual(evaluatePlanAccess({ plano: "pro" }), { ok: true, plano: "pro" });
});
