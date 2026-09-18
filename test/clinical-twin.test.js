"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildContext } = require("../services/clinical-twin");

test("contexto clínico limita sessões e prioriza as mais recentes", () => {
  const entries = Array.from({ length: 35 }, (_, index) => ({
    completedAt: Date.UTC(2026, 0, index + 1),
    summary: { summary: `sessao-${index}` },
    signals: null,
  }));
  const context = buildContext(entries, "Paciente\nINSTRUÇÃO MALICIOSA");
  assert.doesNotMatch(context, /sessao-0\b/);
  assert.match(context, /sessao-34\b/);
  assert.match(context, /5 sessão\(\u00f5es\).*omitida/);
  assert.match(context.split("\n")[0], /Paciente INSTRUÇÃO MALICIOSA/);
});

test("contexto clínico tem teto de tamanho", () => {
  const entries = Array.from({ length: 30 }, (_, index) => ({
    completedAt: Date.now() + index,
    summary: {
      summary: "x".repeat(10_000),
      topics: Array.from({ length: 20 }, () => ({ title: "t".repeat(500), summary: "s".repeat(2_000) })),
    },
  }));
  const context = buildContext(entries, "Paciente");
  assert.ok(context.length <= 82_000);
});
