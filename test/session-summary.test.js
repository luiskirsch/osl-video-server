"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeSummary } = require("../services/session-summary");

test("resumo clínico normaliza escalas, enums e limites vindos do modelo", () => {
  const normalized = normalizeSummary({
    summary: "ok",
    topics: Array.from({ length: 20 }, (_, i) => ({ title: `T${i}`, summary: "x" })),
    commitments: [{ who: "paciente", what: "retornar" }],
    followups: ["acompanhar"],
    signals: {
      mood: 11,
      anxiety: 8,
      sleepQuality: "5",
      selfEsteem: -1,
      riskLevel: "critical",
      riskFactors: ["fator"],
      notableEvents: [{ title: "evento", category: "categoria-inventada" }],
      keyThemes: ["a", "b", "c", "d", "e"],
    },
  });

  assert.equal(normalized.topics.length, 12);
  assert.equal(normalized.signals.mood, null);
  assert.equal(normalized.signals.anxiety, 8);
  assert.equal(normalized.signals.sleepQuality, null);
  assert.equal(normalized.signals.selfEsteem, null);
  assert.equal(normalized.signals.riskLevel, "none");
  assert.equal(normalized.signals.notableEvents[0].category, "outro");
  assert.equal(normalized.signals.keyThemes.length, 4);
});

test("resumo clínico remove controles e propriedades não previstas", () => {
  const normalized = normalizeSummary({
    summary: "linha\ncom\u0000controle",
    injected: "não persistir",
    signals: { riskLevel: "low", secret: "não persistir" },
  });
  assert.equal(normalized.summary, "linha com controle");
  assert.equal("injected" in normalized, false);
  assert.equal("secret" in normalized.signals, false);
});
