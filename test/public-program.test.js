'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createOpaqueCode,
  hashOpaqueCode,
  safeCodeMatch,
  validateProviderProfile,
  validateProgram,
  validateSchool,
  validateConsentOnboarding,
  validateTriage,
  canTransitionCase,
  programIsOperational,
  dateInSaoPaulo,
  normalizeMoodRecordDate,
  studentPortalAccessEmail,
  studentPortalParticipationIsActive
} = require('../services/public-program');

test('convite escolar só confere com o código original', () => {
  const code = createOpaqueCode();
  const hash = hashOpaqueCode(code);
  assert.equal(safeCodeMatch(code, hash), true);
  assert.equal(safeCodeMatch(`${code}x`, hash), false);
});

test('perfil da prestadora não fica pronto sem registro e responsáveis', () => {
  const incomplete = validateProviderProfile({ legalName: 'Prelúdio' });
  assert.equal(incomplete.ok, false);
  assert.ok(incomplete.missing.includes('crpPjRegistration'));
  assert.ok(incomplete.missing.includes('technicalResponsibleCrp'));
});

test('consentimento confirmado exige emergência, endereço e três ciências', () => {
  const result = validateConsentOnboarding({ decision: 'confirmed' });
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('emergencyContactPhone'));
  assert.ok(result.missing.includes('telehealthConfirmed'));
  assert.equal(validateConsentOnboarding({ decision: 'declined' }).ok, true);
});

test('triagem remota favorável exige condições concretas de segurança', () => {
  const result = validateTriage({
    remoteViability: 'suitable', urgencyLevel: 'routine', assentStatus: 'obtained',
    assentMethod: 'verbal', clinicalDecisionReason: 'Compatível'
  });
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('privacyAvailable'));
  assert.ok(result.missing.includes('localNetworkVerified'));
});

test('triagem não apta ainda exige endereço de emergência e rede local verificados', () => {
  const result = validateTriage({
    remoteViability: 'not_suitable', urgencyLevel: 'urgent', assentStatus: 'obtained',
    assentMethod: 'verbal', clinicalDecisionReason: 'Encaminhamento presencial indicado'
  });
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('emergencyAddressVerified'));
  assert.ok(result.missing.includes('localNetworkVerified'));
});

test('máquina de estados bloqueia atalho de consentimento para atendimento', () => {
  assert.equal(canTransitionCase('pending_guardian_consent', 'care_active'), false);
  assert.equal(canTransitionCase('pending_guardian_consent', 'pending_triage'), true);
  assert.equal(canTransitionCase('pending_triage', 'referral_required'), true);
  assert.equal(canTransitionCase('assigned', 'care_active'), true);
  assert.equal(canTransitionCase('discharged', 'care_active'), false);
});

test('programa só opera ativo, aberto e dentro da vigência', () => {
  const now = new Date('2026-08-27T12:00:00Z');
  assert.equal(programIsOperational({ status: 'active', registrationOpen: true, startDate: '2026-01-01', endDate: '2026-12-31' }, now), true);
  assert.equal(programIsOperational({ status: 'draft', registrationOpen: true, startDate: '2026-01-01', endDate: '2026-12-31' }, now), false);
  assert.equal(programIsOperational({ status: 'active', registrationOpen: true, startDate: '2027-01-01', endDate: '2027-12-31' }, now), false);
});

test('vigência e competência usam a data de São Paulo, não a virada UTC', () => {
  const lateEvening = new Date('2026-09-01T01:30:00Z');
  assert.equal(dateInSaoPaulo(lateEvening), '2026-08-31');
  assert.equal(programIsOperational({ status: 'active', registrationOpen: true, startDate: '2026-08-01', endDate: '2026-08-31' }, lateEvening), true);
});

test('humor salvo em UTC depois das 21h volta para o dia local correto', () => {
  const recordedAt = new Date('2026-09-04T01:30:00Z'); // 03/09 às 22h30 em São Paulo
  assert.equal(normalizeMoodRecordDate('2026-09-04', recordedAt, '2026-09-04'), '2026-09-03');
  assert.equal(normalizeMoodRecordDate('2026-09-03', recordedAt, '2026-09-04'), '2026-09-03');
});

test('campos numéricos vazios não viram cota zero', () => {
  const result = validateProgram({ maxMonthlySessions: '', minAge: '', sessionDurationMinutes: '' });
  assert.equal(result.value.maxMonthlySessions, null);
  assert.equal(result.value.minAge, null);
  assert.equal(result.value.sessionDurationMinutes, 50);
});

test('contrato exige contato do DPO público e escola exige etapas atendidas', () => {
  const program = validateProgram({ publicDpoName: '', publicDpoEmail: '' });
  assert.ok(program.missing.includes('publicDpoName'));
  assert.ok(program.missing.includes('publicDpoEmail'));
  const school = validateSchool({ name: 'Escola', educationStages: [] });
  assert.ok(school.missing.includes('educationStages'));
});

test('portal municipal usa responsável para menor e o próprio aluno para maior', () => {
  assert.equal(studentPortalAccessEmail({ isMenor: true, responsavelEmail: 'RESPONSAVEL@EXEMPLO.COM', studentEmail: 'aluno@escola.edu.br' }), 'responsavel@exemplo.com');
  assert.equal(studentPortalAccessEmail({ isMenor: false, email: 'ALUNO@EXEMPLO.COM' }), 'aluno@exemplo.com');
});

test('portal municipal só libera participação confirmada e ativa', () => {
  assert.equal(studentPortalParticipationIsActive({ participationConsentStatus: 'confirmed', status: 'care_active' }), true);
  assert.equal(studentPortalParticipationIsActive({ participationConsentStatus: 'pending', status: 'pending_guardian_consent' }), false);
  assert.equal(studentPortalParticipationIsActive({ participationConsentStatus: 'confirmed', status: 'consent_revoked' }), false);
});
