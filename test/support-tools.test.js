"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSupportTools, _test } = require("../services/support-tools");

// 2026-09-30 13:00 em São Paulo (16:00 UTC)
const NOW = Date.UTC(2026, 8, 30, 16, 0);
const HOUR = 60 * 60 * 1000;

function fakeDb(sessions) {
  const queries = [];
  return {
    queries,
    collection(name) {
      return {
        where(field, op, value) {
          queries.push({ name, field, op, value });
          return {
            limit() {
              return { async get() { return { docs: sessions.filter(s => s.therapistUid === value).map(s => ({ data: () => s })) }; } };
            }
          };
        }
      };
    }
  };
}

function tools(overrides = {}) {
  return createSupportTools({
    uid: "prof_1",
    db: fakeDb(overrides.sessions || []),
    loadTherapist: async () => overrides.therapist || null,
    evaluatePlanAccess: overrides.evaluatePlanAccess || (() => ({ ok: true, plano: "pro" })),
    fetchImpl: overrides.fetchImpl,
    now: () => NOW,
    changelogCache: { at: 0, value: null }
  });
}

test("início do dia usa o fuso de São Paulo", () => {
  assert.equal(_test.startOfTodaySaoPaulo(NOW), Date.UTC(2026, 8, 30, 3, 0));
  // 23:30 em SP ainda é o mesmo dia, embora já seja dia seguinte em UTC
  assert.equal(_test.startOfTodaySaoPaulo(Date.UTC(2026, 9, 1, 2, 30)), Date.UTC(2026, 8, 30, 3, 0));
});

test("agenda traz só o período pedido, da própria conta, com nome abreviado", async () => {
  const sessions = [
    { therapistUid: "prof_1", patientName: "Maria da Silva Souza", status: "scheduled", scheduledAt: NOW + 2 * HOUR, durationMinutes: 50 },
    { therapistUid: "prof_1", patientName: "João", status: "completed", scheduledAt: NOW - 30 * HOUR },
    { therapistUid: "prof_1", patientName: "Fora do período", status: "scheduled", scheduledAt: NOW + 10 * 24 * HOUR },
    { therapistUid: "prof_1", patientName: "Teste", status: "scheduled", scheduledAt: NOW + HOUR, syntheticData: true },
    { therapistUid: "outro", patientName: "Paciente de outro profissional", status: "scheduled", scheduledAt: NOW + HOUR }
  ];
  const t = tools({ sessions });
  const hoje = JSON.parse((await t.run("ver_agenda", { dias_futuros: 0, dias_passados: 0 })).content);
  assert.equal(hoje.total, 1);
  assert.equal(hoje.sessoes[0].paciente, "Maria S.");
  assert.equal(hoje.sessoes[0].status, "agendada");
  assert.equal(hoje.sessoes[0].duracaoMin, 50);
  assert.match(hoje.sessoes[0].quando, /30\/09.*15:00/);

  const comPassado = JSON.parse((await t.run("ver_agenda", { dias_futuros: 0, dias_passados: 2 })).content);
  assert.deepEqual(comPassado.sessoes.map(s => s.paciente), ["João", "Maria S."]);
  assert.ok(!JSON.stringify(comPassado).includes("outro profissional"));
});

test("a ferramenta consulta sempre o uid da rota, nunca um uid vindo do modelo", async () => {
  const db = fakeDb([]);
  const t = createSupportTools({ uid: "prof_1", db, loadTherapist: async () => null, evaluatePlanAccess: () => ({}), now: () => NOW });
  await t.run("ver_agenda", { dias_futuros: 1, dias_passados: 0, uid: "prof_2" });
  assert.deepEqual(db.queries.map(q => q.value), ["prof_1"]);
});

test("status da conta lista pendências sem expor segredos", async () => {
  const t = tools({
    therapist: { verificationStatus: "pending", especialidade: "Psicologia", asaasApiKey: "segredo-asaas", twoFactorEnabled: true, aiSummaryEnabled: true },
    evaluatePlanAccess: () => ({ ok: false, plano: "trial", reason: "TRIAL_EXPIRADO", trialUntil: NOW - 24 * HOUR })
  });
  const status = JSON.parse((await t.run("ver_status_da_conta", {})).content);
  assert.equal(status.plano, "Teste");
  assert.equal(status.consultasLiberadas, false);
  assert.match(status.motivoDoBloqueio, /teste terminou/);
  assert.equal(status.seloVerificado, false);
  assert.deepEqual(status.perfilFaltando, ["foto", "apresentação (bio)", "cidade do consultório"]);
  assert.equal(status.integracoes.cobrancaAsaas, true);
  assert.ok(!JSON.stringify(status).includes("segredo-asaas"));
});

test("novidades filtram commits internos e de segurança e ficam em cache", async () => {
  let calls = 0;
  const commits = [
    { commit: { message: "feat(home): card com clima local\n\ndetalhes", author: { date: "2026-09-28T02:00:00Z" } } },
    { commit: { message: "test(portal): estabiliza teste", author: { date: "2026-09-28T01:00:00Z" } } },
    { commit: { message: "fix(xss): escapa diretório", author: { date: "2026-09-27T01:00:00Z" } } },
    { commit: { message: "Reorganiza indicador de gravacao na topbar", author: { date: "2026-09-29T22:00:00Z" } } }
  ];
  const t = tools({ fetchImpl: async () => { calls++; return { ok: true, json: async () => commits }; } });
  const first = JSON.parse((await t.run("ver_novidades", {})).content);
  assert.deepEqual(first.itens.map(i => i.mudanca), ["feat(home): card com clima local", "Reorganiza indicador de gravacao na topbar"]);
  await t.run("ver_novidades", {});
  assert.equal(calls, 1, "segunda chamada vem do cache");
});

test("falha de ferramenta volta como erro para o modelo, sem derrubar a conversa", async () => {
  const t = tools({ fetchImpl: async () => ({ ok: false, status: 403 }) });
  const result = await t.run("ver_novidades", {});
  assert.equal(result.isError, true);
  assert.match(result.content, /não chute|sem inventar/i);
  assert.equal((await t.run("apagar_tudo", {})).isError, true);
});
