"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const therapyRouter = require("../routes/therapy");
const {
  THERAPY_TRIAL_DAYS_PROFISSIONAL
} = require("../config");

const { evaluatePlanAccess, mpPreapprovalErrorInfo, professionalTrialStartDate } = therapyRouter._test;

test("plano institucional libera consultas sem cobrar o profissional", () => {
  assert.deepEqual(evaluatePlanAccess({ plano: "empresa" }), {
    ok: true,
    plano: "empresa"
  });
  assert.deepEqual(evaluatePlanAccess({ plano: "empresa", mpPreapprovalStatus: "authorized" }), {
    ok: true,
    plano: "empresa"
  });
});

test("falha do Mercado Pago preserva diagnóstico sem expor e-mail ou credencial", () => {
  assert.deepEqual(mpPreapprovalErrorInfo({ status: 400 }, {
    message: "Invalid request",
    cause: [{ code: "PA-123", description: "payer test@example.com Bearer APP_USR-secret is invalid" }]
  }), {
    detail: "payer [e-mail] Bearer [oculto] is invalid",
    providerStatus: 400,
    providerCode: "PA-123"
  });
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
