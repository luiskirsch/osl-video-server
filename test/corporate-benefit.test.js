"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  benefitMonth, usageDocumentId, activeCoveredEntries,
  requiresActiveBenefitAtApproval, calculateExtraQuote, validPricingConfig
} = require("../services/corporate-benefit");

test("mês do benefício usa horário de São Paulo na virada", () => {
  assert.equal(benefitMonth(Date.parse("2026-10-01T02:59:59Z")), "2026-09");
  assert.equal(benefitMonth(Date.parse("2026-10-01T03:00:00Z")), "2026-10");
});

test("documento de uso identifica empresa, colaborador e mês", () => {
  assert.equal(usageDocumentId("campi", "employee_1", "2026-09"), "campi_employee_1_2026-09");
  assert.throws(() => usageDocumentId("../../a", "b", "2026-09"));
});

test("reservas pendentes expiradas não consomem o saldo", () => {
  const entries = {
    old: { status: "pending", expiresAt: 99 },
    current: { status: "pending", expiresAt: 101 },
    approved: { status: "approved", expiresAt: null },
    canceled: { status: "canceled", expiresAt: null }
  };
  assert.deepEqual(Object.keys(activeCoveredEntries(entries, 100)), ["current", "approved"]);
});

test("extra pago continua atendível se a empresa desativar o benefício", () => {
  assert.equal(requiresActiveBenefitAtApproval({ mode: "covered" }), true);
  assert.equal(requiresActiveBenefitAtApproval({ mode: "extra" }), false);
  assert.equal(requiresActiveBenefitAtApproval(null), false);
});

test("preço extra exige todos os parâmetros homologados; não embute CPP nem taxa presumida", () => {
  const cfg = {
    version: "campi-2026-01", approved: true, netPsychologistCents: 6000,
    workerWithholdingRate: 0.11, employerContributionRate: 0,
    simplesEffectiveRate: 0.06, gatewayPercentRate: 0.0099,
    gatewayFixedCents: 0, otherFixedCents: 0
  };
  assert.equal(validPricingConfig(cfg), true);
  const quote = calculateExtraQuote(cfg);
  assert.equal(quote.available, true);
  assert.equal(quote.breakdown.grossRpaCents, 6742);
  assert.equal(quote.totalCents, 7249);
  assert.equal(calculateExtraQuote({ ...cfg, simplesEffectiveRate: 0.155 }).totalCents, 8074);
  assert.equal(calculateExtraQuote({ ...cfg, approved: false }), null);
  assert.equal(calculateExtraQuote({ ...cfg, gatewayPercentRate: undefined }), null);
  assert.equal(validPricingConfig({ ...cfg, simplesEffectiveRate: 1 }), false);
});

const {
  benefitPolicy, poolDecision, inContinuity, poolAlertDue, previousBenefitMonth, poolUsageDocumentId
} = require("../services/corporate-benefit");

const pool50 = benefitPolicy({ benefitModel: "pool", benefitPool: { monthlySessions: 50 } });
const fill = (n, employeeId = e => `e${e}`) => Object.fromEntries(
  Array.from({ length: n }, (_, i) => [`r${i}`, { status: "approved", employeeId: employeeId(i) }]));

test("pool policy defaults to 4 per employee and reserves 20% for continuity", () => {
  assert.deepEqual(pool50, { model: "pool", poolSize: 50, perEmployeeMax: 4, continuityReserve: 10 });
  assert.equal(benefitPolicy({}).model, "per_employee");
  assert.equal(benefitPolicy({ benefitModel: "pool", benefitPool: { monthlySessions: 0 } }).model, "per_employee");
});

test("new employees stop at the continuity reserve; ongoing ones use the full pool", () => {
  const entries = fill(40);
  assert.equal(poolDecision(pool50, entries, "new", false).reason, "BANCO_ESGOTADO");
  const ok = poolDecision(pool50, entries, "ongoing", true);
  assert.equal(ok.covered, true);
  assert.equal(ok.remaining, 9);
  assert.equal(poolDecision(pool50, fill(50), "ongoing", true).reason, "BANCO_ESGOTADO");
});

test("no employee takes more than the personal cap", () => {
  const entries = fill(4, () => "same");
  assert.equal(poolDecision(pool50, entries, "same", true).reason, "LIMITE_PESSOAL_DO_BANCO");
  assert.equal(poolDecision(pool50, entries, "other", false).covered, true);
});

test("continuity comes from approved or completed sessions this or last month", () => {
  assert.equal(inContinuity("a", {}, { x: { employeeId: "a", status: "completed" } }), true);
  assert.equal(inContinuity("a", { x: { employeeId: "a", status: "pending" } }), false);
});

test("80% alert fires once and month helpers are stable", () => {
  assert.equal(poolAlertDue(pool50, 40, false), true);
  assert.equal(poolAlertDue(pool50, 40, true), false);
  assert.equal(poolAlertDue(pool50, 39, false), false);
  assert.equal(previousBenefitMonth("2026-01"), "2025-12");
  assert.equal(poolUsageDocumentId("acme", "2026-10"), "acme_pool_2026-10");
});

const { urgentEntriesFor, URGENT_MAX_PER_EMPLOYEE_MONTH } = require("../services/corporate-benefit");

test("urgent sessions never count against the franchise or the pool", () => {
  const entries = {
    a: { status: "approved", employeeId: "e1" },
    u1: { status: "approved", employeeId: "e1", urgent: true },
    u2: { status: "pending", employeeId: "e1", urgent: true, expiresAt: Date.now() + 60000 }
  };
  assert.deepEqual(Object.keys(activeCoveredEntries(entries)), ["a"]);
  assert.equal(urgentEntriesFor(entries, "e1"), 2);
  assert.equal(urgentEntriesFor(entries, "e1", "u2"), 1);
  assert.equal(URGENT_MAX_PER_EMPLOYEE_MONTH, 2);
});
