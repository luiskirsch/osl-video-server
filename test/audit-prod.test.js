"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluate } = require("../scripts/audit-prod");

const EXC = {
  "GHSA-aaaa-bbbb-cccc": { package: "lib-a", reviewBy: "2027-01-11", reason: "trecho vulnerável não é usado" },
};
const report = (pkg, id, fixAvailable, severity = "high") => ({
  vulnerabilities: {
    [pkg]: {
      severity,
      fixAvailable,
      via: [{ severity, title: "falha", url: `https://github.com/advisories/${id}` }],
    },
  },
});

test("exceção aceita advisory sem correção dentro do prazo", () => {
  const r = evaluate(report("lib-a", "GHSA-aaaa-bbbb-cccc", false), EXC, "2026-10-11");
  assert.equal(r.failures.length, 0);
  assert.equal(r.accepted.length, 1);
});

test("exceção deixa de valer quando sai correção", () => {
  const r = evaluate(report("lib-a", "GHSA-aaaa-bbbb-cccc", true), EXC, "2026-10-11");
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0].why, /correção/);
});

test("exceção deixa de valer depois da data de revisão", () => {
  const r = evaluate(report("lib-a", "GHSA-aaaa-bbbb-cccc", false), EXC, "2027-01-12");
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0].why, /vencida/);
});

test("advisory sem exceção ou de outro pacote falha", () => {
  assert.equal(evaluate(report("lib-b", "GHSA-zzzz-zzzz-zzzz", false), EXC, "2026-10-11").failures.length, 1);
  assert.equal(evaluate(report("lib-b", "GHSA-aaaa-bbbb-cccc", false), EXC, "2026-10-11").failures.length, 1);
});

test("moderate e low não bloqueiam; exceção sem uso vira aviso", () => {
  const r = evaluate(report("lib-c", "GHSA-yyyy-yyyy-yyyy", false, "moderate"), EXC, "2026-10-11");
  assert.equal(r.failures.length, 0);
  assert.deepEqual(r.unusedExceptions, ["GHSA-aaaa-bbbb-cccc"]);
});
