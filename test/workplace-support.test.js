"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const s = require("../services/workplace-support");
const secret = "support-test-secret-at-least-32-characters";
const body = { requestId: "08138b1d-c762-4f14-a7e2-2563c511d6fe", companyId: "acme", category: "overload", recipient: "care",
  text: "Uma situação particular que preciso compartilhar.", need: "Ajuda para organizar uma conversa", consent: true, aggregateConsent: false };
function item() { return s.createItem("uid", "case", s.normalizeRequest(body), { ...s.DEFAULT_CONFIG, enabled: true, careEnabled: true,
  careOwnerName: "Equipe", contact: "Contato" }, { name: "Ana", email: "ana@example.test" }, 100000); }

test("support encrypts narrative and verifies all access-control metadata", () => {
  const value = item();
  const record = s.seal(value, secret);
  assert.ok(!JSON.stringify(record).includes(value.text));
  assert.ok(!JSON.stringify(record).includes(value.employeeEmail));
  assert.deepEqual(s.open("case", record, secret), value);
  for (const field of ["ownerKey", "companyId", "recipient", "createdAt", "companyInboxKey", "careInboxKey"]) {
    assert.throws(() => s.open("case", { ...record, [field]: "tampered" }, secret));
  }
  assert.throws(() => s.open("different-case", record, secret));
  assert.throws(() => s.open("case", record, "a-different-encryption-secret"));
  assert.equal(s.view(value).ownerKey, undefined);
  assert.equal(s.view(value).requestFingerprint, undefined);
});
test("support requires explicit sharing, valid category and bounded narrative", () => {
  for (const patch of [{ consent: false }, { aggregateConsent: undefined }, { text: "" }, { text: "a".repeat(6001) },
    { recipient: "anyone" }, { category: "diagnosis" }, { requestId: "../../" }, { companyId: "../acme" }]) {
    assert.throws(() => s.normalizeRequest({ ...body, ...patch }));
  }
  assert.throws(() => s.createItem("uid", "case", s.normalizeRequest(body), s.DEFAULT_CONFIG, {}), /CAMINHO_INDISPONIVEL/);
  // "O que ajudaria" is optional in the form.
  assert.equal(s.normalizeRequest({ ...body, need: "" }).need, "");
  assert.equal(s.normalizeRequest({ ...body, need: undefined }).need, "");
  assert.throws(() => s.normalizeRequest({ ...body, need: "a".repeat(1001) }), /TEXTO_INVALIDO/);
});
test("team updates may resave the current stage and take over an open request", () => {
  const initial = item();
  const assigned = s.mutate(initial, "company", "update", { version: 1, status: "open", ownerName: "Equipe Pessoas", nextStep: "Vamos conversar amanhã." }, 200000);
  assert.equal(assigned.status, "in_progress");
  const resolved = s.mutate(assigned, "company", "update", { version: 2, status: "resolved", nextStep: "Confirme se ajudou." }, 210000);
  const resaved = s.mutate(resolved, "company", "update", { version: 3, status: "resolved", ownerName: "Equipe RH" }, 220000);
  assert.equal(resaved.status, "resolved");
  assert.equal(resaved.ownerName, "Equipe RH");
  assert.throws(() => s.mutate(resaved, "company", "update", { version: 4, status: "open" }), /ESTADO_INVALIDO/);
});
test("only staffed and identified routes can be enabled; company cannot activate care", () => {
  assert.throws(() => s.normalizeConfig({ enabled: true, companyEnabled: true, companyOwnerName: "Equipe" }), /CONTATO_OBRIGATORIO/);
  assert.throws(() => s.normalizeConfig({ enabled: true, companyEnabled: true, contact: "Canal" }), /RESPONSAVEL_OBRIGATORIO/);
  assert.throws(() => s.normalizeConfig({ careEnabled: true }), /ACOLHIMENTO_CONFIGURADO_PELA_EQUIPE/);
  const config = s.normalizeConfig({ enabled: true, careEnabled: true, careOwnerName: "Equipe", contact: "Canal" }, undefined, true);
  assert.equal(config.enabled, true);
  assert.throws(() => s.normalizeConfig({ responseHours: 169 }), /PRAZO_INVALIDO/);
});
test("support enforces concurrency, employee-owned closure, feedback continuation and terminal states", () => {
  const initial = item();
  assert.throws(() => s.mutate(initial, "care", "message", { version: 0, text: "Olá" }), /VERSAO_DESATUALIZADA/);
  assert.throws(() => s.mutate(initial, "care", "update", { version: 1, status: "closed" }), /ESTADO_INVALIDO/);
  assert.throws(() => s.mutate(initial, "care", "update", { version: 1, status: "resolved" }), /PROXIMO_PASSO_OBRIGATORIO/);
  const responded = s.mutate(initial, "care", "message", { version: 1, text: "Vamos conversar sobre isso." }, 200000);
  assert.equal(responded.firstResponseAt, 200000);
  assert.equal(responded.status, "in_progress");
  const resolved = s.mutate(responded, "care", "update", { version: 2, status: "resolved", nextStep: "Confirme se ajudou." }, 210000);
  const continued = s.mutate(resolved, "employee", "feedback", { version: 3, outcome: "continues", text: "Preciso de mais apoio" }, 220000);
  assert.equal(continued.status, "in_progress");
  assert.equal(continued.dueAt, 220000 + 48 * 3600000);
  const closed = s.mutate(continued, "employee", "feedback", { version: 4, outcome: "helped" }, 230000);
  assert.equal(closed.status, "closed");
  assert.equal(closed.events.length, 5);
  assert.throws(() => s.mutate(closed, "care", "message", { version: 5, text: "Mensagem" }), /PEDIDO_ENCERRADO/);
  assert.equal(initial.version, 1);
});
test("summaries protect small distinct-person cohorts, complementary categories and care subtraction", () => {
  const period = { start: 1, end: 1000, period: "2026-09" };
  const rows = Array.from({ length: 10 }, (_, i) => ({ ownerKey: `person${i}`, createdAt: 100,
    category: "overload", aggregateConsent: true, recipient: "company" }));
  assert.equal(s.aggregate(rows.slice(0, 9), period).suppressed, true);
  assert.equal(s.aggregate(rows.map(r => ({ ...r, ownerKey: "one" })), period).suppressed, true);
  const summary = s.aggregate(rows, period);
  assert.equal(summary.total, 10);
  assert.equal(summary.categories[0].count, 10);
  assert.equal(s.aggregate([...rows, { ...rows[0], ownerKey: "careOne", recipient: "care" }], period).suppressed, true);
  const mixed = s.aggregate([...rows, { ...rows[0], ownerKey: "another", category: "personal" }], period);
  assert.equal(mixed.categoriesSuppressed, true);
  assert.deepEqual(mixed.categories, []);
  const withExcluded = s.aggregate([...rows, { ...rows[0], aggregateConsent: false }, { ...rows[0], createdAt: 2000 }], period);
  assert.equal(withExcluded.total, 10);
  const responded = rows.map(r => ({ ...r, firstResponseAt: 200 }));
  assert.equal(s.aggregate([...responded, { ...rows[0], ownerKey: "pending" }], period).averageResponseHours, null);
  const care = rows.map((r, i) => ({ ...r, recipient: "care", ownerKey: `care${i}`, category: i === 0 ? "personal" : "overload" }));
  const knownCorporate = [...rows, ...rows.map(r => ({ ...r, category: "personal" }))];
  const subtraction = s.aggregate([...knownCorporate, ...care], period);
  assert.equal(subtraction.suppressed, false);
  assert.equal(subtraction.categoriesSuppressed, true);
  assert.ok(!JSON.stringify(summary).includes("person0"));
});
test("closed month follows São Paulo business calendar including January rollover", () => {
  assert.equal(s.closedPeriod(Date.parse("2026-10-01T02:59:59Z")).period, "2026-08");
  assert.equal(s.closedPeriod(Date.parse("2026-10-01T03:00:00Z")).period, "2026-09");
  assert.equal(s.closedPeriod(Date.parse("2026-01-22T12:00:00Z")).period, "2025-12");
});
