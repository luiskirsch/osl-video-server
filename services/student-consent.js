'use strict';

const crypto = require('crypto');

const STUDENT_CONSENT_TTL_MS = 72 * 60 * 60 * 1000;
const STUDENT_CONSENT_VERSION = '2026-08-27-v1';
const DEFAULT_TIME_ZONE = 'America/Sao_Paulo';

function getCalendarDateParts(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day)
  };
}

function parseStudentBirthDate(value, options = {}) {
  const normalized = String(value || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const birth = new Date(Date.UTC(year, month - 1, day));
  if (
    birth.getUTCFullYear() !== year ||
    birth.getUTCMonth() !== month - 1 ||
    birth.getUTCDate() !== day
  ) return null;

  const todayParts = getCalendarDateParts(
    options.now instanceof Date ? options.now : new Date(),
    options.timeZone || DEFAULT_TIME_ZONE
  );
  const today = new Date(Date.UTC(todayParts.year, todayParts.month - 1, todayParts.day));
  if (birth > today || year < todayParts.year - 120) return null;

  let age = todayParts.year - year;
  if (
    todayParts.month < month ||
    (todayParts.month === month && todayParts.day < day)
  ) age--;

  return { normalized, age };
}

function createStudentConsentToken(nowMs = Date.now()) {
  const token = crypto.randomBytes(32).toString('base64url');
  return {
    token,
    tokenHash: hashStudentConsentToken(token),
    expiresAt: nowMs + STUDENT_CONSENT_TTL_MS
  };
}

function hashStudentConsentToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function escapeStudentEmailHtml(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

module.exports = {
  STUDENT_CONSENT_TTL_MS,
  STUDENT_CONSENT_VERSION,
  parseStudentBirthDate,
  createStudentConsentToken,
  hashStudentConsentToken,
  escapeStudentEmailHtml
};
