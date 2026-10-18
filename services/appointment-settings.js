"use strict";

const APPOINTMENT_DEFAULTS = Object.freeze({ initial: 30, return: 20, follow_up: 20 });
const APPOINTMENT_TYPES = ["standard", ...Object.keys(APPOINTMENT_DEFAULTS)];
const PAYMENT_TYPES = ["unspecified", "private", "insurance"];

function validDuration(value) {
  return Number.isInteger(value) && value >= 15 && value <= 240;
}

function appointmentDuration(config = {}, type = "standard", override) {
  if (!APPOINTMENT_TYPES.includes(type)) throw new Error("TIPO_CONSULTA_INVALIDO");
  if (override !== undefined) {
    if (!validDuration(override)) throw new Error("DURACAO_CONSULTA_INVALIDA");
    return override;
  }
  if (type === "standard") return validDuration(config.slotMinutes) ? config.slotMinutes : 60;
  const configured = config.appointmentDurations?.[type];
  return validDuration(configured) ? configured : APPOINTMENT_DEFAULTS[type];
}

function sessionPaymentType(session = {}) {
  if (session.isPublicSchoolSession || session.careOrigin === "public_school" || session.publicProgramId) return "institutional";
  if (session.empresaId || session.corporateBenefit) return "corporate";
  if (session.tiss?.convenioCode || session.tissConvenioCode) return "insurance";
  return PAYMENT_TYPES.includes(session.paymentType) ? session.paymentType : "unspecified";
}

function overlaps(start, end, ranges) {
  return ranges.some(range => start < range.end && end > range.start);
}

// Each selected weekly hour is an available hour, not a single appointment.
// Merge adjacent hours so a consultation can span an hour boundary.
function weeklyWindows(hours = []) {
  const sorted = [...new Set(hours.filter(h => Number.isInteger(h) && h >= 0 && h < 24))].sort((a, b) => a - b);
  const windows = [];
  for (const hour of sorted) {
    const last = windows.at(-1);
    if (last && last.end === hour * 60) last.end += 60;
    else windows.push({ start: hour * 60, end: (hour + 1) * 60 });
  }
  return windows;
}

module.exports = { APPOINTMENT_DEFAULTS, APPOINTMENT_TYPES, PAYMENT_TYPES, validDuration, appointmentDuration, sessionPaymentType, overlaps, weeklyWindows };
