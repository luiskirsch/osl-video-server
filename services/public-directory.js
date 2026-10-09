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
//  - "programa": alunos e colaboradores. É a rede curada pelo admin
//    ("Exibir/Ocultar da rede"): verificado + visível.
//  - "pacientes": pacientes particulares. Profissionais pagantes verificados
//    que NÃO estão na rede dos programas. O admin pode ocultar alguém só deste
//    diretório com adminPatientDirectoryHidden.
const PAYING_PREAPPROVAL_STATUSES = new Set(["authorized", "pending"]);

function millis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Quem paga é definido pela assinatura, não pelo nome do plano: contas
// antigas do "Atendimento a Empresas" ficaram com plano "empresa" mas têm
// cartão cadastrado e assinatura ativa.
function isPayingProfessional(therapist = {}, now = Date.now()) {
  if (therapist.legacyExempt === true) return true; // isentos contam como pagantes (diretório, valor próprio)
  if (PAYING_PREAPPROVAL_STATUSES.has(therapist.mpPreapprovalStatus)) return true;
  if (therapist.plano === "pro") return true;
  return millis(therapist.adminGrantedUntil) > now && therapist.plano !== "empresa";
}

function isProgramNetworkMember(therapist = {}) {
  return isPublicDirectoryEligible(therapist);
}

function isDirectoryEligibleFor(audience, therapist = {}, now = Date.now()) {
  if (audience === "programa") return isProgramNetworkMember(therapist);
  return therapist.verificationStatus === "verified"
    && therapist.adminPatientDirectoryHidden !== true
    && !isProgramNetworkMember(therapist)
    && isPayingProfessional(therapist, now);
}

// Agendamento pelo link público: pagante tem automaticamente; quem marcou a
// opção antiga continua ativo (compatibilidade com contas de programa).
function isPublicSchedulingOn(therapist = {}, now = Date.now()) {
  return therapist.publicSchedulingEnabled === true || isPayingProfessional(therapist, now);
}

// Institucional = plano liberado pelo admin, sem mensalidade. Só nesse caso o
// paciente paga R$ 60 pela plataforma (PIX) e o profissional recebe repasse.
// Pagantes da mensalidade definem e cobram o próprio valor.
function isInstitutionalProfessional(therapist = {}, now = Date.now()) {
  return therapist.plano === "empresa" && !isPayingProfessional(therapist, now);
}

module.exports = {
  getPublicDirectoryVisibility, isPublicDirectoryEligible,
  isProgramNetworkMember, isPayingProfessional, isDirectoryEligibleFor, isPublicSchedulingOn,
  isInstitutionalProfessional
};
