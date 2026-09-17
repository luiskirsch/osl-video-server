'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildProfessionalAggregation,
  publicProfessional
} = require('../services/rt-professional-aggregation');

function doc(id, data) { return { id, data: () => data }; }
const resolveCouncil = data => data.tipoConselho || (data.crp ? 'CRP' : '');

test('agrupa contas duplicadas por email ou CRP e soma todo o historico', () => {
  const now = Date.UTC(2026, 8, 17);
  const professionals = [
    doc('old', { displayName: 'Thalia', email: 'THALIA@example.com ', crp: 'CRP 07/39630', verificationStatus: 'pending' }),
    doc('active', { displayName: 'Psicóloga Thalia', email: 'thalia@example.com', crp: '0739630', verificationStatus: 'verified' })
  ];
  const sessions = [
    doc('s1', { therapistUid: 'old', scheduledAt: now - 40 * 86400000, status: 'completed', patientName: 'NAO EXPOR' }),
    doc('s2', { therapistUid: 'active', scheduledAt: now - 2 * 86400000, status: 'completed', durationMinutes: 50 }),
    doc('s3', { therapistUid: 'active', scheduledAt: now - 86400000, status: 'canceled' })
  ];

  const result = buildProfessionalAggregation({ professionalDocs: professionals, sessionDocs: sessions, resolveCouncil, now });
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].accountCount, 2);
  assert.equal(result.groups[0].sessionsAllTime, 3);
  assert.equal(result.groups[0].sessions30d, 2);
  assert.equal(result.groups[0].completedSessionsAllTime, 2);
  assert.equal(result.groups[0].verified, true);
  assert.equal(result.groupByUid.get('old'), result.groups[0]);
});

test('nao expoe UIDs associados nem sessoes na listagem publica', () => {
  const result = buildProfessionalAggregation({
    professionalDocs: [doc('uid', { displayName: 'Pessoa', crp: '04/1', tipoConselho: 'CRP' })],
    sessionDocs: [doc('session', { therapistUid: 'uid', scheduledAt: 1000, status: 'scheduled', patientEmail: 'sigilo@example.com' })],
    resolveCouncil,
    now: 2000
  });
  const output = publicProfessional(result.groups[0]);
  assert.equal('memberUids' in output, false);
  assert.equal('sessions' in output, false);
  assert.equal(JSON.stringify(output).includes('sigilo@example.com'), false);
});

test('mantem profissionais diferentes separados', () => {
  const result = buildProfessionalAggregation({
    professionalDocs: [
      doc('a', { displayName: 'A', email: 'a@example.com', crp: '04/1' }),
      doc('b', { displayName: 'B', email: 'b@example.com', crp: '04/2' })
    ],
    sessionDocs: [], resolveCouncil, now: Date.now()
  });
  assert.equal(result.groups.length, 2);
});
