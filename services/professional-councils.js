// services/professional-councils.js
//
// Source of truth dos conselhos profissionais aceitos no Espaço Prelúdio.
// Cada conselho define metadados pra cadastro/UI e a matriz de capabilities
// que controla quais features clínicas o profissional pode usar.
//
// Capabilities (consumidas em S21.1 via requireCapability):
//   "consulta"                — agendar/atender consulta (todos os conselhos têm)
//   "anotacoes"               — anotações clínicas E2EE (todos têm)
//   "atestado-comparecimento" — atestado de presença em sessão (todos têm)
//   "documentos-clinicos"     — relatório clínico, encaminhamento, atestado de doença
//   "receita"                 — gate de acesso aos endpoints de receita medicamentosa
//
// Quando "receita" está habilitada, prescriptionTypes define QUAIS tipos:
//   "mip"               — medicamentos isentos de prescrição (livre prescrição)
//   "insumo-injetavel"  — insumos/injetáveis estéticos (Ac. COFFITO 735/2024 p/ fisio)
//   "controlado"        — Portaria SVS/MS 344/1998 (psicotrópicos, antibióticos etc) — só CRM
//
// eligibleTiers controla quais tiers de plano cada conselho pode escolher
// no cadastro. Tier "estudante" exige clínica-escola/internato, que só
// existe em Psicologia/Medicina — outros conselhos pulam direto pra
// "recem-formado" (12 meses pós-inscrição) ou "profissional".
//
// Pra adicionar conselho novo: append aqui + atualizar buildRegistrationPrompt
// em document-validator.js (lista de conselhos suportados) + atualizar dropdown
// em cadastro.html.

const CONSELHOS = {
  CRP: {
    sigla: "CRP",
    label: "CRP — Conselho Regional de Psicologia",
    profissional: "Psicólogo(a)",
    numberFormat: "Ex.: 12/12345",
    capabilities: ["consulta", "anotacoes", "atestado-comparecimento", "documentos-clinicos"],
    eligibleTiers: ["estudante", "recem-formado", "profissional"]
  },
  CRM: {
    sigla: "CRM",
    label: "CRM — Conselho Regional de Medicina (médicos, psiquiatras)",
    profissional: "Médico(a)",
    numberFormat: "Ex.: 123456-SC",
    capabilities: ["consulta", "anotacoes", "atestado-comparecimento", "documentos-clinicos", "receita"],
    // Médico prescreve qualquer tipo, incluindo controlados (Portaria 344/98).
    prescriptionTypes: ["mip", "insumo-injetavel", "controlado"],
    eligibleTiers: ["estudante", "recem-formado", "profissional"]
  },
  CRESS: {
    sigla: "CRESS",
    label: "CRESS — Conselho Regional de Serviço Social",
    profissional: "Assistente social",
    numberFormat: "Ex.: 12345/SC",
    capabilities: ["consulta", "anotacoes", "atestado-comparecimento"],
    eligibleTiers: ["recem-formado", "profissional"]
  },
  CREFITO: {
    sigla: "CREFITO",
    label: "CREFITO — Conselho Regional de Fisioterapia e Terapia Ocupacional",
    profissional: "Terapeuta ocupacional / Fisioterapeuta",
    numberFormat: "Ex.: 12345-F (fisio) / 12345-TO (terapeuta ocupacional)",
    // Capabilities base do conselho. "receita" só fica disponível pra fisio/TO
    // que tenham subtipo definido (ver subtipos abaixo). Sem subtipo, sem receita.
    capabilities: ["consulta", "anotacoes", "atestado-comparecimento", "receita"],
    prescriptionTypes: [], // delegado pro subtipo — fisio vs TO têm escopos diferentes
    requiresSubtipo: true,
    subtipos: {
      // Fisioterapeuta: MIPs (livre) + insumos/injetáveis (Acórdão COFFITO 735/2024).
      // Não controlado (Portaria 344 — privativo CRM).
      fisio: {
        label: "Fisioterapeuta",
        prescriptionTypes: ["mip", "insumo-injetavel"]
      },
      // Terapeuta ocupacional: só MIPs (livre prescrição).
      // Acórdão 735 não menciona TO; sem base legal pra injetáveis/controlados.
      to: {
        label: "Terapeuta ocupacional",
        prescriptionTypes: ["mip"]
      }
    },
    eligibleTiers: ["recem-formado", "profissional"]
  },
  CRFA: {
    sigla: "CRFA",
    label: "CRFa — Conselho Regional de Fonoaudiologia",
    profissional: "Fonoaudiólogo(a)",
    numberFormat: "Ex.: CRFa 1-12345",
    capabilities: ["consulta", "anotacoes", "atestado-comparecimento"],
    eligibleTiers: ["recem-formado", "profissional"]
  },
  CRN: {
    sigla: "CRN",
    label: "CRN — Conselho Regional de Nutricionistas",
    profissional: "Nutricionista",
    numberFormat: "Ex.: CRN-2 12345",
    // CRN tem prescrição dietética (não medicamentosa) — quando tivermos
    // endpoint específico pra prescrição nutricional, adiciona capability
    // própria. "documentos-clinicos" hoje cobre atestado/encaminhamento
    // médico, restrito a CRM/CRP por decisão de produto.
    capabilities: ["consulta", "anotacoes", "atestado-comparecimento"],
    eligibleTiers: ["recem-formado", "profissional"]
  },
  CRO: {
    sigla: "CRO",
    label: "CRO — Conselho Regional de Odontologia (ansiedade odontológica, bruxismo, DTM)",
    profissional: "Cirurgião(ã)-dentista",
    numberFormat: "Ex.: CRO-SC 12345",
    // Dentista emite atestado odontológico, mas o endpoint /documentos
    // hoje gera atestado/encaminhamento médico — restrito a CRM/CRP.
    // Atestado odontológico precisa de endpoint próprio (futuro).
    capabilities: ["consulta", "anotacoes", "atestado-comparecimento"],
    eligibleTiers: ["recem-formado", "profissional"]
  },
  CREF: {
    sigla: "CREF",
    label: "CREF — Conselho Regional de Educação Física (orientação, bem-estar)",
    profissional: "Profissional de Educação Física",
    numberFormat: "Ex.: 012345-G/SC",
    capabilities: ["consulta", "anotacoes", "atestado-comparecimento"],
    eligibleTiers: ["recem-formado", "profissional"]
  },
  // Pseudo-conselho pra terapeutas sem registro em conselho federal
  // regulamentado: psicanalistas (sem CRP), terapeutas integrativos/holísticos,
  // hipnoterapeutas. Aceita só após revisão MANUAL do diploma de formação +
  // termo de responsabilidade reforçado. Capabilities mínimas — sem receita,
  // sem documentos clínicos. Único tier: profissional (sem estudante/recém-formado).
  //
  // Diferenças vs. conselhos regulamentados:
  // - isRegulamentado: false → frontend mostra badge "não regulamentado" no perfil público
  // - requiresManualReview: true → nunca aprova automático, sempre passa por admin
  // - acceptedPracticeTypes: lista de "tipoPratica" aceitos no cadastro
  SEM_CONSELHO: {
    sigla: "SEM_CONSELHO",
    label: "Sem conselho regulamentado (psicanálise, terapia integrativa, hipnoterapia)",
    profissional: "Terapeuta",
    numberFormat: "—",
    capabilities: ["consulta", "anotacoes", "atestado-comparecimento"],
    eligibleTiers: ["profissional"],
    isRegulamentado: false,
    requiresManualReview: true,
    acceptedPracticeTypes: ["psicanalise", "terapia-integrativa", "hipnoterapia"]
  }
};

const ALL_SIGLAS = Object.keys(CONSELHOS);

// Conselhos que herdam do antigo modelo (campos legados crp/crm em
// therapists/{uid}). Leitores antigos continuam funcionando.
const LEGACY_SIGLAS = ["CRP", "CRM"];

function normalizeSigla(input) {
  if (!input) return "";
  // CRFa vem como "CRFA" do toUpperCase — aceitamos ambas grafias.
  return String(input).trim().toUpperCase().replace(/^CRFA$/, "CRFA");
}

function getConselho(sigla) {
  const key = normalizeSigla(sigla);
  return CONSELHOS[key] || null;
}

function isValidSigla(sigla) {
  return !!getConselho(sigla);
}

function hasCapability(sigla, capability) {
  const c = getConselho(sigla);
  if (!c) return false;
  return c.capabilities.includes(capability);
}

function canUseTier(sigla, tier) {
  const c = getConselho(sigla);
  if (!c) return false;
  return c.eligibleTiers.includes(tier);
}

// Resolve a sigla do conselho a partir de um doc therapist do Firestore.
// Prefere o campo novo `tipoConselho`. Se ausente, infere a partir dos campos
// legados crp/crm (cadastros pré-S21). Retorna sigla normalizada ou "".
function resolveSiglaFromTherapist(therapist) {
  if (!therapist) return "";
  if (therapist.tipoConselho && isValidSigla(therapist.tipoConselho)) {
    return normalizeSigla(therapist.tipoConselho);
  }
  if (therapist.crp) return "CRP";
  if (therapist.crm) return "CRM";
  return "";
}

// Atalho ergonômico: dado um doc therapist, responde se o conselho dele
// habilita a capability. Equivale a hasCapability(resolveSiglaFromTherapist(t), cap).
function therapistCan(therapist, capability) {
  return hasCapability(resolveSiglaFromTherapist(therapist), capability);
}

// True se o conselho exige escolha de subtipo no cadastro (ex.: CREFITO
// precisa distinguir fisio vs TO porque cada um tem prescriptionTypes diferentes).
function requiresSubtipo(sigla) {
  const c = getConselho(sigla);
  return !!(c && c.requiresSubtipo);
}

// Retorna os subtipos válidos pra um conselho (ex.: { fisio: {...}, to: {...} }).
// Vazio se o conselho não requer subtipo.
function getSubtipos(sigla) {
  const c = getConselho(sigla);
  return c?.subtipos || {};
}

// Valida se uma string é um subtipo aceito pro conselho.
function isValidSubtipo(sigla, subtipo) {
  if (!subtipo) return false;
  const subs = getSubtipos(sigla);
  return Object.prototype.hasOwnProperty.call(subs, String(subtipo).trim().toLowerCase());
}

// Lista os tipos de prescrição que o profissional pode emitir, baseado em
// conselho + subtipo (quando aplicável). Retorna array vazio se não tem
// capability "receita" ou se subtipo é exigido mas não foi definido.
function getPrescriptionTypesForTherapist(therapist) {
  const sigla = resolveSiglaFromTherapist(therapist);
  const c = getConselho(sigla);
  if (!c) return [];
  if (!c.capabilities?.includes("receita")) return [];

  // Conselho com subtipo (ex.: CREFITO): resolve via subtipo do therapist.
  if (c.requiresSubtipo) {
    const sub = String(therapist?.subtipoConselho || "").trim().toLowerCase();
    if (!sub || !c.subtipos?.[sub]) return [];
    return c.subtipos[sub].prescriptionTypes || [];
  }

  return c.prescriptionTypes || [];
}

// True se o profissional pode prescrever esse tipo específico.
// tipo aceito: "mip" | "insumo-injetavel" | "controlado".
function canPrescribeType(therapist, tipo) {
  const allowed = getPrescriptionTypesForTherapist(therapist);
  return allowed.includes(String(tipo || "").trim().toLowerCase());
}

const VALID_PRESCRIPTION_TYPES = ["mip", "insumo-injetavel", "controlado"];

function isValidPrescriptionType(tipo) {
  return VALID_PRESCRIPTION_TYPES.includes(String(tipo || "").trim().toLowerCase());
}

// True se a sigla é de um conselho regulamentado por lei federal
// (CRP/CRM/CRESS/CREFITO/CRFa/CRN/CRO/CREF). False pra SEM_CONSELHO.
function isRegulamentado(sigla) {
  const c = getConselho(sigla);
  if (!c) return false;
  return c.isRegulamentado !== false;
}

// True se este conselho exige revisão manual obrigatória (não aprova automático).
// Hoje só SEM_CONSELHO; pode ser estendido pra qualquer conselho que vire
// "alto risco" no futuro.
function requiresManualReview(sigla) {
  const c = getConselho(sigla);
  return !!(c && c.requiresManualReview);
}

// Lista de tipos de prática aceitos pra um conselho. Hoje só faz sentido
// pra SEM_CONSELHO (psicanalise/terapia-integrativa/hipnoterapia).
function acceptedPracticeTypes(sigla) {
  const c = getConselho(sigla);
  return c?.acceptedPracticeTypes || [];
}

// Valida que um "tipoPratica" submetido no cadastro é aceito pra essa sigla.
function isValidPracticeType(sigla, tipoPratica) {
  const list = acceptedPracticeTypes(sigla);
  if (list.length === 0) return false;
  return list.includes(String(tipoPratica || "").trim().toLowerCase());
}

module.exports = {
  CONSELHOS,
  ALL_SIGLAS,
  LEGACY_SIGLAS,
  VALID_PRESCRIPTION_TYPES,
  normalizeSigla,
  getConselho,
  isValidSigla,
  hasCapability,
  canUseTier,
  resolveSiglaFromTherapist,
  therapistCan,
  isRegulamentado,
  requiresManualReview,
  acceptedPracticeTypes,
  isValidPracticeType,
  requiresSubtipo,
  getSubtipos,
  isValidSubtipo,
  getPrescriptionTypesForTherapist,
  canPrescribeType,
  isValidPrescriptionType
};
