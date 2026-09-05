'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  therapySessionDurationMinutes,
  therapyTimestampMillis,
  therapySessionStartedAt,
  therapySessionOverdueAt,
  isTherapySessionOverdue,
  selectTherapyPanelSessions
} = require('../services/therapy-session-state');

const START = Date.UTC(2026, 8, 1, 20, 0, 0);

test('início compartilhado sobrevive a reconexões e normaliza timestamps', () => {
  const persisted = START - 30_000;
  const session = {
    sessionStartedAt: persisted,
    therapistJoinedAt: { toMillis: () => START + 10_000 },
    patientJoinedAt: new Date(START + 20_000)
  };
  assert.equal(therapySessionStartedAt(session, START + 30_000), persisted);
  assert.equal(therapyTimestampMillis({ toMillis: () => START }), START);
});

test('sessão legada usa a primeira entrada conhecida sem reiniciar', () => {
  const session = {
    therapistJoinedAt: { toMillis: () => START + 5_000 },
    patientJoinedAt: START
  };
  assert.equal(therapySessionStartedAt(session, START + 30_000), START);
  assert.equal(therapySessionStartedAt({}, START + 30_000), START + 30_000);
});

test('consulta permanece ativa durante a duração e a tolerância', () => {
  const session = { status: 'in_progress', scheduledAt: START, durationMinutes: 50 };
  assert.equal(isTherapySessionOverdue(session, START + 79 * 60 * 1000), false);
  assert.equal(isTherapySessionOverdue(session, START + 80 * 60 * 1000), true);
});

test('consulta agendada também fica pendente depois da janela', () => {
  const session = { status: 'scheduled', scheduledAt: START, durationMinutes: 50 };
  assert.equal(isTherapySessionOverdue(session, START + 80 * 60 * 1000), true);
});

test('consulta concluída ou cancelada nunca é classificada como pendente', () => {
  const completed = { status: 'completed', scheduledAt: START, durationMinutes: 50 };
  const canceled = { status: 'canceled', scheduledAt: START, durationMinutes: 50 };
  assert.equal(isTherapySessionOverdue(completed, START + 24 * 60 * 60 * 1000), false);
  assert.equal(isTherapySessionOverdue(canceled, START + 24 * 60 * 60 * 1000), false);
});

test('duração ausente usa 60 minutos e valores extremos são limitados', () => {
  assert.equal(therapySessionDurationMinutes({}), 60);
  assert.equal(therapySessionDurationMinutes({ durationMinutes: null }), 60);
  assert.equal(therapySessionDurationMinutes({ durationMinutes: '' }), 60);
  assert.equal(therapySessionDurationMinutes({ durationMinutes: 0 }), 60);
  assert.equal(therapySessionDurationMinutes({ durationMinutes: 2 }), 15);
  assert.equal(therapySessionDurationMinutes({ durationMinutes: 900 }), 240);
  assert.equal(therapySessionOverdueAt({ scheduledAt: START }), START + 90 * 60 * 1000);
});

test('sessão sem horário válido não vira pendência', () => {
  assert.equal(isTherapySessionOverdue({ status: 'scheduled' }, START), false);
  assert.equal(isTherapySessionOverdue({ status: 'scheduled', scheduledAt: 0 }, START), false);
});

test('próxima consulta e pendência são selecionadas sem uma esconder a outra', () => {
  const old = { sessionId: 'old', status: 'in_progress', scheduledAt: START, durationMinutes: 50 };
  const future = { sessionId: 'future', status: 'scheduled', scheduledAt: START + 24 * 60 * 60 * 1000, durationMinutes: 50 };
  const recentOverdue = { sessionId: 'recent', status: 'scheduled', scheduledAt: START + 60 * 60 * 1000, durationMinutes: 50 };
  const selected = selectTherapyPanelSessions(
    [old, future, recentOverdue, { status: 'completed', scheduledAt: START }],
    START + 5 * 60 * 60 * 1000
  );
  assert.equal(selected.nextSession.sessionId, 'future');
  assert.equal(selected.overdueSession.sessionId, 'recent');
});
