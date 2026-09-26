"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCorporateDashboard, calendarMonthBounds } = require("../services/corporate-dashboard");

function document(id, data) {
  return { id, data: () => data };
}

function fakeCollection(docs) {
  const ordered = docs.slice().sort((a, b) => a.id.localeCompare(b.id));
  return {
    where(field, operator, value) {
      assert.equal(field, "empresaId");
      assert.equal(operator, "==");
      return {
        orderBy(name) {
          assert.equal(name, "__name__");
          return {
            limit(size) {
              let cursor = null;
              return {
                select() { return this; },
                startAfter(doc) { cursor = doc.id; return this; },
                async get() {
                  return {
                    docs: ordered.filter(doc => doc.data().empresaId === value &&
                      (!cursor || doc.id > cursor)).slice(0, size)
                  };
                }
              };
            }
          };
        }
      };
    }
  };
}

function fakeDb(collaborators, sessions) {
  return {
    collection(name) {
      if (name === "therapy_colaboradores") return fakeCollection(collaborators);
      if (name === "therapy_sessions") return fakeCollection(sessions);
      throw new Error(`unexpected collection ${name}`);
    }
  };
}

const company = { nome: "Projeto Campi", segmento: "saúde" };
const septemberNow = Date.UTC(2026, 8, 25, 16);
const septemberSession = Date.UTC(2026, 8, 15, 16);

function collaborator(index, empresaId = "campi") {
  return document(`colab-${String(index).padStart(3, "0")}`, {
    empresaId, status: "ativo", email: `pessoa${index}@example.invalid`
  });
}

function session(index, collaboratorIndex, scheduledAt = septemberSession, extra = {}) {
  return document(`sess-${String(index).padStart(3, "0")}`, {
    empresaId: "campi",
    colaboradorId: `colab-${String(collaboratorIndex).padStart(3, "0")}`,
    status: "completed",
    scheduledAt,
    especialidade: "Psicologia",
    ...extra
  });
}

test("uses calendar month in São Paulo, not a rolling 30-day interval", () => {
  const before = calendarMonthBounds(Date.UTC(2026, 8, 1, 2, 59));
  const after = calendarMonthBounds(Date.UTC(2026, 8, 1, 3, 0));
  assert.equal(before.period, "2026-08");
  assert.equal(after.period, "2026-09");
  assert.equal(before.end, after.start);
  assert.equal(after.start, Date.UTC(2026, 8, 1, 3));
});

test("includes all 275 collaborators and sessions after the first page", async () => {
  const collaborators = Array.from({ length: 275 }, (_, i) => collaborator(i));
  const sessions = [
    ...Array.from({ length: 250 }, (_, i) => session(i, i)),
    ...Array.from({ length: 25 }, (_, i) => session(i + 250, i + 250)),
    session(276, 0, Date.UTC(2026, 7, 31, 2, 59)),
    session(277, 0, Date.UTC(2026, 9, 1, 3, 0))
  ];
  const result = await buildCorporateDashboard(fakeDb(collaborators, sessions), "campi", company, septemberNow);
  assert.equal(result.kpis.totalCadastrados, 275);
  assert.equal(result.kpis.totalAtivos, 275);
  assert.equal(result.kpis.sessoesMes, 275);
  assert.equal(result.kpis.sessoesTotal, 277);
  assert.equal(result.kpis.taxaAdesao, 100);
  assert.equal(result.especialidades.Psicologia, 275);
  assert.equal(result.periodo, "2026-09");
  assert.equal(result.mascarado, false);
  assert.equal(JSON.stringify(result).includes("example.invalid"), false);
});

test("suppresses clinical activity based on distinct patients, not session volume", async () => {
  const collaborators = Array.from({ length: 200 }, (_, i) => collaborator(i));
  const sessions = Array.from({ length: 12 }, (_, i) => session(i, 0));
  const result = await buildCorporateDashboard(fakeDb(collaborators, sessions), "campi", company, septemberNow);
  assert.equal(result.kpis.totalAtivos, 200);
  assert.equal(result.kpis.sessoesMes, null);
  assert.equal(result.kpis.sessoesTotal, null);
  assert.equal(result.kpis.taxaAdesao, null);
  assert.deepEqual(result.especialidades, {});
  assert.equal(result.mascarado, true);
});

test("hides entire specialty breakdown when any specialty has a small cell", async () => {
  const collaborators = Array.from({ length: 20 }, (_, i) => collaborator(i));
  const sessions = [
    ...Array.from({ length: 5 }, (_, i) => session(i, i)),
    session(6, 6, septemberSession, { especialidade: "Outra" })
  ];
  const result = await buildCorporateDashboard(fakeDb(collaborators, sessions), "campi", company, septemberNow);
  assert.equal(result.kpis.sessoesMes, null);
  assert.deepEqual(result.especialidades, {});
  assert.equal(result.mascarado, true);
});

test("incomplete attribution cannot silently become a published corporate metric", async () => {
  const collaborators = Array.from({ length: 10 }, (_, i) => collaborator(i));
  const sessions = [
    ...Array.from({ length: 5 }, (_, i) => session(i, i)),
    session(6, 6, septemberSession, { colaboradorId: null })
  ];
  const result = await buildCorporateDashboard(fakeDb(collaborators, sessions), "campi", company, septemberNow);
  assert.equal(result.dadosIncompletos, true);
  assert.equal(result.kpis.sessoesMes, null);
  assert.equal(result.kpis.sessoesTotal, null);
  assert.equal(result.kpis.taxaAdesao, null);
  assert.deepEqual(result.especialidades, {});
});

test("empty clinical cohort reports zero without inventing a patient", async () => {
  const collaborators = Array.from({ length: 10 }, (_, i) => collaborator(i));
  const result = await buildCorporateDashboard(fakeDb(collaborators, []), "campi", company, septemberNow);
  assert.equal(result.kpis.sessoesMes, 0);
  assert.equal(result.kpis.sessoesTotal, 0);
  assert.equal(result.kpis.taxaAdesao, 0);
  assert.equal(result.mascarado, false);
});
