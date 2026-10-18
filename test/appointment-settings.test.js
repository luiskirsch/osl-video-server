"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const settings = require("../services/appointment-settings");
const state = require("../services/therapy-session-state");

test("initial, return and follow-up use distinct configurable durations without changing existing sessions", () => {
  assert.equal(settings.appointmentDuration({}, "initial"), 30);
  assert.equal(settings.appointmentDuration({}, "return"), 20);
  assert.equal(settings.appointmentDuration({}, "follow_up"), 20);
  const config = { slotMinutes: 50, appointmentDurations: { initial: 45, return: 25 } };
  assert.equal(settings.appointmentDuration(config), 50);
  assert.equal(settings.appointmentDuration(config, "initial"), 45);
  assert.equal(settings.appointmentDuration(config, "return", 20), 20);
  assert.equal(state.therapySessionDurationMinutes({ durationMinutes: 90 }), 90);
  for (const invalid of [null, "20", 0, -20, 14, 241, NaN, Infinity, 20.5]) {
    assert.throws(() => settings.appointmentDuration(config, "initial", invalid), /DURACAO_CONSULTA_INVALIDA/);
  }
  assert.throws(() => settings.appointmentDuration(config, "unknown"), /TIPO_CONSULTA_INVALIDO/);
});

test("unclassified patients are not silently labeled private and institutional or TISS origins take precedence", () => {
  assert.equal(settings.sessionPaymentType({}), "unspecified");
  assert.equal(settings.sessionPaymentType({ paymentType: "private" }), "private");
  assert.equal(settings.sessionPaymentType({ paymentType: "insurance" }), "insurance");
  assert.equal(settings.sessionPaymentType({ paymentType: "private", tiss: { convenioCode: "plan" } }), "insurance");
  assert.equal(settings.sessionPaymentType({ paymentType: "private", publicProgramId: "school" }), "institutional");
  assert.equal(settings.sessionPaymentType({ paymentType: "private", empresaId: "company" }), "corporate");
});

const source = fs.readFileSync(path.join(__dirname, "../routes/therapy.js"), "utf8");
const start = source.indexOf("async function computeAvailableSlots(");
const computeSource = source.slice(start, source.indexOf("// GET /public/profissionais", start));
const monday8 = Date.parse("2026-10-19T11:00:00Z"); // 08:00 in Minas Gerais
const minute = 60_000;

async function slotsFor({ sessions = [], blackouts = [], pending = [], weeklyAvailability = { 1: [8, 9] }, config = {}, type = "return" } = {}) {
  const collections = { therapy_sessions: sessions, therapy_blackouts: blackouts, therapy_scheduling_requests: pending };
  const context = {
    ...settings, ...state,
    Date: class extends Date { static now() { return Date.parse("2026-10-18T12:00:00Z"); } },
    SCHEDULING_REQUEST_DEFAULT_MIN_NOTICE_HOURS: 0,
    SCHEDULING_REQUEST_DEFAULT_MAX_ADVANCE_DAYS: 60,
    getDb: () => ({ collection(name) {
      assert.ok(name in collections, `Unknown collection: ${name}`);
      return {
        where() { return this; },
        async get() { return { forEach(callback) { collections[name].forEach(row => callback({ data: () => row })); } }; }
      };
    } })
  };
  vm.runInNewContext(computeSource + "\nthis.compute = computeAvailableSlots;", context);
  return context.compute({ therapist: { agendaConfig: { startHour: 8, endHour: 10, ...config }, weeklyAvailability }, therapistUid: "professional", fromMs: monday8, toMs: monday8 + 120 * minute, appointmentType: type });
}

test("public calendar offers 20-minute returns and 30-minute first visits inside the configured hours", async () => {
  const returns = await slotsFor();
  assert.equal(returns.slotMinutes, 20);
  assert.deepEqual(Array.from(returns.slots, s => (s.start - monday8) / minute), [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  const initial = await slotsFor({ type: "initial" });
  assert.ok(initial.slots.every(s => (s.end - s.start) / minute === 30));
  const custom = await slotsFor({ type: "initial", config: { appointmentDurations: { initial: 45 } } });
  assert.ok(custom.slots.every(s => s.end <= monday8 + 120 * minute && s.end - s.start === 45 * minute));
  const split = await slotsFor({ weeklyAvailability: { 1: [8, 10] }, type: "initial" });
  assert.ok(split.slots.every(s => s.end <= monday8 + 60 * minute || s.start >= monday8 + 120 * minute));
});

test("availability uses each existing session's duration, pending requests and professional blackouts", async () => {
  const result = await slotsFor({
    sessions: [{ scheduledAt: monday8, durationMinutes: 30, status: "scheduled" }],
    blackouts: [{ from: monday8 + 60 * minute, to: monday8 + 80 * minute }],
    pending: [{ requestedSlot: monday8 + 100 * minute, requestedSlotEnd: monday8 + 120 * minute }]
  });
  assert.deepEqual(Array.from(result.slots.filter(s => s.available), s => (s.start - monday8) / minute), [30, 40, 80]);
  const canceled = await slotsFor({ sessions: [{ scheduledAt: monday8, durationMinutes: 120, status: "canceled" }] });
  assert.ok(canceled.slots.every(s => s.available));
});

test("legacy public hours stay in Sao Paulo time and preserve the 50-minute fallback", async () => {
  const result = await slotsFor({ weeklyAvailability: null, type: "standard" });
  assert.equal(result.slotMinutes, 50);
  assert.equal(result.slots[0].start, monday8);
  assert.equal(result.slots[0].end, monday8 + 50 * minute);
});

test("partial duration configuration preserves other appointment types and rejects invalid changes", () => {
  const begin = source.indexOf("  if (req.body?.agendaConfig !== undefined");
  const code = source.slice(begin, source.indexOf("\n  //", begin + 20));
  function update(agendaConfig) {
    const context = { req: { body: { agendaConfig } }, res: {}, updates: {}, validDuration: settings.validDuration,
      therapist: { agendaConfig: { startHour: 8, slotMinutes: 50, appointmentDurations: { initial: 30, return: 20 } } },
      sendError: (_, status, error) => ({ status, error }) };
    const result = vm.runInNewContext("(function(){" + code + "})()", context);
    return { result, config: context.updates.agendaConfig };
  }
  const { config } = update({ appointmentDurations: { return: 25 } });
  assert.equal(config.slotMinutes, 50);
  assert.equal(config.appointmentDurations.initial, 30);
  assert.equal(config.appointmentDurations.return, 25);
  assert.equal(update({ appointmentDurations: { initial: -10 } }).result.status, 400);
});
