'use strict';

const crypto = require('crypto');

const PROVIDER_REQUIRED_FIELDS = Object.freeze([
  'legalName',
  'tradeName',
  'cnpj',
  'crpPjRegistration',
  'technicalResponsibleName',
  'technicalResponsibleCrp',
  'clinicalCoordinatorName',
  'clinicalCoordinatorEmail',
  'clinicalCoordinatorPhone',
  'dpoName',
  'dpoEmail',
  'incidentEmail',
  'securityOfficerName',
  'securityOfficerEmail',
  'serviceAddress',
  'privacyNoticeVersion',
  'clinicalProtocolVersion',
  'emergencyProtocolVersion',
  'businessContinuityPlanVersion',
  'incidentResponsePlanVersion',
  'clinicalRecordCustodian',
  'emergencyCoverageDescription'
]);

const PROGRAM_STATUSES = Object.freeze(['draft', 'active', 'suspended', 'closed']);
const SCHOOL_STATUSES = Object.freeze(['active', 'inactive']);
const CASE_STATUSES = Object.freeze([
  'pending_guardian_consent',
  'pending_participant_consent',
  'pending_triage',
  'triage_in_progress',
  'waiting_assignment',
  'assigned',
  'care_active',
  'referral_required',
  'referred_in_person',
  'referred_network',
  'discharged',
  'declined',
  'consent_revoked',
  'suspended'
]);

const CASE_TRANSITIONS = Object.freeze({
  pending_guardian_consent: ['pending_triage', 'declined', 'consent_revoked'],
  pending_participant_consent: ['pending_triage', 'declined', 'consent_revoked'],
  pending_triage: ['triage_in_progress', 'assigned', 'referral_required', 'declined', 'suspended', 'consent_revoked'],
  triage_in_progress: ['waiting_assignment', 'assigned', 'referral_required', 'referred_in_person', 'referred_network', 'declined', 'suspended', 'consent_revoked'],
  waiting_assignment: ['assigned', 'referred_in_person', 'referred_network', 'suspended', 'consent_revoked'],
  assigned: ['care_active', 'waiting_assignment', 'referral_required', 'referred_in_person', 'referred_network', 'suspended', 'consent_revoked'],
  care_active: ['referred_in_person', 'referred_network', 'discharged', 'suspended', 'consent_revoked'],
  referral_required: ['referred_in_person', 'referred_network', 'suspended', 'consent_revoked'],
  referred_in_person: ['care_active', 'discharged', 'suspended'],
  referred_network: ['care_active', 'discharged', 'suspended'],
  suspended: ['pending_triage', 'waiting_assignment', 'assigned', 'care_active', 'discharged'],
  declined: [],
  consent_revoked: [],
  discharged: []
});

function cleanText(value, max = 200) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function cleanMultiline(value, max = 3000) {
  const text = String(value ?? '').replace(/\u0000/g, '').trim();
  return text ? text.slice(0, max) : null;
}

function normalizeEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.slice(0, 160) : null;
}

function normalizePhone(value) {
  const phone = String(value ?? '').trim().replace(/[^\d+()\-\s]/g, '').slice(0, 24);
  return phone.replace(/\D/g, '').length >= 8 ? phone : null;
}

function normalizeCnpj(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length === 14 ? digits : null;
}

function normalizeDate(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? text
    : null;
}

function dateInSaoPaulo(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).reduce((acc, part) => { acc[part.type] = part.value; return acc; }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function normalizeMoodRecordDate(date, recordedAt, today = dateInSaoPaulo()) {
  const storedDate = String(date || '');
  if (!recordedAt) return storedDate;
  const recordedLocalDate = dateInSaoPaulo(recordedAt);
  return storedDate > recordedLocalDate && recordedLocalDate <= today
    ? recordedLocalDate
    : storedDate;
}

function optionalInteger(value, fallback = null) {
  if (value === null || value === undefined || String(value).trim() === '') return fallback;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function slugifyPublicProgram(value) {
  return String(value ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 48);
}

function createOpaqueCode(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashOpaqueCode(code) {
  return crypto.createHash('sha256').update(String(code ?? '')).digest('hex');
}

function safeCodeMatch(code, expectedHash) {
  if (!code || !expectedHash) return false;
  const actual = Buffer.from(hashOpaqueCode(code), 'hex');
  const expected = Buffer.from(String(expectedHash), 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function validateProviderProfile(input) {
  const value = {
    legalName: cleanText(input?.legalName, 180),
    tradeName: cleanText(input?.tradeName, 120),
    cnpj: normalizeCnpj(input?.cnpj),
    crpPjRegistration: cleanText(input?.crpPjRegistration, 40),
    technicalResponsibleName: cleanText(input?.technicalResponsibleName, 120),
    technicalResponsibleCrp: cleanText(input?.technicalResponsibleCrp, 40),
    clinicalCoordinatorEmail: normalizeEmail(input?.clinicalCoordinatorEmail),
    clinicalCoordinatorPhone: normalizePhone(input?.clinicalCoordinatorPhone),
    dpoName: cleanText(input?.dpoName, 120),
    dpoEmail: normalizeEmail(input?.dpoEmail),
    incidentEmail: normalizeEmail(input?.incidentEmail),
    securityOfficerName: cleanText(input?.securityOfficerName, 120),
    securityOfficerEmail: normalizeEmail(input?.securityOfficerEmail),
    serviceAddress: cleanText(input?.serviceAddress, 300),
    healthLicense: cleanText(input?.healthLicense, 80),
    cnes: cleanText(input?.cnes, 20),
    liabilityInsurance: cleanText(input?.liabilityInsurance, 100),
    clinicalCoordinatorName: cleanText(input?.clinicalCoordinatorName, 120),
    privacyNoticeVersion: cleanText(input?.privacyNoticeVersion, 40),
    clinicalProtocolVersion: cleanText(input?.clinicalProtocolVersion, 40),
    emergencyProtocolVersion: cleanText(input?.emergencyProtocolVersion, 40),
    businessContinuityPlanVersion: cleanText(input?.businessContinuityPlanVersion, 40),
    incidentResponsePlanVersion: cleanText(input?.incidentResponsePlanVersion, 40),
    clinicalRecordCustodian: cleanText(input?.clinicalRecordCustodian, 160),
    emergencyCoverageDescription: cleanMultiline(input?.emergencyCoverageDescription, 2000)
  };
  const missing = PROVIDER_REQUIRED_FIELDS.filter(field => !value[field]);
  return { ok: missing.length === 0, value, missing };
}

function validateProgram(input, { partial = false } = {}) {
  const value = {
    name: cleanText(input?.name, 140),
    contractingAuthorityName: cleanText(input?.contractingAuthorityName, 180),
    contractingAuthorityCnpj: normalizeCnpj(input?.contractingAuthorityCnpj),
    municipality: cleanText(input?.municipality, 100),
    state: cleanText(input?.state, 2)?.toUpperCase() || null,
    contractNumber: cleanText(input?.contractNumber, 80),
    processNumber: cleanText(input?.processNumber, 80),
    legalInstrument: cleanText(input?.legalInstrument, 80),
    legalBasis: cleanText(input?.legalBasis, 180),
    contractingModel: cleanText(input?.contractingModel, 80),
    innovationChallenge: cleanMultiline(input?.innovationChallenge, 2000),
    solutionHypothesis: cleanMultiline(input?.solutionHypothesis, 2000),
    experimentScope: cleanMultiline(input?.experimentScope, 2000),
    successMetrics: cleanMultiline(input?.successMetrics, 2000),
    milestones: cleanMultiline(input?.milestones, 2000),
    startDate: normalizeDate(input?.startDate),
    endDate: normalizeDate(input?.endDate),
    targetDescription: cleanMultiline(input?.targetDescription, 1200),
    minAge: optionalInteger(input?.minAge),
    maxAge: optionalInteger(input?.maxAge),
    maxStudents: optionalInteger(input?.maxStudents),
    maxSessionsPerStudent: optionalInteger(input?.maxSessionsPerStudent),
    maxMonthlySessions: optionalInteger(input?.maxMonthlySessions),
    sessionDurationMinutes: optionalInteger(input?.sessionDurationMinutes, 50),
    publicManagerName: cleanText(input?.publicManagerName, 120),
    publicManagerEmail: normalizeEmail(input?.publicManagerEmail),
    publicManagerPhone: normalizePhone(input?.publicManagerPhone),
    publicDpoName: cleanText(input?.publicDpoName, 120),
    publicDpoEmail: normalizeEmail(input?.publicDpoEmail),
    controllerRoleDescription: cleanMultiline(input?.controllerRoleDescription, 1200),
    processorRoleDescription: cleanMultiline(input?.processorRoleDescription, 1200),
    dataSharingAgreementReference: cleanText(input?.dataSharingAgreementReference, 160),
    retentionPolicyReference: cleanText(input?.retentionPolicyReference, 160),
    serviceLevelDescription: cleanMultiline(input?.serviceLevelDescription, 1500),
    supportHours: cleanText(input?.supportHours, 160),
    incidentSlaHours: optionalInteger(input?.incidentSlaHours),
    healthNetworkReference: cleanMultiline(input?.healthNetworkReference, 1500),
    emergencyNetworkReference: cleanMultiline(input?.emergencyNetworkReference, 1500),
    privacyNoticeVersion: cleanText(input?.privacyNoticeVersion, 40),
    consentTermVersion: cleanText(input?.consentTermVersion, 40),
    assentTermVersion: cleanText(input?.assentTermVersion, 40),
    clinicalProtocolVersion: cleanText(input?.clinicalProtocolVersion, 40),
    emergencyProtocolVersion: cleanText(input?.emergencyProtocolVersion, 40),
    ripdReference: cleanText(input?.ripdReference, 160),
    therapistUids: Array.isArray(input?.therapistUids)
      ? [...new Set(input.therapistUids.map(uid => cleanText(uid, 128)).filter(Boolean))].slice(0, 100)
      : []
  };

  const required = [
    'name', 'contractingAuthorityName', 'contractingAuthorityCnpj', 'municipality', 'state',
    'contractNumber', 'processNumber', 'legalInstrument', 'legalBasis', 'contractingModel',
    'innovationChallenge', 'solutionHypothesis', 'experimentScope', 'successMetrics', 'milestones',
    'startDate', 'endDate',
    'targetDescription', 'maxStudents', 'maxSessionsPerStudent', 'publicManagerName',
    'publicManagerEmail', 'publicDpoName', 'publicDpoEmail',
    'controllerRoleDescription', 'processorRoleDescription', 'dataSharingAgreementReference',
    'retentionPolicyReference', 'serviceLevelDescription', 'supportHours', 'incidentSlaHours',
    'healthNetworkReference', 'emergencyNetworkReference',
    'privacyNoticeVersion', 'consentTermVersion', 'assentTermVersion',
    'clinicalProtocolVersion', 'emergencyProtocolVersion', 'ripdReference'
  ];
  const missing = partial ? [] : required.filter(field => value[field] === null || value[field] === '' || value[field] === undefined);
  if (value.state && !/^[A-Z]{2}$/.test(value.state)) missing.push('state');
  if (value.startDate && value.endDate && value.startDate > value.endDate) missing.push('dateRange');
  if (value.minAge !== null && (value.minAge < 0 || value.minAge > 21)) missing.push('minAge');
  if (value.maxAge !== null && (value.maxAge < 0 || value.maxAge > 25)) missing.push('maxAge');
  if (value.minAge !== null && value.maxAge !== null && value.minAge > value.maxAge) missing.push('ageRange');
  if (value.maxStudents !== null && value.maxStudents < 1) missing.push('maxStudents');
  if (value.maxSessionsPerStudent !== null && value.maxSessionsPerStudent < 1) missing.push('maxSessionsPerStudent');
  if (value.sessionDurationMinutes < 20 || value.sessionDurationMinutes > 120) missing.push('sessionDurationMinutes');
  if (value.incidentSlaHours !== null && (value.incidentSlaHours < 1 || value.incidentSlaHours > 720)) missing.push('incidentSlaHours');
  return { ok: missing.length === 0, value, missing: [...new Set(missing)] };
}

function validateSchool(input, { partial = false } = {}) {
  const stages = Array.isArray(input?.educationStages)
    ? [...new Set(input.educationStages.map(stage => cleanText(stage, 60)).filter(Boolean))].slice(0, 12)
    : [];
  const value = {
    name: cleanText(input?.name, 180),
    inepCode: cleanText(input?.inepCode, 20),
    network: cleanText(input?.network, 40),
    educationStages: stages,
    addressStreet: cleanText(input?.addressStreet, 140),
    addressNumber: cleanText(input?.addressNumber, 20),
    addressComplement: cleanText(input?.addressComplement, 80),
    addressNeighborhood: cleanText(input?.addressNeighborhood, 100),
    addressCity: cleanText(input?.addressCity, 100),
    addressState: cleanText(input?.addressState, 2)?.toUpperCase() || null,
    addressPostalCode: cleanText(input?.addressPostalCode, 10),
    coordinatorName: cleanText(input?.coordinatorName, 120),
    coordinatorEmail: normalizeEmail(input?.coordinatorEmail),
    coordinatorPhone: normalizePhone(input?.coordinatorPhone),
    healthReferenceName: cleanText(input?.healthReferenceName, 120),
    healthReferencePhone: normalizePhone(input?.healthReferencePhone),
    safeguardingContactName: cleanText(input?.safeguardingContactName, 120),
    safeguardingContactPhone: normalizePhone(input?.safeguardingContactPhone),
    privacyContactEmail: normalizeEmail(input?.privacyContactEmail),
    maxStudents: optionalInteger(input?.maxStudents)
  };
  const required = [
    'name', 'network', 'addressStreet', 'addressNumber', 'addressNeighborhood',
    'addressCity', 'addressState', 'addressPostalCode', 'coordinatorName',
    'coordinatorEmail', 'coordinatorPhone', 'healthReferenceName', 'healthReferencePhone',
    'safeguardingContactName', 'safeguardingContactPhone', 'privacyContactEmail'
  ];
  const missing = partial ? [] : required.filter(field => !value[field]);
  if (!partial && value.educationStages.length === 0) missing.push('educationStages');
  if (value.addressState && !/^[A-Z]{2}$/.test(value.addressState)) missing.push('addressState');
  if (value.maxStudents !== null && value.maxStudents < 1) missing.push('maxStudents');
  return { ok: missing.length === 0, value, missing: [...new Set(missing)] };
}

function validateConsentOnboarding(input) {
  const value = {
    decision: input?.decision === 'declined' ? 'declined' : input?.decision === 'confirmed' ? 'confirmed' : null,
    guardianRelationship: cleanText(input?.guardianRelationship, 60),
    preferredContactChannel: ['email', 'phone', 'whatsapp'].includes(input?.preferredContactChannel)
      ? input.preferredContactChannel
      : null,
    studentEmail: input?.studentEmail ? normalizeEmail(input.studentEmail) : null,
    studentPhone: input?.studentPhone ? normalizePhone(input.studentPhone) : null,
    emergencyContactName: cleanText(input?.emergencyContactName, 120),
    emergencyContactRelationship: cleanText(input?.emergencyContactRelationship, 60),
    emergencyContactPhone: normalizePhone(input?.emergencyContactPhone),
    addressStreet: cleanText(input?.addressStreet, 140),
    addressNumber: cleanText(input?.addressNumber, 20),
    addressComplement: cleanText(input?.addressComplement, 80),
    addressNeighborhood: cleanText(input?.addressNeighborhood, 100),
    addressCity: cleanText(input?.addressCity, 100),
    addressState: cleanText(input?.addressState, 2)?.toUpperCase() || null,
    addressPostalCode: cleanText(input?.addressPostalCode, 10),
    accessibilityNeeds: cleanMultiline(input?.accessibilityNeeds, 600),
    communicationNeeds: cleanMultiline(input?.communicationNeeds, 600),
    privacyConfirmed: input?.privacyConfirmed === true,
    telehealthConfirmed: input?.telehealthConfirmed === true,
    emergencyProtocolConfirmed: input?.emergencyProtocolConfirmed === true
  };
  if (value.decision === 'declined') return { ok: true, value, missing: [] };
  const required = [
    'guardianRelationship', 'preferredContactChannel', 'emergencyContactName',
    'emergencyContactRelationship', 'emergencyContactPhone', 'addressStreet',
    'addressNumber', 'addressNeighborhood', 'addressCity', 'addressState', 'addressPostalCode'
  ];
  const missing = required.filter(field => !value[field]);
  if (!value.privacyConfirmed) missing.push('privacyConfirmed');
  if (!value.telehealthConfirmed) missing.push('telehealthConfirmed');
  if (!value.emergencyProtocolConfirmed) missing.push('emergencyProtocolConfirmed');
  return { ok: value.decision === 'confirmed' && missing.length === 0, value, missing };
}

function validateTriage(input) {
  const allowedViability = ['suitable', 'suitable_with_conditions', 'not_suitable'];
  const allowedUrgency = ['routine', 'priority', 'urgent', 'emergency'];
  const allowedAssent = ['obtained', 'declined', 'not_applicable', 'unable'];
  const value = {
    remoteViability: allowedViability.includes(input?.remoteViability) ? input.remoteViability : null,
    urgencyLevel: allowedUrgency.includes(input?.urgencyLevel) ? input.urgencyLevel : null,
    assentStatus: allowedAssent.includes(input?.assentStatus) ? input.assentStatus : null,
    assentMethod: cleanText(input?.assentMethod, 100),
    referralSource: cleanText(input?.referralSource, 100),
    referralReasonCategories: Array.isArray(input?.referralReasonCategories)
      ? [...new Set(input.referralReasonCategories.map(item => cleanText(item, 80)).filter(Boolean))].slice(0, 20)
      : [],
    referralNotes: cleanMultiline(input?.referralNotes, 3000),
    clinicalDecisionReason: cleanMultiline(input?.clinicalDecisionReason, 3000),
    privacyAvailable: input?.privacyAvailable === true,
    deviceAvailable: input?.deviceAvailable === true,
    connectivityAdequate: input?.connectivityAdequate === true,
    guardianSupportAdequate: input?.guardianSupportAdequate === true,
    accessibilityAddressed: input?.accessibilityAddressed === true,
    emergencyAddressVerified: input?.emergencyAddressVerified === true,
    localNetworkVerified: input?.localNetworkVerified === true,
    riskFlags: {
      suicideOrSelfHarm: input?.riskFlags?.suicideOrSelfHarm === true,
      violenceOrRightsViolation: input?.riskFlags?.violenceOrRightsViolation === true,
      acutePsychiatric: input?.riskFlags?.acutePsychiatric === true,
      substanceRisk: input?.riskFlags?.substanceRisk === true,
      acuteMedical: input?.riskFlags?.acuteMedical === true
    },
    recommendedFrequency: cleanText(input?.recommendedFrequency, 60),
    expectedSessions: optionalInteger(input?.expectedSessions),
    careConditions: cleanMultiline(input?.careConditions, 1500)
  };
  const missing = ['remoteViability', 'urgencyLevel', 'assentStatus', 'clinicalDecisionReason']
    .filter(field => !value[field]);
  if (value.assentStatus === 'obtained' && !value.assentMethod) missing.push('assentMethod');
  for (const field of ['emergencyAddressVerified', 'localNetworkVerified']) {
    if (!value[field]) missing.push(field);
  }
  if (value.remoteViability !== 'not_suitable') {
    for (const field of ['privacyAvailable', 'deviceAvailable', 'connectivityAdequate']) {
      if (!value[field]) missing.push(field);
    }
  }
  if (value.expectedSessions !== null && (value.expectedSessions < 1 || value.expectedSessions > 100)) missing.push('expectedSessions');
  return { ok: missing.length === 0, value, missing: [...new Set(missing)] };
}

function canTransitionCase(from, to) {
  if (!CASE_STATUSES.includes(from) || !CASE_STATUSES.includes(to)) return false;
  return from === to || (CASE_TRANSITIONS[from] || []).includes(to);
}

function programIsOperational(program, now = new Date()) {
  if (!program || program.status !== 'active' || program.registrationOpen === false) return false;
  const today = dateInSaoPaulo(now);
  return (!program.startDate || program.startDate <= today) && (!program.endDate || program.endDate >= today);
}

function createCaseCode() {
  return `EP-${new Date().getUTCFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function studentPortalAccessEmail(student) {
  return String(student?.isMenor ? student?.responsavelEmail : student?.email || '').trim().toLowerCase();
}

function studentPortalParticipationIsActive(student) {
  return student?.participationConsentStatus === 'confirmed'
    && !['declined', 'consent_revoked'].includes(student?.status);
}

module.exports = {
  PROVIDER_REQUIRED_FIELDS,
  PROGRAM_STATUSES,
  SCHOOL_STATUSES,
  CASE_STATUSES,
  cleanText,
  cleanMultiline,
  normalizeEmail,
  normalizePhone,
  normalizeCnpj,
  normalizeDate,
  dateInSaoPaulo,
  normalizeMoodRecordDate,
  slugifyPublicProgram,
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
  createCaseCode,
  studentPortalAccessEmail,
  studentPortalParticipationIsActive
};
