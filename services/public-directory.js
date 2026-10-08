"use strict";

/**
 * A visibilidade e controlada pelo admin. Durante a migracao, preservamos o
 * ultimo opt-in salvo, mas ele deixou de ser gravavel pelo profissional.
 */
function getPublicDirectoryVisibility(therapist = {}) {
  if (typeof therapist.adminDirectoryVisible === "boolean") {
    return therapist.adminDirectoryVisible;
  }
  if (typeof therapist.adminDirectoryBlocked === "boolean") {
    return !therapist.adminDirectoryBlocked;
  }
  return Boolean(therapist.listPublicly) || Boolean(therapist.publicSchedulingEnabled);
}

function isPublicDirectoryEligible(therapist = {}) {
  return therapist.verificationStatus === "verified"
    && getPublicDirectoryVisibility(therapist);
}

// Dois diretórios separados por público:
//  - "programa": alunos e colaboradores. Só profissionais com acesso
//    institucional liberado pelo admin (plano "empresa").
//  - "pacientes": pacientes particulares. Só profissionais pagantes; quem
//    atende os programas nunca aparece aqui.
const PAYING_PREAPPROVAL_STATUSES = new Set(["authorized", "pending"]);

function millis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isProgramProfessional(therapist = {}) {
  return therapist.plano === "empresa";
}

function isPayingProfessional(therapist = {}, now = Date.now()) {
  if (isProgramProfessional(therapist)) return false;
  if (millis(therapist.adminGrantedUntil) > now) return true;
  if (therapist.plano === "pro") return true;
  // Trial do plano Profissional com cartão cadastrado: já é assinante.
  return therapist.plano === "trial" && PAYING_PREAPPROVAL_STATUSES.has(therapist.mpPreapprovalStatus);
}

function isDirectoryEligibleFor(audience, therapist = {}, now = Date.now()) {
  if (!isPublicDirectoryEligible(therapist)) return false;
  return audience === "programa"
    ? isProgramProfessional(therapist)
    : isPayingProfessional(therapist, now);
}

module.exports = {
  getPublicDirectoryVisibility, isPublicDirectoryEligible,
  isProgramProfessional, isPayingProfessional, isDirectoryEligibleFor
};
