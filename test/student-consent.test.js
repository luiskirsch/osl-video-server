'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  STUDENT_CONSENT_TTL_MS,
  parseStudentBirthDate,
  createStudentConsentToken,
  hashStudentConsentToken,
  escapeStudentEmailHtml
} = require('../services/student-consent');

const reference = new Date('2026-08-27T12:00:00-03:00');

test('data de nascimento válida calcula maioridade na data exata', () => {
  assert.deepEqual(parseStudentBirthDate('2008-08-27', { now: reference }), {
    normalized: '2008-08-27',
    age: 18
  });
  assert.equal(parseStudentBirthDate('2008-08-28', { now: reference }).age, 17);
});
test('data inválida, futura ou implausível é recusada', () => {
  assert.equal(parseStudentBirthDate('2026-02-30', { now: reference }), null);
  assert.equal(parseStudentBirthDate('2026-08-28', { now: reference }), null);
  assert.equal(parseStudentBirthDate('1900-01-01', { now: reference }), null);
  assert.equal(parseStudentBirthDate('27/08/2008', { now: reference }), null);
});

test('convite usa token forte, guarda hash e expira em 72 horas', () => {
  const nowMs = reference.getTime();
  const invitation = createStudentConsentToken(nowMs);
  assert.match(invitation.token, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(invitation.tokenHash, hashStudentConsentToken(invitation.token));
  assert.notEqual(invitation.tokenHash, invitation.token);
  assert.equal(invitation.expiresAt, nowMs + STUDENT_CONSENT_TTL_MS);
});

test('conteúdo inserido no e-mail é escapado', () => {
  assert.equal(
    escapeStudentEmailHtml('<b>"Ana" & José</b>'),
    '&lt;b&gt;&quot;Ana&quot; &amp; José&lt;/b&gt;'
  );
});
