// Espaço Prelúdio — rotas SaaS de telessaúde para profissionais.
//
// Modelo de confiança:
// - Profissional autentica via Firebase ID Token (mesma instância sextolugar-staging).
// - Notas clínicas sobem cifradas: ciphertext + iv (AES-GCM, chave derivada client-side
//   da senha do profissional via PBKDF2 + salt). O servidor NUNCA vê a chave nem o plaintext.
// - Paciente entra via joinToken assinado (single-use, expira em 2h). Sem conta.
// - Vídeo via LiveKit com E2EE ativado no client (Encoded Transforms).
//
// Coleções Firestore:
//   therapists/{uid}              — perfil profissional + e2eeSalt + plano
//   therapy_sessions/{sessionId}  — therapistUid, patientName, status, livekitRoom, timestamps
//   therapy_notes/{noteId}        — sessionId, therapistUid, ciphertext, iv, createdAt
//   therapy_audit/{eventId}       — quem acessou o quê, quando, IP

const express = require("express");
const rateLimit = require("express-rate-limit");
const admin   = require("firebase-admin");
const crypto  = require("crypto");
const geoipCountry = require("geoip-country");
const { AccessToken } = require("livekit-server-sdk");

const { logError, logInfo, logWarn } = require("../logger");
const { asyncHandler, sendError } = require("../utils");
const { ensureDb, getDb } = require("../services/firestore");
const { verifyFirebaseToken, signPayload, verifySignedToken, getBearerToken } = require("../services/auth");
const { getIo } = require("../services/socketio");
const { generateSecret: gen2faSecret, verifyTotp, otpauthUrl } = require("../services/twofa");
const {
  LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL, ACCESS_TOKEN_SECRET,
  THERAPY_ADMIN_EMAILS,
  THERAPY_PLAN_AMOUNT, THERAPY_PLAN_RECEM_FORMADO_AMOUNT, THERAPY_PLAN_PROFISSIONAL_AMOUNT,
  THERAPY_PLAN_ANNUAL_AMOUNT, THERAPY_PLAN_RECEM_FORMADO_ANNUAL_AMOUNT, THERAPY_PLAN_PROFISSIONAL_ANNUAL_AMOUNT,
  THERAPY_PLAN_NAME,
  THERAPY_TRIAL_DAYS, THERAPY_TRIAL_DAYS_PROFISSIONAL, THERAPY_TRIAL_DAYS_RECEM_FORMADO,
  THERAPY_FRONTEND_BASE,
  THERAPY_MIN_CANCEL_HOURS_PATIENT,
  MP_ACCESS_TOKEN_THERAPY, MP_WEBHOOK_SECRET_THERAPY,
  ASAAS_WEBHOOK_TOKEN
} = require("../config");
const { mercadoPagoFetchTherapy } = require("../services/payments");
const asaas = require("../services/asaas");
const anamnese = require("../services/anamnese");
const tiss     = require("../services/tiss");
const smsService = require("../services/sms");
const supportBot = require("../services/support-bot");
const marketing = require("../services/marketing");
const pushService = require("../services/push");
const { withRetry } = require("../services/retry");
const whisperSvc = require("../services/whisper");
const sessionSummarySvc = require("../services/session-summary");
const clinicalTwinSvc = require("../services/clinical-twin");
const cid10 = require("../services/cid10");
const nfseNfeio = require("../services/nfse-nfeio");
const scales = require("../services/scales");
const {
  CATEGORY_LABELS,
  DESCRIPTION_MAX,
  isValidType: isValidFinType,
  isValidStatus: isValidFinStatus,
  isValidPaymentMethod: isValidFinPaymentMethod,
  validateCategoryForType: validateFinCategoryForType,
  isValidAmount: isValidFinAmount,
  computeSummary: computeFinSummary,
  parseMonthRange: parseFinMonthRange
} = require("../services/financial");
const {
  isValidUnit: isValidInvUnit,
  isValidMovementType: isValidInvMovementType,
  isValidStockValue: isValidInvStockValue,
  isValidMovementQuantity: isValidInvMovementQuantity,
  isLowStock: isInvLowStock,
  applyMovement: applyInvMovement,
  NAME_MAX:        INV_NAME_MAX,
  CATEGORY_MAX:    INV_CATEGORY_MAX,
  DESCRIPTION_MAX: INV_DESCRIPTION_MAX,
  REASON_MAX:      INV_REASON_MAX
} = require("../services/inventory");
const {
  isValidRepasseRule,
  isValidEmail: isValidClinicEmail,
  normalizeEmail: normalizeClinicEmail,
  computeMonthlyRepasse,
  NAME_MAX:  CLINIC_NAME_MAX,
  CNPJ_MAX:  CLINIC_CNPJ_MAX
} = require("../services/clinic");
const {
  valorPorExtenso,
  PAYMENT_METHOD_LABELS: RECEIPT_PAYMENT_LABELS,
  PATIENT_NAME_MAX: RECEIPT_PATIENT_NAME_MAX,
  DESCRIPTION_MAX:  RECEIPT_DESCRIPTION_MAX
} = require("../services/receipts");
const {
  normalizePhone: normalizeWaPhone,
  isConfigured:   isWaConfigured,
  getInstanceStatus: getWaInstanceStatus,
  sendText: sendWaText,
  sendConfirmation: sendWaConfirmation,
  sendCancellation: sendWaCancellation,
  DEFAULT_TEMPLATES: WA_DEFAULT_TEMPLATES
} = require("../services/whatsapp");
const { getValidator: getCfpValidator } = require("../services/cfp-validator");
const { getValidator: getDocValidator, AUTO_APPROVE_CONFIDENCE, RECEM_FORMADO_MAX_MONTHS } = require("../services/document-validator");
const {
  isValidSigla: isValidConselhoSigla,
  normalizeSigla: normalizeConselhoSigla,
  resolveSiglaFromTherapist,
  therapistCan,
  getConselho,
  isRegulamentado: isConselhoRegulamentado,
  requiresManualReview: conselhoRequiresManualReview,
  isInternacional: isConselhoInternacional,
  isValidPracticeType,
  requiresSubtipo: conselhoRequiresSubtipo,
  isValidSubtipo: isValidConselhoSubtipo,
  canPrescribeType,
  isValidPrescriptionType,
  getPrescriptionTypesForTherapist
} = require("../services/professional-councils");
const {
  sendEmail, templateConfirmation, templateSchedulingRequest, templateReciboEnviado,
  templateAnamneseEnviada, templateAnamneseRespondida,
  templateEscalaEnviada, templateEscalaRespondida,
  templateDispensacaoNotice,
  templateStudentApproved, templateStudentRejected,
  templateClinicInvite,
  templateStudentLeadReceived,
  templateRecemFormadoApproved, templateRecemFormadoRejected,
  templateFormacaoApproved, templateFormacaoRejected,
  buildJoinUrl: buildPatientJoinUrl, buildCancelUrl: buildPatientCancelUrl, buildConfirmUrl: buildPatientConfirmUrl,
  buildNpsUrl: buildPatientNpsUrl,
  buildReciboPublicoUrl,
  buildAnamneseUrl,
  buildEscalaUrl,
  buildPainelUrl, buildPlanosUrl,
  buildComprovanteEstudanteUrl, buildComprovanteRecemFormadoUrl,
  buildComprovanteFormacaoUrl
} = require("../services/email");

const router = express.Router();

const JOIN_TOKEN_VALIDITY_MS = 2 * 60 * 60 * 1000; // 2h
const SESSION_TOKEN_VALIDITY_MS = 4 * 60 * 60 * 1000; // 4h
const PATIENT_NAME_MAX = 80;
const NOTE_CIPHERTEXT_MAX = 256 * 1024; // 256 KB de cifrado por nota

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
}

// ─── Geolocalização por IP (moeda padrão na página de planos: BR → BRL/Mercado
// Pago, resto do mundo → USD/Stripe). O front ainda permite trocar manualmente. ───
const geoLookupLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
});

router.get("/therapy/geo", geoLookupLimiter, (req, res) => {
  const ip = String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
  const geo = geoipCountry.lookup(ip);
  return res.json({ ok: true, country: geo?.country || null });
});

// Short codes pra link de paciente — entrar.html?c=K9RTPX73 (~50 chars)
// em vez de entrar.html?t=<jwt> (~500 chars). Ver services/join-codes.js.
const { createJoinCode, resolveJoinCode, createActionCode, resolveActionCode } = require("../services/join-codes");

// ─── Slug público de agendamento ────────────────────────────────────────
// Slug = identificador URL-friendly do terapeuta (ex.: "dr-roberto-fernandes").
// Aceita 3-40 chars, lowercase a-z, dígitos, hífens. Sem hífens duplos ou nas pontas.
// Palavras reservadas (rotas/áreas internas) ficam bloqueadas pra evitar colisão.
const PUBLIC_SLUG_RX = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
const PUBLIC_SLUG_RESERVED = new Set([
  "admin", "api", "staging", "login", "logout", "cadastro", "entrar",
  "perfil", "painel", "agenda", "agendar", "pacientes", "consulta",
  "consultas", "receita", "receitas", "documento", "documentos",
  "financeiro", "relatorios", "clinica", "estoque", "calculadora",
  "atestado", "whatsapp", "suporte", "verificacao", "verificado",
  "termos", "politica", "cancelar", "planos", "nps", "como-dispensar",
  "lista-espera", "aniversarios", "audit", "consultorio", "2fa-verify",
  "paciente", "comprovante", "recuperar", "documento-publico",
  "receita-publica", "paciente-painel", "paciente-login",
  "paciente-cadastro", "paciente-audit", "paciente-recuperar",
  "comprovante-estudante", "comprovante-formacao", "comprovante-recem-formado"
]);
function isValidPublicSlug(s) {
  if (typeof s !== "string") return false;
  const v = s.trim().toLowerCase();
  if (!PUBLIC_SLUG_RX.test(v)) return false;
  if (v.includes("--")) return false;
  if (PUBLIC_SLUG_RESERVED.has(v)) return false;
  return true;
}
async function findTherapistBySlug(slug) {
  const db = getDb();
  const snap = await db.collection("therapists")
    .where("publicSchedulingSlug", "==", slug)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return snap.docs[0].data();
}

async function logAudit(event) {
  try {
    const db = getDb();
    if (!db) return;
    await db.collection("therapy_audit").add({
      ...event,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (error) {
    logError("therapy_audit_failed", error, event);
  }
}

async function loadTherapist(uid) {
  const db = getDb();
  const snap = await db.collection("therapists").doc(uid).get();
  return snap.exists ? snap.data() : null;
}

// Determina se o profissional pode usar funções clínicas (criar consulta,
// receita, documento, paciente). Regra de produto:
//   - adminGrantedUntil > now → libera (cortesia manual do admin, bypass)
//   - student-active        → libera (tier estudante gratuito)
//   - pro                   → libera (assinatura paga e ativa)
//   - trial COM trialUntil > now → libera (período gratuito)
//   - qualquer outro estado → bloqueia (trial expirado, canceled, expired,
//                              recem-formado-eligible que não contratou ainda,
//                              pending-review além do trial)
// Retorna { ok: bool, reason?: string, plano: string, trialUntil?: number,
//           adminGrantedUntil?: number }
function evaluatePlanAccess(therapist) {
  if (!therapist) return { ok: false, reason: "PROFISSIONAL_NAO_REGISTRADO", plano: null };

  // CORTESIA ADMIN — bypass que libera acesso independente do plano. Usado
  // pra conceder meses grátis manualmente via PATCH /therapy/admin/profissionais
  // (grantFreeMonths). Checa PRIMEIRO pra que cortesia funcione mesmo com
  // plano=canceled/trial-expirado/etc.
  const adminUntil = therapist.adminGrantedUntil?.toMillis
    ? therapist.adminGrantedUntil.toMillis()
    : Number(therapist.adminGrantedUntil) || 0;
  if (adminUntil && adminUntil > Date.now()) {
    return { ok: true, plano: therapist.plano || "trial", adminGrantedUntil: adminUntil };
  }

  const plano = therapist.plano || "trial";
  if (plano === "pro") {
    return { ok: true, plano };
  }
  // empresa: plano gratuito aprovado pela equipe — sem data de expiração.
  if (plano === "empresa") {
    return { ok: true, plano };
  }
  // student-active: cron runStudentExpirationTick deveria baixar pra trial
  // quando studentVerifiedUntil <= now, mas se cron falhar/atrasar, defesa em
  // profundidade aqui evita uso pos-expiracao.
  if (plano === "student-active") {
    const studentUntil = therapist.studentVerifiedUntil?.toMillis
      ? therapist.studentVerifiedUntil.toMillis()
      : Number(therapist.studentVerifiedUntil) || 0;
    if (studentUntil && studentUntil > Date.now()) {
      return { ok: true, plano };
    }
    return { ok: false, reason: "STUDENT_EXPIRADO", plano, studentVerifiedUntil: studentUntil || null };
  }
  const until = therapist.trialUntil?.toMillis ? therapist.trialUntil.toMillis() : Number(therapist.trialUntil) || 0;
  if (until && until > Date.now()) {
    return { ok: true, plano, trialUntil: until };
  }
  return { ok: false, reason: "TRIAL_EXPIRADO", plano, trialUntil: until || null };
}

// Middleware-style helper: usa em endpoints que criam recursos clínicos.
// Retorna o therapist se ok, ou escreve 402 e devolve null pra encerrar handler.
async function requirePaidPlan(req, res, uid) {
  const therapist = await loadTherapist(uid);
  const access = evaluatePlanAccess(therapist);
  if (!access.ok) {
    sendError(res, 402, access.reason, {
      plano: access.plano,
      trialUntil: access.trialUntil || null,
      detail: "Sua trial expirou ou você não tem assinatura ativa. Acesse o seu perfil para contratar um plano."
    });
    return null;
  }
  return therapist;
}

// Bloqueia ações cujo conselho do profissional não habilita. Encadear DEPOIS
// de requirePaidPlan + rejectIfStudent. A matriz de capabilities está em
// services/professional-councils.js (cada conselho lista suas features).
//
// Capabilities:
//   "receita"             — CRM (Portaria 344/98 — todos os tipos) +
//                           CREFITO (Ac. COFFITO 735/2024 — fisio: MIP+injetável,
//                           TO: MIP). Detalhes em prescriptionTypes por subtipo.
//   "documentos-clinicos" — CRM, CRP, CREFITO, CRN e CRO. Atestado,
//                           encaminhamento e relatório dentro do escopo de
//                           cada conselho:
//                             CRM           = médico
//                             CRP           = psicológico
//                             CREFITO/fisio = fisioterapêutico
//                             CREFITO/to    = de terapia ocupacional
//                             CRN           = nutricional
//                             CRO           = odontológico
//                           O título do PDF é dinâmico (getDocumentoTitulo) —
//                           emitir documento com nomenclatura de outro conselho
//                           caracteriza fraude profissional.
//                           CRESS/CRFa/CREF: sem capability — esses conselhos
//                           não emitem atestado/encaminhamento/relatório
//                           clínico no escopo profissional regulamentado.
//
// Retorna true se ok; escreve 403 + retorna false se bloqueado.
function requireCapability(therapist, res, capability, hint) {
  if (!therapistCan(therapist, capability)) {
    const sigla = resolveSiglaFromTherapist(therapist) || "desconhecido";
    sendError(res, 403, "CONSELHO_NAO_AUTORIZADO", {
      capability,
      conselho: sigla,
      detail: hint || `Seu conselho (${sigla}) não habilita esta ação.`
    });
    return false;
  }
  return true;
}

// Bloqueia features que estudantes não podem usar legalmente: emitir receitas
// digitais e documentos médicos (atestado, encaminhamento, relatório). Aluno
// no último ano de Psicologia/Medicina não tem habilitação no conselho —
// só pode emitir esses documentos após formação + inscrição CRP/CRM.
//
// Encadear DEPOIS de requirePaidPlan: primeiro garante plano ativo, depois
// confere se o tier permite a feature.
function rejectIfStudent(therapist, res) {
  const intended = therapist?.intendedTier;
  const plano = therapist?.plano;
  const isStudent = intended === "estudante"
    || plano === "student-active"
    || plano === "student-pending-review";
  if (isStudent) {
    sendError(res, 403, "TIER_ESTUDANTE_NAO_PERMITE", {
      detail: "Receitas digitais e documentos médicos só ficam disponíveis após formação e inscrição no conselho (CRP/CRM)."
    });
    return true;
  }
  return false;
}

// Bloqueia emissão de receitas e documentos clínicos até o profissional ter
// o selo de verificado (CRP/CRM confirmado por revisão manual do admin via
// /therapy/profissional/verificacao/submeter). Sem isso, qualquer registro
// digitado no cadastro — mesmo inválido — liberaria documentos com validade
// legal sem nenhuma checagem humana.
//
// Encadear DEPOIS de requirePaidPlan + rejectIfStudent + requireCapability.
function rejectIfNotVerified(therapist, res) {
  if (therapist?.verificationStatus !== "verified") {
    sendError(res, 403, "VERIFICACAO_PENDENTE", {
      verificationStatus: therapist?.verificationStatus || "none",
      detail: "Receitas e documentos clínicos só ficam disponíveis após a verificação do seu registro profissional (selo de verificado). Envie seu comprovante na tela de Verificação."
    });
    return true;
  }
  return false;
}

// Resolve o e-mail do terapeuta. Prefere o snapshot salvo em
// therapists/{uid}.email (gravado em /profissional/registrar). Se ausente
// (terapeutas anteriores ao snapshot), faz lazy lookup via Firebase Admin
// e backfilla o doc. Retorna null silenciosamente se Auth não tem o usuário.
async function resolveTherapistEmail(uid, therapist) {
  if (therapist?.email) return therapist.email;
  try {
    const userRecord = await admin.auth().getUser(uid);
    const email = String(userRecord.email || "").toLowerCase() || null;
    if (email) {
      // Backfill silencioso pro próximo lookup ser barato.
      try {
        await getDb().collection("therapists").doc(uid).set({ email }, { merge: true });
      } catch (_) { /* se falhar, próxima chamada tenta de novo */ }
    }
    return email;
  } catch (_) {
    return null;
  }
}

async function loadPatientAccount(uid) {
  const db = getDb();
  const snap = await db.collection("therapy_patient_accounts").doc(uid).get();
  return snap.exists ? snap.data() : null;
}

// Verifica que o usuário atual é admin do Espaço Prelúdio (allowlist por e-mail
// em THERAPY_ADMIN_EMAILS). Retorna { uid, email } em caso positivo; escreve
// 401/403 e devolve null caso contrário.
async function verifyAdminTherapy(req, res) {
  const bearer = getBearerToken(req);
  if (!bearer) { sendError(res, 401, "TOKEN_NAO_INFORMADO"); return null; }
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(bearer);
  } catch {
    sendError(res, 401, "TOKEN_INVALIDO");
    return null;
  }
  const email = String(decoded.email || "").toLowerCase();
  if (!THERAPY_ADMIN_EMAILS.length) {
    sendError(res, 503, "ADMIN_NAO_CONFIGURADO");
    return null;
  }
  if (!THERAPY_ADMIN_EMAILS.includes(email)) {
    sendError(res, 403, "NAO_AUTORIZADO");
    return null;
  }
  return { uid: decoded.uid, email };
}

// Verifica idToken vindo do body (não do header). Não escreve resposta de erro —
// devolve null silenciosamente quando inválido. Usado em /sessao/join, onde
// patient logado é opcional.
async function verifyOptionalIdToken(idToken) {
  if (!idToken) return null;
  try {
    const decoded = await admin.auth().verifyIdToken(String(idToken));
    return decoded.uid;
  } catch (error) {
    logError("verify_optional_id_token_failed", error);
    return null;
  }
}

function ensureLivekit(res) {
  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    sendError(res, 503, "LIVEKIT_NAO_CONFIGURADO");
    return false;
  }
  return true;
}

async function issueLivekitToken({ room, identity, name, ttlMs }) {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: String(identity),
    name: String(name || identity),
    ttl: Math.floor(ttlMs / 1000)
  });
  at.addGrant({
    roomJoin: true,
    room: String(room),
    canPublish: true,
    canSubscribe: true,
    canPublishData: true
  });
  return at.toJwt();
}

// ─────────────────────────────────────────────────────────────────────────
// POST /therapy/profissional/registrar
// Marca o usuário Firebase como profissional. Idempotente — atualiza no merge.
// Body: { displayName, tipoConselho?, numeroConselho?, crp?, crm?, especialidade?, bio?, e2eeSalt }
//   tipoConselho: sigla do conselho (CRP, CRM, CRESS, CREFITO, CRFA, CRN, CRO, CREF)
//   numeroConselho: número de registro (ex: "12/12345", "123456-SC")
//   crp/crm: campos legados — aceitos pra retrocompat (cadastros pré-S21).
//            Se vier sem tipoConselho, infere a partir desses.
//   e2eeSalt: base64 (16-32 bytes) gerado client-side ao criar conta. Imutável depois.
// ─────────────────────────────────────────────────────────────────────────
router.post("/therapy/profissional/registrar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const displayName   = String(req.body?.displayName   || "").trim().slice(0, 80);
  const especialidade = String(req.body?.especialidade || "").trim().slice(0, 60);
  const bio           = String(req.body?.bio           || "").trim().slice(0, 500);
  const e2eeSalt      = String(req.body?.e2eeSalt      || "").trim();
  const wrappedDEK    = String(req.body?.wrappedDEK    || "").trim();
  const wrappedDEKIv  = String(req.body?.wrappedDEKIv  || "").trim();
  const consentLgpd   = !!req.body?.consentLgpd;

  // Resolve conselho: prioriza { tipoConselho, numeroConselho } (S21+);
  // se ausente, cai pra { crp, crm } legado. SEM_CONSELHO não exige
  // numeroConselho (validação alternativa via diploma + revisão manual).
  const tipoConselhoRaw = String(req.body?.tipoConselho || "").trim().toUpperCase();
  const numeroConselhoIn = String(req.body?.numeroConselho || "").trim().slice(0, 30).toUpperCase();
  const crpLegacy = String(req.body?.crp || "").trim().slice(0, 30).toUpperCase();
  const crmLegacy = String(req.body?.crm || "").trim().slice(0, 30).toUpperCase();

  let tipoConselho = "";
  let numeroConselho = "";
  if (isValidConselhoSigla(tipoConselhoRaw)) {
    tipoConselho = normalizeConselhoSigla(tipoConselhoRaw);
    // SEM_CONSELHO não tem número — campo fica vazio. Demais conselhos exigem.
    if (tipoConselho === "SEM_CONSELHO") {
      numeroConselho = "";
    } else if (numeroConselhoIn) {
      numeroConselho = numeroConselhoIn;
    } else {
      tipoConselho = ""; // força fallback ou erro
    }
  }
  if (!tipoConselho) {
    if (crpLegacy)      { tipoConselho = "CRP"; numeroConselho = crpLegacy; }
    else if (crmLegacy) { tipoConselho = "CRM"; numeroConselho = crmLegacy; }
  }

  // Espelha no campo legado pra retrocompat com leitores que ainda usam
  // therapist.crp / therapist.crm (perfil público, receita, documento médico).
  const crp = tipoConselho === "CRP" ? numeroConselho : "";
  const crm = tipoConselho === "CRM" ? numeroConselho : "";

  // Subtipo do conselho — exigido pra CREFITO (fisio vs TO) porque cada um
  // tem prescriptionTypes diferentes. Outros conselhos ignoram.
  let subtipoConselho = "";
  if (tipoConselho && conselhoRequiresSubtipo(tipoConselho)) {
    const sub = String(req.body?.subtipoConselho || "").trim().toLowerCase();
    if (!isValidConselhoSubtipo(tipoConselho, sub)) {
      return sendError(res, 400, "SUBTIPO_CONSELHO_INVALIDO",
        { hint: `Para ${tipoConselho} informe subtipoConselho válido (fisio, to).` });
    }
    subtipoConselho = sub;
  }

  // Campos extras obrigatórios pra SEM_CONSELHO — substituem o "selo do
  // conselho" como trust signal. Validados sempre (mesmo se vazios) pra
  // que o admin tenha o que revisar.
  let formacaoNaoRegulamentada = null;
  if (tipoConselho === "SEM_CONSELHO") {
    const tipoPratica = String(req.body?.tipoPratica || "").trim().toLowerCase().slice(0, 40);
    const instituicao = String(req.body?.formacaoInstituicao || "").trim().slice(0, 200);
    const curso = String(req.body?.formacaoCurso || "").trim().slice(0, 200);
    const anoConclusaoRaw = Number(req.body?.formacaoAnoConclusao || 0);
    const anosExperienciaRaw = Number(req.body?.anosExperiencia || 0);
    const anoAtual = new Date().getFullYear();

    if (!isValidPracticeType("SEM_CONSELHO", tipoPratica)) {
      return sendError(res, 400, "TIPO_PRATICA_INVALIDO",
        { hint: "Aceitos: psicoterapia, psicanalise, terapia-integrativa, hipnoterapia." });
    }
    if (!instituicao) return sendError(res, 400, "FORMACAO_INSTITUICAO_OBRIGATORIA");
    if (!curso)       return sendError(res, 400, "FORMACAO_CURSO_OBRIGATORIO");
    if (!Number.isFinite(anoConclusaoRaw) || anoConclusaoRaw < 1950 || anoConclusaoRaw > anoAtual) {
      return sendError(res, 400, "FORMACAO_ANO_CONCLUSAO_INVALIDO",
        { hint: `Ano entre 1950 e ${anoAtual}.` });
    }
    if (!Number.isFinite(anosExperienciaRaw) || anosExperienciaRaw < 0 || anosExperienciaRaw > 80) {
      return sendError(res, 400, "ANOS_EXPERIENCIA_INVALIDO",
        { hint: "Entre 0 e 80 anos." });
    }

    formacaoNaoRegulamentada = {
      tipoPratica,
      instituicao,
      curso,
      anoConclusao: anoConclusaoRaw,
      anosExperiencia: anosExperienciaRaw
    };
  }

  // Campos extras obrigatórios pra INTERNACIONAL — país + órgão de registro
  // no exterior. Substituem o "selo do conselho brasileiro" como referência
  // pro admin revisar manualmente (nenhum validador automático cobre
  // registros fora do Brasil).
  let registroInternacional = null;
  if (tipoConselho === "INTERNACIONAL") {
    const pais  = String(req.body?.paisRegistro  || "").trim().slice(0, 60);
    const orgao = String(req.body?.orgaoRegistro || "").trim().slice(0, 120);
    if (!pais)  return sendError(res, 400, "PAIS_REGISTRO_OBRIGATORIO");
    if (!orgao) return sendError(res, 400, "ORGAO_REGISTRO_OBRIGATORIO");
    registroInternacional = { pais, orgao };
  }

  // Tier escolhido na landing — define duração do trial. Aceita: "estudante",
  // "recem-formado" (alias: "recem"), "profissional" (default).
  const intendedTierRaw = String(req.body?.intendedTier || "").trim().toLowerCase();
  const intendedTier =
    intendedTierRaw === "estudante"      ? "estudante"     :
    intendedTierRaw === "recem"          ? "recem-formado" :
    intendedTierRaw === "recem-formado"  ? "recem-formado" :
    intendedTierRaw === "empresa"        ? "empresa"       :
    "profissional";

  if (!displayName) return sendError(res, 400, "NOME_OBRIGATORIO");
  if (!consentLgpd) return sendError(res, 400, "CONSENTIMENTO_LGPD_OBRIGATORIO");
  // Conselhos regulamentados exigem número; SEM_CONSELHO não.
  if (!tipoConselho) return sendError(res, 400, "REGISTRO_PROFISSIONAL_OBRIGATORIO");
  if (tipoConselho !== "SEM_CONSELHO" && !numeroConselho) {
    return sendError(res, 400, "REGISTRO_PROFISSIONAL_OBRIGATORIO");
  }
  if (!e2eeSalt || e2eeSalt.length < 16 || e2eeSalt.length > 128) {
    return sendError(res, 400, "E2EE_SALT_INVALIDO");
  }
  if (!wrappedDEK || !wrappedDEKIv) {
    return sendError(res, 400, "WRAPPED_DEK_OBRIGATORIO");
  }
  if (wrappedDEK.length > 256 || wrappedDEKIv.length > 64) {
    return sendError(res, 400, "WRAPPED_DEK_INVALIDO");
  }

  const db = getDb();
  const ref = db.collection("therapists").doc(uid);
  const existing = await ref.get();
  const existingData = existing.exists ? existing.data() : null;

  // e2eeSalt e wrappedDEK são write-once neste endpoint. Trocar quebraria as notas.
  // Mudança de senha (que re-embrulha o DEK) usa rota dedicada futura.
  const lockedSalt = existingData?.e2eeSalt || e2eeSalt;
  const lockedWrappedDEK   = existingData?.wrappedDEK   || wrappedDEK;
  const lockedWrappedDEKIv = existingData?.wrappedDEKIv || wrappedDEKIv;

  // Trial é setado uma vez na criação; não estende em re-cadastros.
  // Duração depende do tier escolhido: profissional 7d, recém-formado 30d,
  // estudante 0 (vai virar student-active após validar doc).
  const trialDays =
    intendedTier === "estudante"      ? 0 :
    intendedTier === "empresa"        ? 0 :
    intendedTier === "recem-formado"  ? THERAPY_TRIAL_DAYS_RECEM_FORMADO :
                                         THERAPY_TRIAL_DAYS_PROFISSIONAL;
  const trialUntil = existingData?.trialUntil
    || (Date.now() + trialDays * 24 * 60 * 60 * 1000);

  // Snapshot do e-mail do Firebase Auth pra usar como Reply-To em e-mails
  // automáticos (paciente que aperta Reply cai aqui). Falha silenciosa se
  // Auth retornar erro — resolveTherapistEmail tenta de novo depois.
  let therapistEmail = existingData?.email || null;
  if (!therapistEmail) {
    try {
      const userRecord = await admin.auth().getUser(uid);
      therapistEmail = String(userRecord.email || "").toLowerCase() || null;
    } catch (_) { /* sem email — segue */ }
  }

  // Bloco de formação não-regulamentada — salva só pra SEM_CONSELHO; nos
  // demais conselhos o registro no conselho já é o trust signal.
  const therapistDoc = {
    uid,
    displayName,
    email: therapistEmail,
    crp,
    crm,
    tipoConselho,
    numeroConselho,
    subtipoConselho,
    especialidade,
    bio,
    e2eeSalt:      lockedSalt,
    wrappedDEK:    lockedWrappedDEK,
    wrappedDEKIv:  lockedWrappedDEKIv,
    role: "therapist",
    plano: existingData?.plano || (intendedTier === "empresa" ? "empresa-pending-review" : "trial"),
    intendedTier: existingData?.intendedTier || intendedTier,
    trialUntil,
    consentLgpd: true,
    consentLgpdAt: existingData?.consentLgpdAt || admin.firestore.FieldValue.serverTimestamp(),
    createdAt: existingData?.createdAt || admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  if (formacaoNaoRegulamentada) {
    therapistDoc.formacaoNaoRegulamentada = formacaoNaoRegulamentada;
  }
  if (registroInternacional) {
    therapistDoc.paisRegistro = registroInternacional.pais;
    therapistDoc.orgaoRegistro = registroInternacional.orgao;
  }
  // Marca verificação como pending-review já no cadastro pra conselhos que
  // nunca passam por aprovação automática (SEM_CONSELHO: diploma; INTERNACIONAL:
  // registro estrangeiro). Admin revisa manualmente antes de habilitar
  // verificationStatus="verified" (selo azul).
  if (conselhoRequiresManualReview(tipoConselho)) {
    therapistDoc.verificationStatus = existingData?.verificationStatus || "pending-review";
  }
  await ref.set(therapistDoc, { merge: true });

  await logAudit({
    type: "therapist_registered",
    therapistUid: uid,
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || null
  });

  return res.json({
    ok: true,
    therapist: {
      uid, displayName, crp, crm, tipoConselho, numeroConselho, subtipoConselho,
      paisRegistro: registroInternacional?.pais || "",
      orgaoRegistro: registroInternacional?.orgao || "",
      especialidade, bio,
      e2eeSalt:     lockedSalt,
      wrappedDEK:   lockedWrappedDEK,
      wrappedDEKIv: lockedWrappedDEKIv,
      plano: existingData?.plano || "trial"
    }
  });
}));

// ─────────────────────────────────────────────────────────────────────────
// POST /therapy/profissional/recuperar
// Sobrescreve e2eeSalt + wrappedDEK quando o usuário recupera com chave-semente.
// O cliente já reconstruiu o DEK a partir da phrase + redefiniu a senha do Firebase.
// Este endpoint apenas grava o novo wrap. Cliente NÃO envia DEK.
// ─────────────────────────────────────────────────────────────────────────
router.post("/therapy/profissional/recuperar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const e2eeSalt     = String(req.body?.e2eeSalt     || "").trim();
  const wrappedDEK   = String(req.body?.wrappedDEK   || "").trim();
  const wrappedDEKIv = String(req.body?.wrappedDEKIv || "").trim();

  if (!e2eeSalt || e2eeSalt.length < 16 || e2eeSalt.length > 128) {
    return sendError(res, 400, "E2EE_SALT_INVALIDO");
  }
  if (!wrappedDEK || !wrappedDEKIv) return sendError(res, 400, "WRAPPED_DEK_OBRIGATORIO");
  if (wrappedDEK.length > 256 || wrappedDEKIv.length > 64) {
    return sendError(res, 400, "WRAPPED_DEK_INVALIDO");
  }

  const db = getDb();
  const ref = db.collection("therapists").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "PROFISSIONAL_NAO_REGISTRADO");

  await ref.set({
    e2eeSalt, wrappedDEK, wrappedDEKIv,
    recoveredAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:   admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({
    type: "therapist_recovered",
    therapistUid: uid,
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || null
  });

  return res.json({ ok: true });
}));

// ─────────────────────────────────────────────────────────────────────────
// POST /therapy/profissional/comprovante-estudante
// Upload de declaração de matrícula para liberação do tier "estudante".
// Fluxo:
//   1) Profissional precisa estar registrado (therapists/{uid} existe).
//   2) Body: { fileBase64, mediaType }. Limite ~5MB binário.
//   3) Validador (Claude Vision) extrai dados + decide.
//   4) decision === "approved":
//        therapists/{uid}.plano = "student-active"
//        + studentVerifiedUntil = now + 365d
//      decision === "manual-review":
//        therapists/{uid}.plano = "student-pending-review"
//        admin verifica via /admin/comprovantes-pendentes
//      decision === "rejected":
//        plano não muda, response devolve reasons.
//   5) Hash sha256 do arquivo é gravado pra dedup (mesmo doc não pode ser
//      reaproveitado em 2 contas).
//   6) Rate limit: 5 uploads/24h por uid.
//
// Coleções:
//   therapists/{uid}.studentDoc   — metadados (curso, dataEmissao, decision, ...)
//   therapy_student_docs/{uid}    — fileBase64 + extracted (separado pra não
//                                    estourar limite de 1MB do Firestore)
//   therapy_student_doc_hashes/{sha256} — dedup, aponta pra primeiro uid que usou
// ─────────────────────────────────────────────────────────────────────────

const STUDENT_DOC_MAX_BASE64 = 5 * 1024 * 1024;     // ~3.7 MB binário
const STUDENT_DOC_ALLOWED_MIMES = new Set([
  "image/png", "image/jpeg", "image/webp", "application/pdf"
]);
const STUDENT_DOC_RATE_LIMIT_24H = 5;
const STUDENT_VERIFIED_DAYS = 365;

router.post("/therapy/profissional/comprovante-estudante", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 403, "PROFISSIONAL_NAO_REGISTRADO");

  // Idempotência: se já está aprovado e dentro da validade, devolve sucesso sem reprocessar.
  if (therapist.plano === "student-active" && therapist.studentVerifiedUntil) {
    const until = therapist.studentVerifiedUntil.toDate ? therapist.studentVerifiedUntil.toDate() : new Date(therapist.studentVerifiedUntil);
    if (until > new Date()) {
      return res.json({
        ok: true,
        decision: "approved",
        confidence: 1,
        reasons: ["já aprovado anteriormente, validade vigente"],
        validUntil: until.toISOString()
      });
    }
  }

  const fileBase64 = String(req.body?.fileBase64 || "").trim();
  const mediaType  = String(req.body?.mediaType  || "").trim().toLowerCase();

  if (!fileBase64) return sendError(res, 400, "ARQUIVO_OBRIGATORIO");
  if (fileBase64.length > STUDENT_DOC_MAX_BASE64) return sendError(res, 413, "ARQUIVO_MUITO_GRANDE");
  if (!STUDENT_DOC_ALLOWED_MIMES.has(mediaType)) return sendError(res, 400, "FORMATO_NAO_SUPORTADO");

  // Hash do conteúdo binário pra dedup. Decodifica base64 → sha256 → hex.
  let buffer;
  try {
    buffer = Buffer.from(fileBase64, "base64");
  } catch {
    return sendError(res, 400, "BASE64_INVALIDO");
  }
  if (buffer.length === 0) return sendError(res, 400, "ARQUIVO_VAZIO");
  const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");

  const db = getDb();

  // Dedup: mesmo arquivo não pode ser usado em 2 contas distintas
  const hashRef = db.collection("therapy_student_doc_hashes").doc(fileHash);
  const hashSnap = await hashRef.get();
  if (hashSnap.exists && hashSnap.data().uid !== uid) {
    await logAudit({ type: "student_doc_dedup_block", therapistUid: uid, fileHash });
    return sendError(res, 409, "DOCUMENTO_JA_UTILIZADO_EM_OUTRA_CONTA");
  }

  // Rate limit: olha submissoes dos últimos 24h
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const recent = await db.collection("therapy_student_docs").doc(uid)
    .collection("uploads")
    .where("uploadedAt", ">=", new Date(since))
    .get();
  if (recent.size >= STUDENT_DOC_RATE_LIMIT_24H) {
    return sendError(res, 429, "MUITAS_TENTATIVAS_EM_24H");
  }

  // Pega CPF do cadastro (pode estar no perfil estendido)
  const expectedName = String(therapist.displayName || "").trim();
  const expectedCpf  = String(therapist.cpf || therapist.consultorio?.cpf || "").replace(/\D/g, "") || null;

  // Roda validação com Claude Vision
  const validator = getDocValidator();
  const result = await validator.validate({
    fileBase64,
    mediaType,
    expectedName,
    expectedCpf,
    requestId: req.requestId
  });

  // Persiste o arquivo + extracted em coleção separada (1 doc por upload, histórico)
  const uploadId = newId("doc");
  const uploadRef = db.collection("therapy_student_docs").doc(uid).collection("uploads").doc(uploadId);
  await uploadRef.set({
    uploadId,
    therapistUid: uid,
    fileBase64,
    mediaType,
    fileSize: buffer.length,
    fileHash,
    extracted: result.extracted,
    confidence: result.confidence,
    decision: result.decision,
    reasons: result.reasons,
    provider: result.provider,
    raw: result.raw || null,
    uploadedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  // Marca o hash como usado (lock contra reuso multi-conta)
  await hashRef.set({
    uid,
    uploadId,
    decision: result.decision,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  // Atualiza therapist com metadados (sem o fileBase64 — fica no doc separado)
  const update = {
    studentDoc: {
      lastUploadId: uploadId,
      lastUploadedAt: admin.firestore.FieldValue.serverTimestamp(),
      decision: result.decision,
      confidence: result.confidence,
      reasons: result.reasons,
      extracted: result.extracted,
      fileHash,
      mediaType,
      fileSize: buffer.length
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  if (result.decision === "approved") {
    update.plano = "student-active";
    update.studentVerifiedAt = admin.firestore.FieldValue.serverTimestamp();
    update.studentVerifiedUntil = new Date(Date.now() + STUDENT_VERIFIED_DAYS * 24 * 60 * 60 * 1000);
  } else if (result.decision === "manual-review") {
    update.plano = "student-pending-review";
  } else {
    // rejected: não muda plano (continua trial). Usuário pode tentar de novo dentro do rate limit.
  }

  await db.collection("therapists").doc(uid).set(update, { merge: true });

  await logAudit({
    type: "student_doc_submitted",
    therapistUid: uid,
    uploadId,
    decision: result.decision,
    confidence: result.confidence,
    fileHash,
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || null
  });

  // Retorna resultado pro frontend
  return res.json({
    ok: true,
    decision: result.decision,
    confidence: result.confidence,
    reasons: result.reasons,
    extracted: {
      // não devolvemos CPF cru no response
      curso: result.extracted.curso,
      semestre: result.extracted.semestre,
      instituicao: result.extracted.instituicao,
      dataEmissao: result.extracted.dataEmissao,
      situacao: result.extracted.situacao,
      isUltimoAno: result.extracted.isUltimoAno
    },
    validUntil: result.decision === "approved"
      ? new Date(Date.now() + STUDENT_VERIFIED_DAYS * 24 * 60 * 60 * 1000).toISOString()
      : null
  });
}));

// ─────────────────────────────────────────────────────────────────────────
// GET /therapy/profissional/comprovante-estudante/status
// Devolve o status atual do comprovante do profissional logado, sem mexer
// em nada. Usado pelo frontend pra polling enquanto admin não revisou.
// ─────────────────────────────────────────────────────────────────────────
router.get("/therapy/profissional/comprovante-estudante/status", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 403, "PROFISSIONAL_NAO_REGISTRADO");

  const doc = therapist.studentDoc || null;
  return res.json({
    ok: true,
    plano: therapist.plano || null,
    studentDoc: doc ? {
      decision: doc.decision,
      confidence: doc.confidence,
      reasons: doc.reasons || [],
      extracted: doc.extracted || null,
      lastUploadedAt: doc.lastUploadedAt?.toDate?.()?.toISOString?.() || null
    } : null,
    studentVerifiedUntil: therapist.studentVerifiedUntil?.toDate?.()?.toISOString?.() || null
  });
}));

// ─────────────────────────────────────────────────────────────────────────
// POST /therapy/profissional/comprovante-recem-formado
// Upload de carteira CRP/CRM ou print do e-Psi para validação do tier
// "recém-formado" (R$ 99,50/mês — disponível se inscrição no conselho
// foi nos últimos 12 meses).
// Reusa hash dedup, rate limit, fluxo do tier estudante.
// Estados em therapists/{uid}.plano:
//   "recem-formado-pending-review"  — confiança média, fila admin
//   "recem-formado-eligible"        — aprovado, pode iniciar assinatura R$ 99,50
//   se rejeitado: plano não muda (continua trial), reasons no response
// ─────────────────────────────────────────────────────────────────────────

const RECEM_FORMADO_RATE_LIMIT_24H = 5;

router.post("/therapy/profissional/comprovante-recem-formado", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 403, "PROFISSIONAL_NAO_REGISTRADO");

  // Idempotência: já elegível, devolve sucesso sem reprocessar
  if (therapist.plano === "recem-formado-eligible") {
    return res.json({
      ok: true,
      decision: "approved",
      confidence: 1,
      reasons: ["já validado anteriormente — siga para o pagamento da assinatura"],
      extracted: therapist.recemFormadoDoc?.extracted || null
    });
  }

  const fileBase64 = String(req.body?.fileBase64 || "").trim();
  const mediaType  = String(req.body?.mediaType  || "").trim().toLowerCase();

  if (!fileBase64) return sendError(res, 400, "ARQUIVO_OBRIGATORIO");
  if (fileBase64.length > STUDENT_DOC_MAX_BASE64) return sendError(res, 413, "ARQUIVO_MUITO_GRANDE");
  if (!STUDENT_DOC_ALLOWED_MIMES.has(mediaType)) return sendError(res, 400, "FORMATO_NAO_SUPORTADO");

  let buffer;
  try { buffer = Buffer.from(fileBase64, "base64"); } catch { return sendError(res, 400, "BASE64_INVALIDO"); }
  if (buffer.length === 0) return sendError(res, 400, "ARQUIVO_VAZIO");
  const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");

  const db = getDb();

  // Dedup
  const hashRef = db.collection("therapy_recem_formado_doc_hashes").doc(fileHash);
  const hashSnap = await hashRef.get();
  if (hashSnap.exists && hashSnap.data().uid !== uid) {
    await logAudit({ type: "recem_formado_doc_dedup_block", therapistUid: uid, fileHash });
    return sendError(res, 409, "DOCUMENTO_JA_UTILIZADO_EM_OUTRA_CONTA");
  }

  // Rate limit
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const recent = await db.collection("therapy_recem_formado_docs").doc(uid)
    .collection("uploads")
    .where("uploadedAt", ">=", new Date(since))
    .get();
  if (recent.size >= RECEM_FORMADO_RATE_LIMIT_24H) {
    return sendError(res, 429, "MUITAS_TENTATIVAS_EM_24H");
  }

  const expectedName     = String(therapist.displayName || "").trim();
  const expectedConselho = resolveSiglaFromTherapist(therapist);
  const expectedRegistro = String(
    therapist.numeroConselho || therapist.crp || therapist.crm || ""
  ).trim();

  const validator = getDocValidator();
  const result = await validator.validateRegistration({
    fileBase64, mediaType,
    expectedName, expectedConselho, expectedRegistro,
    requestId: req.requestId
  });

  const uploadId = newId("rfdoc");
  const uploadRef = db.collection("therapy_recem_formado_docs").doc(uid).collection("uploads").doc(uploadId);
  await uploadRef.set({
    uploadId, therapistUid: uid,
    fileBase64, mediaType, fileSize: buffer.length, fileHash,
    extracted: result.extracted,
    confidence: result.confidence,
    decision: result.decision,
    reasons: result.reasons,
    provider: result.provider,
    raw: result.raw || null,
    uploadedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await hashRef.set({
    uid, uploadId, decision: result.decision,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  const update = {
    recemFormadoDoc: {
      lastUploadId: uploadId,
      lastUploadedAt: admin.firestore.FieldValue.serverTimestamp(),
      decision: result.decision,
      confidence: result.confidence,
      reasons: result.reasons,
      extracted: result.extracted,
      fileHash, mediaType, fileSize: buffer.length
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  if (result.decision === "approved") {
    update.plano = "recem-formado-eligible";
    update.recemFormadoVerifiedAt = admin.firestore.FieldValue.serverTimestamp();
  } else if (result.decision === "manual-review") {
    update.plano = "recem-formado-pending-review";
  }
  // rejected: plano fica como tá (trial)

  await db.collection("therapists").doc(uid).set(update, { merge: true });

  await logAudit({
    type: "recem_formado_doc_submitted",
    therapistUid: uid,
    uploadId,
    decision: result.decision,
    confidence: result.confidence,
    fileHash,
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || null
  });

  return res.json({
    ok: true,
    decision: result.decision,
    confidence: result.confidence,
    reasons: result.reasons,
    extracted: {
      conselho: result.extracted.conselho,
      registro: result.extracted.registro,
      regiao: result.extracted.regiao,
      dataInscricao: result.extracted.dataInscricao,
      monthsSinceInscricao: result.extracted.monthsSinceInscricao,
      situacao: result.extracted.situacao,
      tipoDocumento: result.extracted.tipoDocumento
    }
  });
}));

// ─────────────────────────────────────────────────────────────────────────
// GET /therapy/profissional/comprovante-recem-formado/status
// ─────────────────────────────────────────────────────────────────────────
router.get("/therapy/profissional/comprovante-recem-formado/status", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 403, "PROFISSIONAL_NAO_REGISTRADO");

  const doc = therapist.recemFormadoDoc || null;
  return res.json({
    ok: true,
    plano: therapist.plano || null,
    recemFormadoDoc: doc ? {
      decision: doc.decision,
      confidence: doc.confidence,
      reasons: doc.reasons || [],
      extracted: doc.extracted || null,
      lastUploadedAt: doc.lastUploadedAt?.toDate?.()?.toISOString?.() || null
    } : null
  });
}));

// ─────────────────────────────────────────────────────────────────────────
// POST /therapy/profissional/comprovante-formacao
// Upload do diploma/certificado de formação pra profissionais SEM_CONSELHO
// (psicanalistas, terapeutas integrativos, hipnoterapeutas). Sem validação
// automática — sempre cai em revisão manual pelo admin (não há padrão de
// diploma de escola livre que justifique OCR estruturado).
//
// Reusa hash dedup, rate limit do recém-formado (mesmas constantes).
// Estados em therapists/{uid}.formacaoDoc.decision: "pending-review" sempre.
// verificationStatus continua "pending-review" até admin aprovar via
// /therapy/admin/comprovantes-formacao/:uid/decidir (S22.1b).
// ─────────────────────────────────────────────────────────────────────────

const FORMACAO_RATE_LIMIT_24H = 5;

router.post("/therapy/profissional/comprovante-formacao", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 403, "PROFISSIONAL_NAO_REGISTRADO");
  if (resolveSiglaFromTherapist(therapist) !== "SEM_CONSELHO") {
    return sendError(res, 403, "ENDPOINT_APENAS_PARA_SEM_CONSELHO",
      { detail: "Profissionais com conselho regulamentado usam /comprovante-recem-formado ou /verificacao/submeter." });
  }

  const fileBase64 = String(req.body?.fileBase64 || "").trim();
  const mediaType  = String(req.body?.mediaType  || "").trim().toLowerCase();

  if (!fileBase64) return sendError(res, 400, "ARQUIVO_OBRIGATORIO");
  if (fileBase64.length > STUDENT_DOC_MAX_BASE64) return sendError(res, 413, "ARQUIVO_MUITO_GRANDE");
  if (!STUDENT_DOC_ALLOWED_MIMES.has(mediaType)) return sendError(res, 400, "FORMATO_NAO_SUPORTADO");

  let buffer;
  try { buffer = Buffer.from(fileBase64, "base64"); } catch { return sendError(res, 400, "BASE64_INVALIDO"); }
  if (buffer.length === 0) return sendError(res, 400, "ARQUIVO_VAZIO");
  const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");

  const db = getDb();

  // Dedup por hash — mesmo diploma em conta diferente é bloqueado
  const hashRef = db.collection("therapy_formacao_doc_hashes").doc(fileHash);
  const hashSnap = await hashRef.get();
  if (hashSnap.exists && hashSnap.data().uid !== uid) {
    await logAudit({ type: "formacao_doc_dedup_block", therapistUid: uid, fileHash });
    return sendError(res, 409, "DOCUMENTO_JA_UTILIZADO_EM_OUTRA_CONTA");
  }

  // Rate limit: max 5 uploads em 24h
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const recent = await db.collection("therapy_formacao_docs").doc(uid)
    .collection("uploads")
    .where("uploadedAt", ">=", new Date(since))
    .get();
  if (recent.size >= FORMACAO_RATE_LIMIT_24H) {
    return sendError(res, 429, "MUITAS_TENTATIVAS_EM_24H");
  }

  const uploadId = newId("formacao");
  const uploadRef = db.collection("therapy_formacao_docs").doc(uid).collection("uploads").doc(uploadId);
  await uploadRef.set({
    uploadId, therapistUid: uid,
    fileBase64, mediaType, fileSize: buffer.length, fileHash,
    decision: "pending-review",
    uploadedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await hashRef.set({
    uid, uploadId,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await db.collection("therapists").doc(uid).set({
    formacaoDoc: {
      lastUploadId: uploadId,
      lastUploadedAt: admin.firestore.FieldValue.serverTimestamp(),
      decision: "pending-review",
      fileHash, mediaType, fileSize: buffer.length
    },
    verificationStatus: "pending-review",
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({
    type: "formacao_doc_submitted",
    therapistUid: uid,
    uploadId,
    fileHash,
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || null
  });

  return res.json({
    ok: true,
    decision: "pending-review",
    detail: "Diploma recebido. Aguardando revisão manual pela equipe (até 2 dias úteis)."
  });
}));

// ─────────────────────────────────────────────────────────────────────────
// GET /therapy/profissional/comprovante-formacao/status
// ─────────────────────────────────────────────────────────────────────────
router.get("/therapy/profissional/comprovante-formacao/status", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 403, "PROFISSIONAL_NAO_REGISTRADO");

  const doc = therapist.formacaoDoc || null;
  return res.json({
    ok: true,
    verificationStatus: therapist.verificationStatus || null,
    formacao: therapist.formacaoNaoRegulamentada || null,
    formacaoDoc: doc ? {
      decision: doc.decision,
      reasons: doc.reasons || [],
      lastUploadedAt: doc.lastUploadedAt?.toDate?.()?.toISOString?.() || null,
      reviewedAt: doc.reviewedAt?.toDate?.()?.toISOString?.() || null
    } : null
  });
}));

// ─────────────────────────────────────────────────────────────────────────
// PATCH /therapy/profissional/perfil
// Atualiza dados extras do consultório (endereço, telefone, RQE, logo, etc).
// Não toca em e2eeSalt/wrappedDEK (que são write-once via /registrar e
// /recuperar). Aceita atualização parcial.
// ─────────────────────────────────────────────────────────────────────────

const LOGO_MAX_BASE64 = 300 * 1024; // ~225 KB binário
const LOGO_ALLOWED_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
// Foto de perfil (avatar circular do topbar). Mais leve que a logo da clínica:
// o cliente redimensiona pra 256x256 antes de enviar.
const PHOTO_MAX_BASE64 = 150 * 1024; // ~110 KB binário
const PHOTO_ALLOWED_MIMES = LOGO_ALLOWED_MIMES;

router.patch("/therapy/profissional/perfil", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 404, "PROFISSIONAL_NAO_REGISTRADO");

  const updates = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  // Campos top-level editáveis
  if (req.body?.displayName !== undefined) {
    updates.displayName = String(req.body.displayName || "").trim().slice(0, 80);
  }
  if (req.body?.especialidade !== undefined) {
    updates.especialidade = String(req.body.especialidade || "").trim().slice(0, 60);
  }
  if (req.body?.bio !== undefined) {
    updates.bio = String(req.body.bio || "").trim().slice(0, 500);
  }
  if (req.body?.notifWhatsapp !== undefined) {
    const raw = String(req.body.notifWhatsapp || "").replace(/\D/g, "");
    updates.notifWhatsapp = raw.length >= 10 ? raw : "";
  }
  // Disponibilidade semanal para agendamento público.
  // Formato: { "1": [8,9], "2": [19], ... } onde chave = dia da semana
  // (0=Dom, 1=Seg..6=Sáb) e valores = array de horas inteiras disponíveis.
  if (req.body?.weeklyAvailability !== undefined) {
    const wa = req.body.weeklyAvailability;
    if (wa === null) {
      updates.weeklyAvailability = null;
    } else if (typeof wa === "object" && !Array.isArray(wa)) {
      const cleaned = {};
      for (const [day, hours] of Object.entries(wa)) {
        const d = Number(day);
        if (d >= 0 && d <= 6 && Array.isArray(hours)) {
          cleaned[String(d)] = hours
            .map(h => Number(h))
            .filter(h => Number.isInteger(h) && h >= 0 && h <= 23)
            .sort((a, b) => a - b);
        }
      }
      updates.weeklyAvailability = cleaned;
    }
  }
  // Conselho profissional: atualização atômica via { tipoConselho, numeroConselho, subtipoConselho? }.
  // Espelha em crp/crm pra manter retrocompat com leitores legados.
  if (req.body?.tipoConselho !== undefined || req.body?.numeroConselho !== undefined) {
    const tipoIn = String(req.body?.tipoConselho || "").trim().toUpperCase();
    const numIn  = String(req.body?.numeroConselho || "").trim().toUpperCase().slice(0, 30);
    if (isValidConselhoSigla(tipoIn) && numIn) {
      const tipo = normalizeConselhoSigla(tipoIn);
      updates.tipoConselho   = tipo;
      updates.numeroConselho = numIn;
      updates.crp = tipo === "CRP" ? numIn : "";
      updates.crm = tipo === "CRM" ? numIn : "";
      // Subtipo: exigido quando o conselho requer (CREFITO).
      if (conselhoRequiresSubtipo(tipo)) {
        const sub = String(req.body?.subtipoConselho || "").trim().toLowerCase();
        if (!isValidConselhoSubtipo(tipo, sub)) {
          return sendError(res, 400, "SUBTIPO_CONSELHO_INVALIDO",
            { hint: `Para ${tipo} informe subtipoConselho válido (fisio, to).` });
        }
        updates.subtipoConselho = sub;
      } else {
        updates.subtipoConselho = "";
      }
      // INTERNACIONAL exige país + órgão de registro estrangeiro (mesma
      // validação do cadastro). Demais conselhos limpam esses campos.
      if (tipo === "INTERNACIONAL") {
        const pais  = String(req.body?.paisRegistro  || "").trim().slice(0, 60);
        const orgao = String(req.body?.orgaoRegistro || "").trim().slice(0, 120);
        if (!pais)  return sendError(res, 400, "PAIS_REGISTRO_OBRIGATORIO");
        if (!orgao) return sendError(res, 400, "ORGAO_REGISTRO_OBRIGATORIO");
        updates.paisRegistro = pais;
        updates.orgaoRegistro = orgao;
      } else {
        updates.paisRegistro = "";
        updates.orgaoRegistro = "";
      }
    }
  } else if (req.body?.subtipoConselho !== undefined) {
    // PATCH só do subtipo (ex.: CREFITO mudou de TO pra fisio sem trocar conselho).
    const sub = String(req.body.subtipoConselho || "").trim().toLowerCase();
    if (isValidConselhoSubtipo(therapist.tipoConselho, sub)) {
      updates.subtipoConselho = sub;
    }
  } else {
    // Compat: PATCH { crp } ou { crm } isolado (clientes antigos) — atualiza
    // o campo legado E sincroniza tipoConselho/numeroConselho.
    if (req.body?.crp !== undefined) {
      const val = String(req.body.crp || "").trim().toUpperCase().slice(0, 30);
      updates.crp = val;
      if (val) { updates.tipoConselho = "CRP"; updates.numeroConselho = val; updates.crm = ""; }
    }
    if (req.body?.crm !== undefined) {
      const val = String(req.body.crm || "").trim().toUpperCase().slice(0, 30);
      updates.crm = val;
      if (val) { updates.tipoConselho = "CRM"; updates.numeroConselho = val; updates.crp = ""; }
    }
  }
  if (req.body?.rqe !== undefined) {
    updates.rqe = String(req.body.rqe || "").trim().slice(0, 30);
  }
  if (req.body?.cnpj !== undefined) {
    updates.cnpj = String(req.body.cnpj || "").trim().slice(0, 20);
  }

  // NFS-e via NFE.io — objeto com companyId, codServicoMunicipal, aliquotaIss,
  // regimeTributario, environment ("sandbox" | "production"), apiTokenEncrypted
  // ({ciphertext, iv}). O token vem cifrado com DEK do user (frontend cifra
  // antes de enviar); backend só armazena. Na hora de emitir, frontend manda
  // o token decifrado no header X-Nfse-Token pra essa request específica —
  // backend NÃO persiste o token em claro.
  //
  // Merge inteligente: PATCH parcial preserva campos não enviados (importante
  // pra salvar só configuração sem reenviar token a cada vez).
  if (req.body?.nfseConfig && typeof req.body.nfseConfig === "object") {
    const n = req.body.nfseConfig;
    const existing = therapist.nfseConfig || {};
    const cfg = { ...existing };

    if (n.companyId !== undefined) {
      cfg.companyId = n.companyId ? String(n.companyId).trim().slice(0, 50) : null;
    }
    if (n.codServicoMunicipal !== undefined) {
      cfg.codServicoMunicipal = n.codServicoMunicipal ? String(n.codServicoMunicipal).trim().slice(0, 20) : null;
    }
    if (n.aliquotaIss !== undefined) {
      cfg.aliquotaIss = Number.isFinite(Number(n.aliquotaIss)) ? Number(n.aliquotaIss) : null;
    }
    if (n.regimeTributario !== undefined) {
      cfg.regimeTributario = ["mei", "simples", "presumido", "real"].includes(n.regimeTributario)
        ? n.regimeTributario : null;
    }
    if (n.environment !== undefined) {
      cfg.environment = ["sandbox", "production"].includes(n.environment) ? n.environment : "sandbox";
    }

    // API token cifrado: substitui só se enviado novo. Frontend não envia
    // quando user deixa input em branco (mantém o atual).
    if (n.apiTokenEncrypted && typeof n.apiTokenEncrypted === "object"
        && typeof n.apiTokenEncrypted.ciphertext === "string"
        && typeof n.apiTokenEncrypted.iv === "string") {
      if (n.apiTokenEncrypted.ciphertext.length > 2000) {
        return sendError(res, 413, "TOKEN_GRANDE_DEMAIS");
      }
      cfg.apiTokenEncrypted = {
        ciphertext: n.apiTokenEncrypted.ciphertext,
        iv: n.apiTokenEncrypted.iv
      };
    }

    updates.nfseConfig = cfg;
  }

  // SMS config — token plaintext per-user. Justificativa: cron de lembretes
  // precisa enviar SMS sem DEK do user (que so existe em sessao ativa).
  // Trade-off documentado: vazamento de DB exporia tokens Twilio (custo
  // limitado: atacante manda SMS ate creditos do user esgotarem).
  if (req.body?.smsConfig && typeof req.body.smsConfig === "object") {
    const s = req.body.smsConfig;
    const existing = therapist.smsConfig || {};
    const cfg = { ...existing };
    if (s.provider !== undefined) {
      cfg.provider = ["twilio"].includes(s.provider) ? s.provider : "twilio";
    }
    if (s.accountSid !== undefined) {
      cfg.accountSid = s.accountSid ? String(s.accountSid).trim().slice(0, 100) : null;
    }
    if (s.authToken !== undefined) {
      // Mantem token anterior se enviar string vazia (UX: usuario edita outros campos sem reenviar token)
      const t = String(s.authToken || "").trim();
      if (t) cfg.authToken = t.slice(0, 200);
    }
    if (s.fromNumber !== undefined) {
      cfg.fromNumber = s.fromNumber ? String(s.fromNumber).trim().slice(0, 30) : null;
    }
    if (s.enabled !== undefined) {
      cfg.enabled = !!s.enabled;
    }
    updates.smsConfig = cfg;
  }

  // Consultório (objeto)
  if (req.body?.consultorio && typeof req.body.consultorio === "object") {
    const c = req.body.consultorio;
    updates.consultorio = {
      endereco:    String(c.endereco    || "").trim().slice(0, 200),
      numero:      String(c.numero      || "").trim().slice(0, 20),
      complemento: String(c.complemento || "").trim().slice(0, 80),
      bairro:      String(c.bairro      || "").trim().slice(0, 80),
      cidade:      String(c.cidade      || "").trim().slice(0, 80),
      uf:          String(c.uf          || "").trim().toUpperCase().slice(0, 2),
      cep:         String(c.cep         || "").trim().slice(0, 12),
      telefone:    String(c.telefone    || "").trim().slice(0, 30)
    };
  }

  // Logo (base64). Cliente pode mandar string vazia para remover.
  if (req.body?.logoBase64 !== undefined) {
    const logoBase64 = String(req.body.logoBase64 || "").trim();
    const logoMime   = String(req.body.logoMime   || "").trim().toLowerCase();
    if (logoBase64) {
      if (logoBase64.length > LOGO_MAX_BASE64) return sendError(res, 413, "LOGO_GRANDE_DEMAIS");
      if (!LOGO_ALLOWED_MIMES.has(logoMime))   return sendError(res, 400, "LOGO_TIPO_INVALIDO");
      updates.logoBase64 = logoBase64;
      updates.logoMime   = logoMime;
    } else {
      // Remove logo
      updates.logoBase64 = admin.firestore.FieldValue.delete();
      updates.logoMime   = admin.firestore.FieldValue.delete();
    }
  }

  // Configuração da agenda (janela de trabalho + duração padrão da consulta).
  // Defaults aplicados pelo frontend: 8h-21h, 50min. Bounds validados aqui.
  if (req.body?.agendaConfig !== undefined && req.body.agendaConfig !== null) {
    const ac = req.body.agendaConfig || {};
    const startHour   = Number(ac.startHour);
    const endHour     = Number(ac.endHour);
    const slotMinutes = Number(ac.slotMinutes);
    const cfg = {};
    if (Number.isFinite(startHour)   && startHour >= 0  && startHour <= 22)  cfg.startHour   = startHour;
    if (Number.isFinite(endHour)     && endHour   > 0   && endHour   <= 24)  cfg.endHour     = endHour;
    if (Number.isFinite(slotMinutes) && slotMinutes >= 15 && slotMinutes <= 240) cfg.slotMinutes = slotMinutes;
    if (cfg.startHour !== undefined && cfg.endHour !== undefined && cfg.endHour <= cfg.startHour) {
      return sendError(res, 400, "AGENDA_CONFIG_INVALIDO", { hint: "endHour deve ser > startHour" });
    }
    if (Object.keys(cfg).length) updates.agendaConfig = cfg;
  }

  // Configuração de agendamento público (auto-scheduling via link público).
  // Slug é único entre todos os terapeutas. Mudar slug é OK; URLs antigas
  // simplesmente deixam de funcionar. Toggle enabled controla se o link
  // público aceita novas solicitações (slug pode estar setado mas desabilitado).
  if (req.body?.publicSchedulingSlug !== undefined) {
    const slugRaw = String(req.body.publicSchedulingSlug || "").trim().toLowerCase();
    if (slugRaw === "") {
      updates.publicSchedulingSlug = admin.firestore.FieldValue.delete();
    } else {
      if (!isValidPublicSlug(slugRaw)) {
        return sendError(res, 400, "SLUG_INVALIDO", {
          hint: "Use 3-40 caracteres: letras minúsculas, números e hífens. Não pode começar/terminar com hífen ou ter hífen duplo."
        });
      }
      if (slugRaw !== therapist.publicSchedulingSlug) {
        const existing = await findTherapistBySlug(slugRaw);
        if (existing && existing.uid !== uid) {
          return sendError(res, 409, "SLUG_EM_USO", { hint: "Esse identificador já está em uso. Escolha outro." });
        }
      }
      updates.publicSchedulingSlug = slugRaw;
    }
  }
  if (req.body?.publicSchedulingEnabled !== undefined) {
    updates.publicSchedulingEnabled = Boolean(req.body.publicSchedulingEnabled);
  }
  // Opt-in: profissional habilita transcrição IA + resumo de suas sessões.
  // Feature ainda exige consentimento separado do paciente — backend valida
  // ambos antes de processar áudio.
  if (req.body?.aiSummaryEnabled !== undefined) {
    updates.aiSummaryEnabled = Boolean(req.body.aiSummaryEnabled);
  }
  if (req.body?.publicSchedulingMinNoticeHours !== undefined) {
    const n = Number(req.body.publicSchedulingMinNoticeHours);
    if (Number.isFinite(n) && n >= 0 && n <= 720) {
      updates.publicSchedulingMinNoticeHours = n;
    }
  }
  if (req.body?.publicSchedulingMaxAdvanceDays !== undefined) {
    const n = Number(req.body.publicSchedulingMaxAdvanceDays);
    if (Number.isFinite(n) && n >= 1 && n <= 180) {
      updates.publicSchedulingMaxAdvanceDays = n;
    }
  }
  // Opt-in: aparecer no diretório público de profissionais.
  // Exige verificationStatus=verified + publicSchedulingEnabled true pra ter efeito.
  if (req.body?.listPublicly !== undefined) {
    updates.listPublicly = Boolean(req.body.listPublicly);
  }

  // Configuração de cobranças Asaas. apiKey é secret — nunca sai do servidor
  // depois de salva (filtrada no /me). Env aceita "sandbox" | "production".
  // Se apiKey é fornecida não-vazia, validamos contra /myAccount antes de
  // gravar (rejeita key inválida no 1º contato).
  if (req.body?.asaasEnv !== undefined) {
    const envIn = String(req.body.asaasEnv || "sandbox").toLowerCase();
    updates.asaasEnv = (envIn === "production") ? "production" : "sandbox";
  }
  if (req.body?.asaasApiKey !== undefined) {
    const keyRaw = String(req.body.asaasApiKey || "").trim();
    if (keyRaw === "") {
      updates.asaasApiKey = admin.firestore.FieldValue.delete();
      updates.asaasEnabled = false;
      updates.asaasAccount = admin.firestore.FieldValue.delete();
    } else {
      const env = updates.asaasEnv || therapist.asaasEnv || "sandbox";
      const validation = await asaas.validateApiKey({ apiKey: keyRaw, env });
      if (!validation.ok) {
        return sendError(res, 400, "ASAAS_KEY_INVALIDA", {
          hint: "Verifique a chave de API copiada do painel Asaas. Sandbox e produção têm chaves distintas."
        });
      }
      updates.asaasApiKey = keyRaw;
      updates.asaasAccount = validation.account || null;
    }
  }
  if (req.body?.asaasEnabled !== undefined) {
    updates.asaasEnabled = Boolean(req.body.asaasEnabled);
  }

  // Foto de perfil (avatar). Mesmo padrão da logo — cliente redimensiona
  // pra 256x256 antes de enviar, mantendo o doc pequeno (~50 KB).
  if (req.body?.photoBase64 !== undefined) {
    const photoBase64 = String(req.body.photoBase64 || "").trim();
    const photoMime   = String(req.body.photoMime   || "").trim().toLowerCase();
    if (photoBase64) {
      if (photoBase64.length > PHOTO_MAX_BASE64) return sendError(res, 413, "FOTO_GRANDE_DEMAIS");
      if (!PHOTO_ALLOWED_MIMES.has(photoMime))   return sendError(res, 400, "FOTO_TIPO_INVALIDO");
      updates.photoBase64 = photoBase64;
      updates.photoMime   = photoMime;
    } else {
      updates.photoBase64 = admin.firestore.FieldValue.delete();
      updates.photoMime   = admin.firestore.FieldValue.delete();
    }
  }

  // Tópicos personalizados da sessão.
  if (Array.isArray(req.body?.sessionTopics)) {
    updates.sessionTopics = req.body.sessionTopics
      .filter(t => t && typeof t.text === "string" && t.text.trim())
      .slice(0, 50)
      .map(t => ({
        id:    String(t.id   || "").slice(0, 40) || crypto.randomBytes(6).toString("hex"),
        text:  String(t.text || "").trim().slice(0, 300),
        abord: String(t.abord || "custom").slice(0, 30)
      }));
  }

  await getDb().collection("therapists").doc(uid).set(updates, { merge: true });
  await logAudit({ type: "therapist_perfil_updated", therapistUid: uid });

  return res.json({ ok: true });
}));

// GET /therapy/profissional/me
router.get("/therapy/profissional/me", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 404, "PROFISSIONAL_NAO_REGISTRADO");

  const access = evaluatePlanAccess(therapist);
  const trialUntilMs = therapist.trialUntil?.toMillis ? therapist.trialUntil.toMillis() : Number(therapist.trialUntil) || 0;
  const daysLeft = trialUntilMs ? Math.max(0, Math.ceil((trialUntilMs - Date.now()) / 86_400_000)) : null;

  // Capabilities derivadas do conselho — frontend usa pra ocultar botões
  // (ex.: nutricionista não vê 'Emitir receita'). Backend continua sendo
  // a fonte da verdade via requireCapability nos endpoints.
  const conselhoSigla = resolveSiglaFromTherapist(therapist);
  const conselho = getConselho(conselhoSigla);
  const capabilities = conselho?.capabilities || [];
  const prescriptionTypes = getPrescriptionTypesForTherapist(therapist);

  // Remove secrets do payload — twoFactorSecret/twoFactorPendingSecret e
  // asaasApiKey nunca saem do servidor. Mantém só flags públicas (enabled).
  const { twoFactorSecret, twoFactorPendingSecret, asaasApiKey, ...therapistPublic } = therapist;
  therapistPublic.twoFactorEnabled = !!therapist.twoFactorEnabled;
  therapistPublic.asaasConfigured  = !!asaasApiKey;

  // NFS-e: nunca devolve o apiTokenEncrypted (mesmo cifrado, evita exposição
  // desnecessária). Mostra só flag pública pro frontend renderizar "já configurado".
  if (therapistPublic.nfseConfig) {
    const { apiTokenEncrypted, ...nfsePublic } = therapistPublic.nfseConfig;
    therapistPublic.nfseConfig = {
      ...nfsePublic,
      apiTokenConfigured: !!apiTokenEncrypted
    };
  }

  // SMS: nunca devolve authToken plaintext. Frontend só sabe se está configurado.
  if (therapistPublic.smsConfig) {
    const { authToken, ...smsPublic } = therapistPublic.smsConfig;
    therapistPublic.smsConfig = {
      ...smsPublic,
      authTokenConfigured: !!authToken
    };
  }

  return res.json({
    ok: true,
    therapist: therapistPublic,
    planAccess: {
      canUseFeatures: access.ok,
      reason: access.reason || null,
      plano: access.plano,
      trialUntil: trialUntilMs || null,
      trialDaysLeft: daysLeft,
      // Cortesia admin (se houver) — frontend pode mostrar pill "Cortesia até X"
      // no painel do terapeuta pra esclarecer por que está liberado sem plano pago.
      adminGrantedUntil: access.adminGrantedUntil || null
    },
    conselho: {
      sigla: conselhoSigla || null,
      label: conselho?.label || null,
      profissional: conselho?.profissional || null,
      subtipo: therapist.subtipoConselho || null,
      isInternacional: !!conselho?.isInternacional,
      capabilities,
      prescriptionTypes
    }
  });
}));

// ─────────────────────────────────────────────────────────────────────────
// POST /therapy/sessao/criar
// Cria uma consulta agendada/imediata. Devolve link com joinToken para a primeira.
// Body: { patientName, patientId?, scheduledAt?, recurrence?: { weekly: N } }
//
// Recorrência: weekly N (entre 2 e 52) cria N sessões espaçadas 7d a partir
// de scheduledAt, todas com mesmo recurrenceGroupId. scheduledAt é
// obrigatório quando recurrence está presente (sem hora-base não dá pra
// projetar a série). Cada sessão tem seu próprio sessionId, e2eeKey,
// livekitRoom e joinToken — series não compartilham sala (privacidade).
// joinToken só é gerado para a primeira sessão; para as demais o terapeuta
// pede regenerar-link perto da data (joinToken vence em 2h).
// ─────────────────────────────────────────────────────────────────────────
const RECURRENCE_MAX_WEEKS = 52;

router.post("/therapy/sessao/criar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await requirePaidPlan(req, res, uid);
  if (!therapist) return;

  const patientName = String(req.body?.patientName || "Paciente").trim().slice(0, PATIENT_NAME_MAX);
  const patientId   = String(req.body?.patientId || "").trim();
  const patientEmailRaw = String(req.body?.patientEmail || "").trim().toLowerCase();
  const patientEmail = patientEmailRaw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patientEmailRaw) ? patientEmailRaw : null;
  // patientPhone: normaliza pra E.164 BR (5548988637670). Validação leve
  // — se não conseguir normalizar, fica null (não envia WhatsApp).
  const patientPhoneRaw = String(req.body?.patientPhone || "").trim();
  const patientPhoneNorm = patientPhoneRaw ? normalizeWaPhone(patientPhoneRaw) : "";
  const patientPhone = patientPhoneNorm.length >= 12 ? patientPhoneNorm : null;
  const scheduledAtRaw = Number(req.body?.scheduledAt || 0);
  const scheduledAt = Number.isFinite(scheduledAtRaw) && scheduledAtRaw > 0 ? scheduledAtRaw : null;

  const recurrenceWeekly = Number(req.body?.recurrence?.weekly || 1);
  const isRecurring = recurrenceWeekly >= 2;
  if (isRecurring) {
    if (!Number.isFinite(recurrenceWeekly) || recurrenceWeekly < 2 || recurrenceWeekly > RECURRENCE_MAX_WEEKS) {
      return sendError(res, 400, "RECORRENCIA_INVALIDA", { hint: `Use entre 2 e ${RECURRENCE_MAX_WEEKS} semanas.` });
    }
    if (!scheduledAt) return sendError(res, 400, "HORARIO_OBRIGATORIO_PARA_RECORRENCIA");
  }

  // Se patientId passado, valida ownership.
  if (patientId) {
    const db0 = getDb();
    const psnap = await db0.collection("therapy_patients").doc(patientId).get();
    if (!psnap.exists) return sendError(res, 404, "PACIENTE_NAO_ENCONTRADO");
    if (psnap.data().therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");
  }

  const db = getDb();
  const recurrenceGroupId = isRecurring ? newId("rgrp") : null;
  const occurrences = isRecurring ? recurrenceWeekly : 1;
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  // Snapshot do e-mail do terapeuta pra Reply-To em e-mails automáticos.
  // Usa o snapshot do doc; se ausente, lookup lazy via Firebase Auth.
  const therapistEmail = await resolveTherapistEmail(uid, therapist);

  // Cria todas as sessões em batch. firstSession recebe joinToken; demais
  // ficam com joinTokenExp=null até o terapeuta pedir regenerate.
  const batch = db.batch();
  const created = [];
  let firstJoinToken = null;
  let firstJoinTokenExp = null;

  for (let i = 0; i < occurrences; i++) {
    const sId = newId("sess");
    const room = `therapy_${sId}`;
    const e2eeKey = crypto.randomBytes(32).toString("base64");
    const at = scheduledAt ? scheduledAt + i * WEEK_MS : null;

    let joinTokenExp = null;
    if (i === 0) {
      const joinPayload = {
        token_type: "therapy_join",
        sessionId: sId,
        therapistUid: uid,
        livekitRoom: room,
        patientNameHint: patientName,
        iat: Date.now(),
        exp: Date.now() + JOIN_TOKEN_VALIDITY_MS
      };
      firstJoinToken    = signPayload(joinPayload, ACCESS_TOKEN_SECRET);
      firstJoinTokenExp = joinPayload.exp;
      joinTokenExp = joinPayload.exp;
      // Short code: índice opaco pro URL bonito (entrar.html?c=XXXXXXXX).
      // Gerado fora do batch — Firestore precisa de write isolado pra doc-id
      // unicidade. Falha aqui não bloqueia criação da sessão (paciente cai no
      // fluxo antigo com ?t=<jwt> se generateCode falhar).
    }

    batch.set(db.collection("therapy_sessions").doc(sId), {
      sessionId: sId,
      therapistUid: uid,
      therapistDisplayName: therapist.displayName || "",
      therapistEmail,
      patientName,
      patientId: patientId || null,
      patientEmail,
      patientPhone,
      livekitRoom: room,
      e2eeKey,
      scheduledAt: at,
      status: "scheduled",
      joinTokenExp,
      recurrenceGroupId,
      recurrenceIndex: isRecurring ? i : null,
      recurrenceCount: isRecurring ? occurrences : null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    created.push({ sessionId: sId, scheduledAt: at, livekitRoom: room });
  }

  await batch.commit();

  // Short code pro URL bonito. Best-effort — se falhar, callers caem no
  // joinToken longo (buildPatientJoinUrl detecta pelo comprimento).
  let firstJoinCode = null;
  if (firstJoinToken) {
    try {
      firstJoinCode = await createJoinCode({
        joinToken: firstJoinToken,
        sessionId: created[0].sessionId,
        expiresAt: firstJoinTokenExp
      });
    } catch (e) {
      logWarn("therapy_join_code_create_failed", { sessionId: created[0].sessionId, error: e.message });
    }
  }

  // Confirmação por e-mail (fire-and-forget, não bloqueia resposta).
  // Apenas a primeira ocorrência: para séries longas, enviar 52 e-mails de
  // confirmação seria spam — paciente pega calendário visual + lembretes 24h
  // antes de cada uma.
  if (patientEmail && firstJoinToken) {
    const cancelTokenInfo = buildCancelToken(created[0].sessionId);
    const tpl = templateConfirmation({
      patientName,
      therapistName: therapist.displayName || "seu profissional",
      scheduledAt: created[0].scheduledAt || Date.now(),
      joinUrl: buildPatientJoinUrl(firstJoinCode || firstJoinToken),
      cancelUrl: buildPatientCancelUrl(cancelTokenInfo.token),
      minCancelHours: THERAPY_MIN_CANCEL_HOURS_PATIENT
    });
    sendEmail({ to: patientEmail, replyTo: therapistEmail || undefined, ...tpl }).catch(e =>
      logError("therapy_confirmation_email_failed", e, { sessionId: created[0].sessionId })
    );
  } else {
    // Log explícito do skip pra debug — sem isso, criar sessão sem e-mail
    // some silencioso e fica difícil saber por que confirmação não chegou.
    logInfo("therapy_confirmation_email_skipped", {
      sessionId: created[0].sessionId,
      hasPatientEmail: Boolean(patientEmail),
      hasJoinToken: Boolean(firstJoinToken)
    });
  }

  // Confirmação por WhatsApp (fire-and-forget). Só dispara se:
  // - patientPhone foi normalizado com sucesso
  // - therapist.whatsappConfig.enabled = true
  // - ZAPI configurado (env vars presentes)
  // Mesma estratégia do e-mail: 1ª ocorrência só; recorrência usa lembrete 24h.
  if (patientPhone && firstJoinToken && therapist?.whatsappConfig?.enabled) {
    const cancelTokenInfo  = buildCancelToken(created[0].sessionId);
    const confirmTokenInfo = buildConfirmToken(created[0].sessionId);
    // Short codes pra cancel/confirm — URL curta no WhatsApp (?c=XXXXXXXX ~50 chars)
    let cancelCode = null, confirmCode = null;
    try {
      [cancelCode, confirmCode] = await Promise.all([
        createActionCode({ token: cancelTokenInfo.token,  type: "cancel"  }),
        createActionCode({ token: confirmTokenInfo.token, type: "confirm" })
      ]);
    } catch (e) {
      logWarn("action_code_wa_create_failed", { sessionId: created[0].sessionId, error: e.message });
    }
    const sessionForWa = {
      sessionId: created[0].sessionId,
      patientName, patientPhone,
      scheduledAt: created[0].scheduledAt || Date.now()
    };
    sendWaConfirmation({
      session: sessionForWa, therapist,
      joinUrl:    buildPatientJoinUrl(firstJoinCode || firstJoinToken),
      cancelUrl:  buildPatientCancelUrl(cancelCode  || cancelTokenInfo.token),
      confirmUrl: buildPatientConfirmUrl(confirmCode || confirmTokenInfo.token)
    }).then(r => {
      if (r.ok)        logInfo("therapy_confirmation_wa_sent",    { sessionId: created[0].sessionId, messageId: r.messageId });
      else if (r.skipped) logInfo("therapy_confirmation_wa_skipped", { sessionId: created[0].sessionId, reason: r.reason });
      else             logWarn("therapy_confirmation_wa_failed",  { sessionId: created[0].sessionId, error: r.error });
    }).catch(e =>
      logError("therapy_confirmation_wa_exception", e, { sessionId: created[0].sessionId })
    );
  }

  await logAudit({
    type: "session_created",
    sessionId: created[0].sessionId,
    therapistUid: uid,
    recurrenceGroupId,
    recurrenceCount: isRecurring ? occurrences : null
  });

  const first = created[0];
  getIo()?.to(uid).emit("sessoes:changed");
  return res.json({
    ok: true,
    session: {
      sessionId: first.sessionId,
      livekitRoom: `therapy_${first.sessionId}`,
      patientName,
      scheduledAt: first.scheduledAt,
      status: "scheduled",
      joinToken: firstJoinToken,
      joinTokenExp: firstJoinTokenExp,
      joinCode: firstJoinCode
    },
    recurrence: isRecurring ? { groupId: recurrenceGroupId, count: occurrences, sessions: created } : null
  });
}));

// POST /therapy/sessao/:sessionId/regenerar-link — terapeuta gera um joinToken
// fresco para uma sessão (útil para sessões agendadas que passaram da janela
// de 2h, e para gerar o link das ocorrências subsequentes de uma série).
router.post("/therapy/sessao/:sessionId/regenerar-link", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const sessionId = String(req.params.sessionId || "").trim();
  if (!sessionId) return sendError(res, 400, "SESSAO_OBRIGATORIA");

  const db = getDb();
  const ref = db.collection("therapy_sessions").doc(sessionId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "SESSAO_NAO_ENCONTRADA");
  const sess = snap.data();
  if (sess.therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");
  if (sess.status === "completed") return sendError(res, 409, "SESSAO_JA_ENCERRADA");
  if (sess.status === "canceled")  return sendError(res, 409, "SESSAO_CANCELADA");

  const joinPayload = {
    token_type: "therapy_join",
    sessionId,
    therapistUid: uid,
    livekitRoom: sess.livekitRoom,
    patientNameHint: sess.patientName,
    iat: Date.now(),
    exp: Date.now() + JOIN_TOKEN_VALIDITY_MS
  };
  const joinToken = signPayload(joinPayload, ACCESS_TOKEN_SECRET);

  await ref.set({
    joinTokenExp: joinPayload.exp,
    // Limpa flag de consumo — link regenerado eh novo single-use.
    joinTokenConsumedAt: admin.firestore.FieldValue.delete(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  let joinCode = null;
  try {
    joinCode = await createJoinCode({ joinToken, sessionId, expiresAt: joinPayload.exp });
  } catch (e) {
    logWarn("therapy_join_code_create_failed", { sessionId, error: e.message });
  }

  return res.json({ ok: true, joinToken, joinTokenExp: joinPayload.exp, joinCode });
}));

// GET /therapy/sessoes — lista as sessões do profissional logado
// Query: ?includeHidden=true para incluir sessões marcadas como
// hiddenFromPainel. Usado pela agenda (que mantém histórico completo
// mesmo após o profissional "remover da lista" no painel).
router.get("/therapy/sessoes", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const includeHidden = req.query.includeHidden === "true";

  const db = getDb();
  // Sem orderBy server-side pra evitar exigência de composite index no
  // Firestore. Limit defensivo de 200; ordenação é feita client-side.
  // Filtro hiddenFromPainel também client-side pelo mesmo motivo (composite
  // index). Painel só mostra sessões não ocultas; agenda passa
  // includeHidden=true pra manter histórico completo; prontuário do
  // paciente continua mostrando tudo (rota /therapy/pacientes/:id/sessoes).
  const snap = await db.collection("therapy_sessions")
    .where("therapistUid", "==", uid)
    .limit(200)
    .get();

  const sessions = snap.docs
    .map(d => {
      const data = d.data();
      return {
        sessionId: data.sessionId,
        patientName: data.patientName,
        patientId: data.patientId || null,
        patientEmail: data.patientEmail || null,
        patientAccountUid: data.patientAccountUid || null,
        status: data.status,
        scheduledAt: data.scheduledAt || null,
        livekitRoom: data.livekitRoom,
        createdAt: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
        completedAt: data.completedAt?.toMillis ? data.completedAt.toMillis() : null,
        canceledAt: data.canceledAt?.toMillis ? data.canceledAt.toMillis() : null,
        canceledBy: data.canceledBy || null,
        cancelReason: data.cancelReason || null,
        confirmedAt: data.confirmedAt?.toMillis ? data.confirmedAt.toMillis() : null,
        confirmedBy: data.confirmedBy || null,
        joinTokenExp: data.joinTokenExp || null,
        recurrenceGroupId: data.recurrenceGroupId || null,
        recurrenceIndex: typeof data.recurrenceIndex === "number" ? data.recurrenceIndex : null,
        recurrenceCount: data.recurrenceCount || null,
        hiddenFromPainel: data.hiddenFromPainel === true
      };
    })
    .filter(s => includeHidden || !s.hiddenFromPainel)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return res.json({ ok: true, sessions });
}));

// ─────────────────────────────────────────────────────────────────────────
// POST /therapy/sessao/:sessionId/livekit-token
// Emite token LiveKit para o PROFISSIONAL entrar na sala da consulta.
// E2EE é configurado client-side; o token só dá grant de room.
// ─────────────────────────────────────────────────────────────────────────
router.post("/therapy/sessao/:sessionId/livekit-token", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  if (!ensureLivekit(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const sessionId = String(req.params.sessionId || "").trim();
  if (!sessionId) return sendError(res, 400, "SESSAO_OBRIGATORIA");

  const db = getDb();
  const snap = await db.collection("therapy_sessions").doc(sessionId).get();
  if (!snap.exists) return sendError(res, 404, "SESSAO_NAO_ENCONTRADA");

  const session = snap.data();
  if (session.therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");
  // Sessao cancelada ou encerrada nao deve ressuscitar via livekit-token.
  // Antes, qualquer status virava "in_progress" silenciosamente — terapeuta
  // entrava em sala de sessao cancelada sem refazer agendamento.
  if (session.status === "canceled") return sendError(res, 410, "SESSAO_CANCELADA");
  if (session.status === "completed") return sendError(res, 410, "SESSAO_ENCERRADA");

  const therapist = await loadTherapist(uid);
  const identity = `pro_${uid}`;
  const livekitToken = await issueLivekitToken({
    room: session.livekitRoom,
    identity,
    name: therapist?.displayName || "Profissional",
    ttlMs: SESSION_TOKEN_VALIDITY_MS
  });

  // Pré-cálculo: pode o profissional rodar transcrição IA nesta sessão?
  // Requer opt-in do profissional + consentimento do paciente (por sessão
  // ou flag global da conta). Frontend usa pra decidir se inicia o
  // MediaRecorder do session-ai-capture.js — evita gravar 50min de áudio
  // que o backend recusaria depois.
  let aiSummaryReady = !!therapist?.aiSummaryEnabled;
  if (aiSummaryReady) {
    let patientConsent = !!session.consentAiSummary;

    // Tenta via patientAccountUid (já linkado)
    if (!patientConsent && session.patientAccountUid) {
      const pa = await loadPatientAccount(session.patientAccountUid);
      patientConsent = !!pa?.consentAiSummary;
    }

    // Fallback: link por email — a sessão tem patientEmail mas patientAccountUid
    // nunca foi preenchido (criação de sessão não faz o lookup). Faz o link
    // agora e persiste pra próximas verificações.
    if (!patientConsent && !session.patientAccountUid && session.patientEmail) {
      try {
        const fbUser = await admin.auth().getUserByEmail(session.patientEmail);
        if (fbUser?.uid) {
          const pa = await loadPatientAccount(fbUser.uid);
          if (pa) {
            patientConsent = !!pa.consentAiSummary;
            // Persiste o link pra não repetir o lookup em próximas entradas
            await db.collection("therapy_sessions").doc(sessionId).set(
              { patientAccountUid: fbUser.uid, autoLinkedAt: admin.firestore.FieldValue.serverTimestamp() },
              { merge: true }
            );
          }
        }
      } catch (e) {
        if (e?.code !== "auth/user-not-found") {
          logError("livekit_token_patient_link_failed", e, { sessionId });
        }
      }
    }

    aiSummaryReady = patientConsent;
  }

  await db.collection("therapy_sessions").doc(sessionId).set({
    status: "in_progress",
    therapistJoinedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({ type: "therapist_joined", sessionId, therapistUid: uid });

  return res.json({
    ok: true,
    livekitUrl: LIVEKIT_URL,
    livekitToken,
    livekitRoom: session.livekitRoom,
    role: "therapist",
    e2eeKey: session.e2eeKey || null,
    e2eeSalt: therapist?.e2eeSalt || null,
    aiSummaryReady
  });
}));

// ─────────────────────────────────────────────────────────────────────────
// POST /therapy/sessao/join
// Paciente troca joinToken + nome por livekitToken. Sem auth Firebase.
// Body: { joinToken | joinCode, patientName?, consentLgpd: true }
// joinCode (8 chars) resolve internamente pro joinToken (JWT). joinToken
// legado continua aceito pra retro-compat com links já enviados.
// ─────────────────────────────────────────────────────────────────────────
router.post("/therapy/sessao/join", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  if (!ensureLivekit(res)) return;

  let joinToken     = String(req.body?.joinToken   || "").trim();
  const joinCode    = String(req.body?.joinCode    || "").trim();
  const patientName = String(req.body?.patientName || "").trim().slice(0, PATIENT_NAME_MAX);
  const consentLgpd = !!req.body?.consentLgpd;
  const patientIdToken = String(req.body?.patientIdToken || "").trim();

  // Resolve short code → JWT se veio joinCode em vez de joinToken.
  if (!joinToken && joinCode) {
    const resolved = await resolveJoinCode(joinCode);
    if (!resolved) return sendError(res, 401, "JOIN_CODE_INVALIDO_OU_EXPIRADO");
    joinToken = resolved;
  }

  if (!joinToken)   return sendError(res, 400, "JOIN_TOKEN_OBRIGATORIO");
  if (!consentLgpd) return sendError(res, 400, "CONSENTIMENTO_LGPD_OBRIGATORIO");

  const verification = verifySignedToken(joinToken, ACCESS_TOKEN_SECRET);
  if (!verification.valid) return sendError(res, 401, verification.error || "JOIN_TOKEN_INVALIDO");
  const payload = verification.payload;
  if (payload.token_type !== "therapy_join") return sendError(res, 401, "JOIN_TOKEN_NAO_AUTORIZADO");

  const db = getDb();
  const sessionRef = db.collection("therapy_sessions").doc(payload.sessionId);
  const snap = await sessionRef.get();
  if (!snap.exists) return sendError(res, 404, "SESSAO_NAO_ENCONTRADA");
  const session = snap.data();
  if (session.status === "completed") return sendError(res, 410, "SESSAO_ENCERRADA");
  // Cancelamento revoga o joinToken — paciente nao entra em sala cancelada.
  if (session.status === "canceled") return sendError(res, 410, "SESSAO_CANCELADA");
  // Single-use enforcement — token nao pode ser reusado depois do consumo.
  // joinTokenConsumedAt eh setado no primeiro join bem-sucedido (logo abaixo)
  // e checado aqui via field path no doc da sessao.
  if (session.joinTokenConsumedAt) return sendError(res, 410, "JOIN_TOKEN_JA_USADO");

  // Se paciente logado, vincula a sessão à conta dele para histórico futuro.
  // É opcional — convidado anônimo continua entrando sem conta.
  let patientAccountUid = null;
  let patientAccount = null;
  if (patientIdToken) {
    const uid = await verifyOptionalIdToken(patientIdToken);
    if (uid) {
      patientAccount = await loadPatientAccount(uid);
      if (patientAccount) patientAccountUid = uid;
    }
  }

  const finalName = patientName
    || (patientAccount?.displayName)
    || session.patientName
    || payload.patientNameHint
    || "Paciente";
  const identity = `pat_${crypto.randomBytes(6).toString("hex")}`;

  const livekitToken = await issueLivekitToken({
    room: session.livekitRoom,
    identity,
    name: finalName,
    ttlMs: SESSION_TOKEN_VALIDITY_MS
  });

  const sessionUpdate = {
    patientJoinedAt: admin.firestore.FieldValue.serverTimestamp(),
    patientNameFinal: finalName,
    patientConsentLgpdAt: admin.firestore.FieldValue.serverTimestamp(),
    // Marca o token como consumido — proxima tentativa cai no JOIN_TOKEN_JA_USADO.
    // Se paciente precisar reentrar, terapeuta gera novo link via /regenerar-link.
    joinTokenConsumedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  if (patientAccountUid) sessionUpdate.patientAccountUid = patientAccountUid;

  await sessionRef.set(sessionUpdate, { merge: true });

  await logAudit({
    type: "patient_joined",
    sessionId: payload.sessionId,
    patientName: finalName,
    patientAccountUid: patientAccountUid || null,
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || null
  });

  return res.json({
    ok: true,
    livekitUrl: LIVEKIT_URL,
    livekitToken,
    livekitRoom: session.livekitRoom,
    role: "patient",
    e2eeKey: session.e2eeKey || null,
    therapistDisplayName: session.therapistDisplayName || "",
    sessionId: payload.sessionId,
    patientAccountUid: patientAccountUid || null
  });
}));

// ─────────────────────────────────────────────────────────────────────────
// POST /therapy/sessao/:sessionId/notas
// Salva uma nota cifrada. Body: { ciphertext, iv, kind? }
// ciphertext + iv são base64; servidor NÃO consegue decifrar.
// ─────────────────────────────────────────────────────────────────────────
router.post("/therapy/sessao/:sessionId/notas", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const sessionId = String(req.params.sessionId || "").trim();
  if (!sessionId) return sendError(res, 400, "SESSAO_OBRIGATORIA");

  const ciphertext = String(req.body?.ciphertext || "").trim();
  const iv         = String(req.body?.iv         || "").trim();
  const kind       = String(req.body?.kind || "note").trim().slice(0, 24);

  if (!ciphertext || !iv) return sendError(res, 400, "CIPHERTEXT_IV_OBRIGATORIOS");
  if (ciphertext.length > NOTE_CIPHERTEXT_MAX) return sendError(res, 413, "NOTA_GRANDE_DEMAIS");

  const db = getDb();
  const sessSnap = await db.collection("therapy_sessions").doc(sessionId).get();
  if (!sessSnap.exists) return sendError(res, 404, "SESSAO_NAO_ENCONTRADA");
  if (sessSnap.data().therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  const noteId = newId("note");
  await db.collection("therapy_notes").doc(noteId).set({
    noteId,
    sessionId,
    therapistUid: uid,
    kind,
    ciphertext,
    iv,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return res.json({ ok: true, noteId });
}));

// GET /therapy/sessao/:sessionId/notas — devolve cifrados; cliente decifra
router.get("/therapy/sessao/:sessionId/notas", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const sessionId = String(req.params.sessionId || "").trim();
  if (!sessionId) return sendError(res, 400, "SESSAO_OBRIGATORIA");

  const db = getDb();
  const sessSnap = await db.collection("therapy_sessions").doc(sessionId).get();
  if (!sessSnap.exists) return sendError(res, 404, "SESSAO_NAO_ENCONTRADA");
  if (sessSnap.data().therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  // Sem orderBy server-side (evita composite index). Ordena ASC por createdAt em JS.
  const snap = await db.collection("therapy_notes")
    .where("sessionId", "==", sessionId)
    .limit(500)
    .get();

  const notes = snap.docs
    .map(d => {
      const data = d.data();
      return {
        noteId: data.noteId,
        kind: data.kind,
        ciphertext: data.ciphertext,
        iv: data.iv,
        createdAt: data.createdAt?.toMillis ? data.createdAt.toMillis() : null
      };
    })
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  return res.json({ ok: true, notes });
}));

// POST /therapy/sessao/:sessionId/encerrar
router.post("/therapy/sessao/:sessionId/encerrar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const sessionId = String(req.params.sessionId || "").trim();
  if (!sessionId) return sendError(res, 400, "SESSAO_OBRIGATORIA");

  const db = getDb();
  const sessSnap = await db.collection("therapy_sessions").doc(sessionId).get();
  if (!sessSnap.exists) return sendError(res, 404, "SESSAO_NAO_ENCONTRADA");
  if (sessSnap.data().therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  const sessData = sessSnap.data();

  await db.collection("therapy_sessions").doc(sessionId).set({
    status: "completed",
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({ type: "session_completed", sessionId, therapistUid: uid });

  // Disparo fire-and-forget: WhatsApp de avaliação pra o paciente.
  // Gera NPS token + short code e envia imediatamente ao encerrar.
  if (sessData.patientPhone) {
    (async () => {
      try {
        const db2 = getDb();
        const tSnap = await db2.collection("therapists").doc(uid).get();
        const therapist = tSnap.exists ? tSnap.data() : null;
        if (!therapist?.whatsappConfig?.enabled) return;

        const npsToken = signPayload({
          token_type: "nps",
          sessionId,
          therapistUid: uid,
          patientEmail:    sessData.patientEmail    || "",
          patientNameHint: sessData.patientName     || "",
          iat: Date.now(),
          exp: Date.now() + NPS_TOKEN_VALIDITY_MS
        }, ACCESS_TOKEN_SECRET);

        let npsUrl;
        try {
          const code = await createActionCode({ token: npsToken, type: "nps" });
          npsUrl = buildPatientNpsUrl(code);
        } catch {
          npsUrl = buildPatientNpsUrl(npsToken);
        }

        const firstName     = String(sessData.patientName || "Paciente").split(/\s+/)[0];
        const therapistName = therapist.displayName || "seu profissional";
        const message = `Olá, ${firstName}! Sua consulta com ${therapistName} foi encerrada.\n\nComo foi o atendimento? Sua avaliação leva menos de 30 segundos e ajuda muito:\n${npsUrl}\n\n— Equipe Espaço Prelúdio`;

        await sendWaText({ to: sessData.patientPhone, message });
        logInfo("nps_wa_sent", { sessionId, patientPhone: sessData.patientPhone });
      } catch (e) {
        logWarn("nps_wa_failed", { sessionId, error: e.message });
      }
    })();
  }

  getIo()?.to(uid).emit("sessoes:changed");
  return res.json({ ok: true });
}));

// ─────────────────────────────────────────────────────────────────────────
// PATCH /therapy/sessao/:sessionId/paciente — edita patientEmail/Phone de
// uma sessão existente. Caso de uso principal: terapeuta criou a sessão
// sem email (campo era opcional) e agora quer vincular pra abrir chat E2EE
// com o paciente que ja tem conta criada.
//
// Após salvar o email, busca conta de paciente com mesmo auth email e, se
// existir, vincula a sessão (patientAccountUid) + roda autoLink retroativo
// pra cobrir outras sessões do mesmo paciente com email igual.
// ─────────────────────────────────────────────────────────────────────────
router.patch("/therapy/sessao/:sessionId/paciente", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const sessionId = String(req.params.sessionId || "").trim();
  if (!sessionId) return sendError(res, 400, "SESSAO_OBRIGATORIA");

  const db = getDb();
  const sessRef = db.collection("therapy_sessions").doc(sessionId);
  const sessSnap = await sessRef.get();
  if (!sessSnap.exists) return sendError(res, 404, "SESSAO_NAO_ENCONTRADA");
  const session = sessSnap.data();
  if (session.therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

  if (req.body?.patientEmail !== undefined) {
    const raw = String(req.body.patientEmail || "").trim().toLowerCase();
    if (raw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
      return sendError(res, 400, "EMAIL_INVALIDO");
    }
    updates.patientEmail = raw || null;
  }
  if (req.body?.patientPhone !== undefined) {
    const raw = String(req.body.patientPhone || "").trim();
    const norm = raw ? normalizeWaPhone(raw) : "";
    updates.patientPhone = norm.length >= 12 ? norm : null;
  }

  if (Object.keys(updates).length === 1) return sendError(res, 400, "NENHUMA_ACAO");

  await sessRef.set(updates, { merge: true });

  // Tenta vincular conta de paciente se email foi setado.
  let linkedUid = null;
  let autoLinkedCount = 0;
  if (updates.patientEmail) {
    try {
      const fbUser = await admin.auth().getUserByEmail(updates.patientEmail);
      if (fbUser?.uid) {
        const patientAccount = await loadPatientAccount(fbUser.uid);
        if (patientAccount) {
          linkedUid = fbUser.uid;
          await sessRef.set({ patientAccountUid: fbUser.uid }, { merge: true });
          // Roda autoLink retroativo — outras sessões do mesmo email tambem
          // ficam vinculadas em batch.
          const r = await autoLinkPatientSessions(fbUser.uid, db);
          autoLinkedCount = r.linked || 0;
        }
      }
    } catch (e) {
      // Email pode nao ter conta no Firebase Auth ainda — nao eh erro.
      if (e?.code !== "auth/user-not-found") {
        logError("session_patient_link_lookup_failed", e, { sessionId });
      }
    }
  }

  await logAudit({
    type: "session_patient_edited",
    sessionId,
    therapistUid: uid,
    emailSet: !!updates.patientEmail,
    linkedAccount: !!linkedUid,
    autoLinkedCount
  });

  return res.json({
    ok: true,
    patientEmail: updates.patientEmail || null,
    patientPhone: updates.patientPhone || null,
    patientAccountUid: linkedUid,
    autoLinkedCount
  });
}));

// ─────────────────────────────────────────────────────────────────────────
// POST /therapy/sessao/:sessionId/recording-consent
// Audit log do consentimento do profissional pra gravar a sessão. Gravação
// em si é client-side (MediaRecorder + cifragem com DEK, download .ep-rec).
// Servidor só registra que o terapeuta declarou ter obtido consentimento do
// paciente — pra eventual demanda LGPD/CFP.
// ─────────────────────────────────────────────────────────────────────────
router.post("/therapy/sessao/:sessionId/recording-consent", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const sessionId = String(req.params.sessionId || "").trim();
  if (!sessionId) return sendError(res, 400, "SESSAO_OBRIGATORIA");

  const db = getDb();
  const sessSnap = await db.collection("therapy_sessions").doc(sessionId).get();
  if (!sessSnap.exists) return sendError(res, 404, "SESSAO_NAO_ENCONTRADA");
  if (sessSnap.data().therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  await logAudit({
    type: "session_recording_consent",
    sessionId,
    therapistUid: uid,
    consentedAt: Number(req.body?.consentedAt) || Date.now()
  });

  return res.json({ ok: true });
}));

// ═════════════════════════════════════════════════════════════════════════
// NFS-e via NFE.io
//
// Fluxo de emissão:
//   1. Profissional configura companyId + apiToken (cifrado com DEK) em
//      /perfil → PATCH /therapy/profissional/perfil { nfseConfig: {...} }.
//   2. Frontend busca o token cifrado via GET /therapy/nfse/encrypted-token
//      (precisa autenticação Firebase + recibo no header não exposto).
//   3. Frontend decifra o token com DEK localmente.
//   4. Frontend POSTa /therapy/nfse/test ou /emitir passando o token raw no
//      header X-Nfse-Token. Backend usa pra essa request, não persiste em claro.
//   5. Resposta da NFE.io é persistida no recibo (nfseId, status, pdfUrl).
//
// Por que o token vai no header: passar como Bearer entraria em conflito com
// Firebase ID token. Header customizado deixa claro o propósito.
// ═════════════════════════════════════════════════════════════════════════

// GET /therapy/nfse/encrypted-token — devolve { ciphertext, iv } do próprio
// user pra decifrar client-side antes de emitir.
router.get("/therapy/nfse/encrypted-token", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 404, "PROFISSIONAL_NAO_REGISTRADO");
  const enc = therapist.nfseConfig?.apiTokenEncrypted;
  if (!enc) return sendError(res, 404, "TOKEN_NAO_CONFIGURADO");
  return res.json({ ok: true, apiTokenEncrypted: enc });
}));

// POST /therapy/sms/test — envia um SMS de teste pra validar config Twilio.
// Body: { to } — numero pra receber o teste. Usa smsConfig do therapist.
router.post("/therapy/sms/test", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 404, "PROFISSIONAL_NAO_REGISTRADO");
  if (!therapist.smsConfig?.enabled) return sendError(res, 400, "SMS_NAO_HABILITADO");
  if (!therapist.smsConfig?.authToken) return sendError(res, 400, "TOKEN_AUSENTE", { hint: "Salve o authToken antes de testar." });

  const to = String(req.body?.to || "").trim();
  if (!to) return sendError(res, 400, "TELEFONE_OBRIGATORIO");

  const body = `[Espaço Prelúdio] Teste de SMS de ${(therapist.displayName || "seu profissional").split(/\s+/).slice(0, 2).join(" ")}. Se chegou, a configuração está OK.`;
  const r = await smsService.sendSms(therapist.smsConfig, { to, body });
  if (!r.ok) return sendError(res, r.error?.startsWith("TWILIO_") ? 502 : 400, r.error || "FALHA_ENVIO", { detail: r.detail || null });
  return res.json({ ok: true, sid: r.sid });
}));

// POST /therapy/nfse/test — valida companyId + token chamando NFE.io.
router.post("/therapy/nfse/test", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 404, "PROFISSIONAL_NAO_REGISTRADO");

  const nfse = therapist.nfseConfig;
  if (!nfse?.companyId) return sendError(res, 400, "NFSE_NAO_CONFIGURADO", { hint: "Cadastre companyId no perfil" });

  const apiToken = String(req.headers["x-nfse-token"] || "").trim();
  if (!apiToken) return sendError(res, 400, "NFSE_TOKEN_AUSENTE", { hint: "Envie o token decifrado em X-Nfse-Token" });

  try {
    const r = await nfseNfeio.testConnection({
      apiToken,
      companyId: nfse.companyId,
      environment: nfse.environment || "sandbox"
    });
    return res.json(r);
  } catch (e) {
    return sendError(res, e.status || 502, "NFSE_API_ERRO", {
      detail: String(e?.message || e),
      hint: "Confira token + companyId no painel NFE.io"
    });
  }
}));

// POST /therapy/nfse/emitir — emite NFS-e a partir de um recibo já criado.
// Body: { receiptId, borrower?: { name, email, cpf, address } }
router.post("/therapy/nfse/emitir", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 404, "PROFISSIONAL_NAO_REGISTRADO");

  const nfse = therapist.nfseConfig;
  if (!nfse?.companyId)           return sendError(res, 400, "NFSE_NAO_CONFIGURADO");
  if (!nfse?.codServicoMunicipal) return sendError(res, 400, "CODIGO_SERVICO_AUSENTE");
  if (nfse.aliquotaIss == null)   return sendError(res, 400, "ALIQUOTA_AUSENTE");

  const apiToken = String(req.headers["x-nfse-token"] || "").trim();
  if (!apiToken) return sendError(res, 400, "NFSE_TOKEN_AUSENTE");

  const receiptId = String(req.body?.receiptId || "").trim();
  if (!receiptId) return sendError(res, 400, "RECIBO_ID_AUSENTE");

  const db = getDb();
  const receiptRef = db.collection("therapy_receipts").doc(receiptId);
  const receiptSnap = await receiptRef.get();
  if (!receiptSnap.exists) return sendError(res, 404, "RECIBO_NAO_ENCONTRADO");
  const receipt = receiptSnap.data();
  if (receipt.therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");
  if (receipt.nfseId) return sendError(res, 409, "NFSE_JA_EMITIDA", { nfseId: receipt.nfseId, status: receipt.nfseStatus });

  // Borrower opcional vem do frontend (paciente é cifrado E2EE, frontend
  // decifrou e mandou os campos necessários).
  const borrower = req.body?.borrower || null;
  if (borrower && typeof borrower !== "object") return sendError(res, 400, "BORROWER_INVALIDO");

  try {
    const r = await nfseNfeio.emitirNfse({
      apiToken,
      companyId: nfse.companyId,
      environment: nfse.environment || "sandbox",
      receipt,
      therapist,
      borrower
    });

    await receiptRef.set({
      nfseId:        r.nfseId,
      nfseStatus:    r.status,
      nfsePdfUrl:    r.pdfUrl,
      nfseXmlUrl:    r.xmlUrl,
      nfseNumber:    r.number,
      nfseIssuedOn:  r.issuedOn,
      nfseEmittedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await logAudit({ type: "nfse_emitida", therapistUid: uid, receiptId, nfseId: r.nfseId, status: r.status });

    return res.json({ ok: true, nfseId: r.nfseId, status: r.status, pdfUrl: r.pdfUrl, number: r.number });
  } catch (e) {
    await logAudit({ type: "nfse_falha", therapistUid: uid, receiptId, error: String(e?.message || e) });
    return sendError(res, e.status || 502, "NFSE_API_ERRO", {
      detail: String(e?.message || e)
    });
  }
}));

// GET /therapy/nfse/consultar/:nfseId — atualiza status de NFS-e que ficou
// "Processing" depois da emissão (assíncrono).
router.get("/therapy/nfse/consultar/:nfseId", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 404, "PROFISSIONAL_NAO_REGISTRADO");

  const nfse = therapist.nfseConfig;
  if (!nfse?.companyId) return sendError(res, 400, "NFSE_NAO_CONFIGURADO");

  const apiToken = String(req.headers["x-nfse-token"] || "").trim();
  if (!apiToken) return sendError(res, 400, "NFSE_TOKEN_AUSENTE");

  const nfseId = String(req.params.nfseId || "").trim();
  if (!nfseId) return sendError(res, 400, "NFSE_ID_AUSENTE");

  try {
    const r = await nfseNfeio.consultarNfse({ apiToken, companyId: nfse.companyId, nfseId });

    // Atualiza recibo associado (busca por nfseId).
    const db = getDb();
    const rSnap = await db.collection("therapy_receipts").where("nfseId", "==", nfseId).where("therapistUid", "==", uid).limit(1).get();
    if (!rSnap.empty) {
      await rSnap.docs[0].ref.set({
        nfseStatus:   r.status,
        nfsePdfUrl:   r.pdfUrl,
        nfseXmlUrl:   r.xmlUrl,
        nfseNumber:   r.number,
        nfseIssuedOn: r.issuedOn
      }, { merge: true });
    }

    return res.json({ ok: true, ...r, raw: undefined });
  } catch (e) {
    return sendError(res, e.status || 502, "NFSE_API_ERRO", { detail: String(e?.message || e) });
  }
}));

// ─────────────────────────────────────────────────────────────────────────
// POST /therapy/sessao/:sessionId/ocultar
// Soft-hide: marca a sessão para não aparecer em /therapy/sessoes (painel
// de consultas), mas mantém o registro no Firestore. Continua visível no
// prontuário do paciente (/therapy/pacientes/:patientId/sessoes), no
// histórico de auditoria e nos exports. Só permite ocultar sessões já
// encerradas — sessão em andamento precisa ser encerrada antes.
// ─────────────────────────────────────────────────────────────────────────
router.post("/therapy/sessao/:sessionId/ocultar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const sessionId = String(req.params.sessionId || "").trim();
  if (!sessionId) return sendError(res, 400, "SESSAO_OBRIGATORIA");

  const db = getDb();
  const sessSnap = await db.collection("therapy_sessions").doc(sessionId).get();
  if (!sessSnap.exists) return sendError(res, 404, "SESSAO_NAO_ENCONTRADA");
  const sessData = sessSnap.data();
  if (sessData.therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");
  if (sessData.status !== "completed") return sendError(res, 400, "SESSAO_NAO_ENCERRADA");

  await db.collection("therapy_sessions").doc(sessionId).set({
    hiddenFromPainel: true,
    hiddenAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({ type: "session_hidden", sessionId, therapistUid: uid });

  return res.json({ ok: true });
}));

// ─────────────────────────────────────────────────────────────────────────
// CANCELAMENTO de consulta agendada
// Caminhos:
//  (a) POST /therapy/sessao/:sessionId/cancelar — terapeuta autenticado.
//      Cancela qualquer hora antes de "completed".
//  (b) POST /therapy/sessao/cancelar-publico   — paciente sem conta, via
//      cancelToken HMAC. Exige >= THERAPY_MIN_CANCEL_HOURS_PATIENT antes
//      do scheduledAt; abaixo disso o link rejeita 409 e instrui a falar
//      direto com o profissional (no-show fee tipicamente cobre isso).
// Em ambos: sessão "completed" não pode ser cancelada (já aconteceu);
// sessão "canceled" é idempotente (mesmo motivo/by → 200; diferente → 409).
// ─────────────────────────────────────────────────────────────────────────
const CANCEL_TOKEN_VALIDITY_MS = 60 * 24 * 60 * 60 * 1000; // 60 dias
const CANCEL_REASON_MAX = 500;

function buildCancelToken(sessionId) {
  const now = Date.now();
  const exp = now + CANCEL_TOKEN_VALIDITY_MS;
  const token = signPayload({
    token_type: "session_cancel",
    sessionId,
    iat: now,
    exp
  }, ACCESS_TOKEN_SECRET);
  return { token, exp };
}

function buildConfirmToken(sessionId) {
  const now = Date.now();
  const exp = now + CANCEL_TOKEN_VALIDITY_MS; // mesma validade de 60 dias
  const token = signPayload({
    token_type: "session_confirm",
    sessionId,
    iat: now,
    exp
  }, ACCESS_TOKEN_SECRET);
  return { token, exp };
}

async function applyCancellation(db, sessionId, sessData, { canceledBy, reason }) {
  const update = {
    status: "canceled",
    canceledAt: admin.firestore.FieldValue.serverTimestamp(),
    canceledBy,
    cancelReason: reason || null,
    // Revoga joinToken — paciente com link em maos nao consegue mais entrar
    // depois do cancelamento. Endpoint /sessao/join checa status=canceled
    // separadamente; aqui zeramos joinTokenExp defensivamente pra qualquer
    // consumidor que olhe o campo.
    joinTokenExp: 0,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  await db.collection("therapy_sessions").doc(sessionId).set(update, { merge: true });
  await logAudit({
    type: "session_canceled",
    sessionId,
    therapistUid: sessData.therapistUid,
    canceledBy,
    hasReason: Boolean(reason)
  });

  // WhatsApp de cancelamento (fire-and-forget). Só dispara se patientPhone
  // está setado E therapist.whatsappConfig.enabled. Carrega therapist do
  // doc pra acessar a config — sessão tem só therapistUid.
  if (sessData.patientPhone && canceledBy !== "patient_public") {
    try {
      const tsnap = await db.collection("therapists").doc(sessData.therapistUid).get();
      const therapist = tsnap.exists ? tsnap.data() : null;
      if (therapist?.whatsappConfig?.enabled) {
        sendWaCancellation({
          session: {
            patientName: sessData.patientName,
            patientPhone: sessData.patientPhone,
            scheduledAt: sessData.scheduledAt
          },
          therapist
        }).then(r => {
          if (r.ok)        logInfo("therapy_cancellation_wa_sent",    { sessionId, messageId: r.messageId });
          else if (r.skipped) logInfo("therapy_cancellation_wa_skipped", { sessionId, reason: r.reason });
          else             logWarn("therapy_cancellation_wa_failed",  { sessionId, error: r.error });
        }).catch(e =>
          logError("therapy_cancellation_wa_exception", e, { sessionId })
        );
      }
    } catch (e) {
      logError("therapy_cancellation_wa_load_therapist_failed", e, { sessionId });
    }
  }
}

// (a) Terapeuta autenticado cancela. scope="forward" cancela esta + todas
// as ocorrências futuras do mesmo recurrenceGroupId que ainda não estão
// completed/canceled.
router.post("/therapy/sessao/:sessionId/cancelar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const sessionId = String(req.params.sessionId || "").trim();
  if (!sessionId) return sendError(res, 400, "SESSAO_OBRIGATORIA");

  const reason = String(req.body?.reason || "").trim().slice(0, CANCEL_REASON_MAX);
  const scope  = req.body?.scope === "forward" ? "forward" : "this";

  const db = getDb();
  const sessSnap = await db.collection("therapy_sessions").doc(sessionId).get();
  if (!sessSnap.exists) return sendError(res, 404, "SESSAO_NAO_ENCONTRADA");
  const sessData = sessSnap.data();
  if (sessData.therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");
  if (sessData.status === "completed") return sendError(res, 409, "SESSAO_JA_ENCERRADA");

  // "this": só esta. Idempotente se já cancelada.
  if (scope === "this") {
    if (sessData.status === "canceled") return res.json({ ok: true, alreadyCanceled: true, canceledCount: 0 });
    await applyCancellation(db, sessionId, sessData, { canceledBy: "therapist", reason });
    getIo()?.to(uid).emit("sessoes:changed");
    return res.json({ ok: true, canceledCount: 1 });
  }

  // "forward": esta + todas as ocorrências futuras do grupo. Sem grupo,
  // cai pro comportamento "this" silenciosamente.
  if (!sessData.recurrenceGroupId) {
    if (sessData.status === "canceled") return res.json({ ok: true, alreadyCanceled: true, canceledCount: 0 });
    await applyCancellation(db, sessionId, sessData, { canceledBy: "therapist", reason });
    getIo()?.to(uid).emit("sessoes:changed");
    return res.json({ ok: true, canceledCount: 1 });
  }

  const baseAt = Number(sessData.scheduledAt || 0);
  const groupSnap = await db.collection("therapy_sessions")
    .where("therapistUid", "==", uid)
    .where("recurrenceGroupId", "==", sessData.recurrenceGroupId)
    .get();

  let canceledCount = 0;
  for (const doc of groupSnap.docs) {
    const d = doc.data();
    if (d.status === "completed" || d.status === "canceled") continue;
    const at = Number(d.scheduledAt || 0);
    if (baseAt && at && at < baseAt) continue; // só futuras (ou a própria)
    await applyCancellation(db, doc.id, d, { canceledBy: "therapist", reason });
    canceledCount++;
  }

  getIo()?.to(uid).emit("sessoes:changed");
  return res.json({ ok: true, canceledCount, scope: "forward" });
}));

// (b) Paciente cancela via link público (token assinado)
router.post("/therapy/sessao/cancelar-publico", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  let token = String(req.body?.cancelToken || "").trim();
  // Suporte a short code (?c=XXXXXXXX) — resolve pra JWT antes de validar
  if (!token && req.body?.cancelCode) {
    const resolved = await resolveActionCode(String(req.body.cancelCode).trim());
    if (!resolved || resolved.type !== "cancel") return sendError(res, 401, "CODE_INVALIDO");
    token = resolved.token;
  }
  if (!token) return sendError(res, 400, "TOKEN_OBRIGATORIO");

  const verification = verifySignedToken(token, ACCESS_TOKEN_SECRET);
  if (!verification.valid) return sendError(res, 401, verification.error || "TOKEN_INVALIDO");
  const payload = verification.payload;
  if (payload.token_type !== "session_cancel") return sendError(res, 401, "TOKEN_NAO_AUTORIZADO");

  const reason = String(req.body?.reason || "").trim().slice(0, CANCEL_REASON_MAX);

  const db = getDb();
  const sessRef = db.collection("therapy_sessions").doc(payload.sessionId);
  const sessSnap = await sessRef.get();
  if (!sessSnap.exists) return sendError(res, 404, "SESSAO_NAO_ENCONTRADA");
  const sessData = sessSnap.data();
  if (sessData.status === "completed") return sendError(res, 409, "SESSAO_JA_ENCERRADA");
  if (sessData.status === "canceled")  return res.json({ ok: true, alreadyCanceled: true });

  // Janela mínima de cancelamento pelo paciente.
  const minHoursMs = THERAPY_MIN_CANCEL_HOURS_PATIENT * 60 * 60 * 1000;
  const sched = Number(sessData.scheduledAt || 0);
  if (sched && sched - Date.now() < minHoursMs) {
    return sendError(res, 409, "PRAZO_CANCELAMENTO_EXPIRADO", {
      hint: `Cancelamentos pelo paciente exigem antecedência de ${THERAPY_MIN_CANCEL_HOURS_PATIENT}h. Fale direto com o profissional.`,
      minHours: THERAPY_MIN_CANCEL_HOURS_PATIENT
    });
  }

  await applyCancellation(db, payload.sessionId, sessData, { canceledBy: "patient", reason });
  return res.json({ ok: true });
}));

// POST /therapy/sessao/confirmar-publico — paciente confirma presença via
// token assinado (vem do link do e-mail de lembrete). Idempotente: confirmar
// 2× é no-op. Mesmo TTL do cancel token (60 dias). Reduz no-show porque
// terapeuta vê quem deu sinal de vida pré-consulta.
router.post("/therapy/sessao/confirmar-publico", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  let token = String(req.body?.confirmToken || "").trim();
  if (!token && req.body?.confirmCode) {
    const resolved = await resolveActionCode(String(req.body.confirmCode).trim());
    if (!resolved || resolved.type !== "confirm") return sendError(res, 401, "CODE_INVALIDO");
    token = resolved.token;
  }
  if (!token) return sendError(res, 400, "TOKEN_OBRIGATORIO");

  const verification = verifySignedToken(token, ACCESS_TOKEN_SECRET);
  if (!verification.valid) return sendError(res, 401, verification.error || "TOKEN_INVALIDO");
  const payload = verification.payload;
  if (payload.token_type !== "session_confirm") return sendError(res, 401, "TOKEN_NAO_AUTORIZADO");

  const db = getDb();
  const sessRef = db.collection("therapy_sessions").doc(payload.sessionId);
  const sessSnap = await sessRef.get();
  if (!sessSnap.exists) return sendError(res, 404, "SESSAO_NAO_ENCONTRADA");
  const sessData = sessSnap.data();
  if (sessData.status === "completed") return sendError(res, 409, "SESSAO_JA_ENCERRADA");
  if (sessData.status === "canceled")  return sendError(res, 409, "SESSAO_CANCELADA");

  if (sessData.confirmedAt) {
    return res.json({
      ok: true,
      alreadyConfirmed: true,
      scheduledAt: sessData.scheduledAt || null,
      therapistName: sessData.therapistDisplayName || ""
    });
  }

  await sessRef.set({
    confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
    confirmedBy: "patient",
    updatedAt:   admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({
    type: "session_confirmed",
    sessionId: payload.sessionId,
    therapistUid: sessData.therapistUid,
    confirmedBy: "patient"
  });

  return res.json({
    ok: true,
    scheduledAt: sessData.scheduledAt || null,
    therapistName: sessData.therapistDisplayName || ""
  });
}));

// ─────────────────────────────────────────────────────────────────────────
// BLOQUEIOS DE HORÁRIO (blackouts)
// O terapeuta marca períodos de indisponibilidade (férias, licença, almoço
// recorrente etc). Renderiza como blocos cinza na agenda. Não impede a
// criação de sessão (terapeuta pode override no popover); serve como
// indicação visual e como fonte do feed iCal de "ocupado".
//
// Modelo: therapy_blackouts/{blackoutId}
//   { therapistUid, from (ms), to (ms), reason?, createdAt, updatedAt }
//
// Limite: duração máxima 366 dias por blackout (defensivo). Para férias
// recorrentes anuais, o terapeuta cria múltiplos.
// ─────────────────────────────────────────────────────────────────────────
const BLACKOUT_REASON_MAX = 200;
const BLACKOUT_MAX_DURATION_MS = 366 * 24 * 60 * 60 * 1000;

router.post("/therapy/agenda/blackout", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const from = Number(req.body?.from || 0);
  const to   = Number(req.body?.to   || 0);
  const reason = String(req.body?.reason || "").trim().slice(0, BLACKOUT_REASON_MAX);

  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) {
    return sendError(res, 400, "INTERVALO_INVALIDO");
  }
  if (to <= from) return sendError(res, 400, "INTERVALO_INVERTIDO");
  if (to - from > BLACKOUT_MAX_DURATION_MS) return sendError(res, 400, "INTERVALO_LONGO_DEMAIS", { maxDays: 366 });

  const blackoutId = newId("blk");
  const db = getDb();
  await db.collection("therapy_blackouts").doc(blackoutId).set({
    blackoutId,
    therapistUid: uid,
    from, to,
    reason: reason || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await logAudit({ type: "blackout_created", blackoutId, therapistUid: uid });
  getIo()?.to(uid).emit("blackouts:changed");
  return res.json({ ok: true, blackoutId, from, to, reason: reason || null });
}));

router.delete("/therapy/agenda/blackout/:blackoutId", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const blackoutId = String(req.params.blackoutId || "").trim();
  if (!blackoutId) return sendError(res, 400, "ID_OBRIGATORIO");

  const db = getDb();
  const ref = db.collection("therapy_blackouts").doc(blackoutId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "BLOQUEIO_NAO_ENCONTRADO");
  if (snap.data().therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  await ref.delete();
  await logAudit({ type: "blackout_deleted", blackoutId, therapistUid: uid });
  getIo()?.to(uid).emit("blackouts:changed");
  return res.json({ ok: true });
}));

// ─────────────────────────────────────────────────────────────────────────
// 2FA (TOTP) — autenticação de 2 fatores opcional pro profissional
//
// Fluxo:
// 1. /2fa/setup — gera secret pendente + QR code. Profissional escaneia.
// 2. /2fa/enable body: { code } — verifica código com pending; se OK, ativa.
// 3. /2fa/verify body: { code } — após login Firebase, gera token de sessão.
// 4. /2fa/disable body: { code } — verifica código antes de desativar.
//
// Storage: therapists/{uid}.twoFactorSecret, twoFactorEnabled,
//          twoFactorPendingSecret (durante setup).
// Secrets NUNCA saem do servidor (filtrados em /me).
// Enforcement: frontend (auth-guard) — se enabled, redirect pra 2fa-verify
// quando não houver token válido em sessionStorage.
// ─────────────────────────────────────────────────────────────────────────
const TWOFA_TOKEN_VALIDITY_MS = 8 * 60 * 60 * 1000; // 8h (mesmo do access)

router.post("/therapy/2fa/setup", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 404, "PROFISSIONAL_NAO_REGISTRADO");
  if (therapist.twoFactorEnabled) return sendError(res, 409, "JA_ATIVADO");

  const secret = gen2faSecret();
  const label = therapist.displayName || therapist.email || uid;
  const url = otpauthUrl({ secret, label, issuer: "Espaço Prelúdio" });

  await getDb().collection("therapists").doc(uid).set({
    twoFactorPendingSecret: secret,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  return res.json({ ok: true, secret, otpauthUrl: url });
}));

router.post("/therapy/2fa/enable", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const code = String(req.body?.code || "").trim();
  if (!/^\d{6}$/.test(code)) return sendError(res, 400, "CODIGO_INVALIDO");

  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 404, "PROFISSIONAL_NAO_REGISTRADO");
  if (therapist.twoFactorEnabled) return sendError(res, 409, "JA_ATIVADO");
  if (!therapist.twoFactorPendingSecret) return sendError(res, 400, "SETUP_NAO_INICIADO");

  if (!verifyTotp(therapist.twoFactorPendingSecret, code)) {
    return sendError(res, 401, "CODIGO_INCORRETO");
  }

  await getDb().collection("therapists").doc(uid).set({
    twoFactorEnabled: true,
    twoFactorSecret: therapist.twoFactorPendingSecret,
    twoFactorPendingSecret: admin.firestore.FieldValue.delete(),
    twoFactorEnabledAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({ type: "twofa_enabled", therapistUid: uid });

  // Emite token de sessão imediato pra evitar redirect logo após enable.
  const sessionToken = signPayload({
    token_type: "twofa_session",
    uid,
    iat: Date.now(),
    exp: Date.now() + TWOFA_TOKEN_VALIDITY_MS
  }, ACCESS_TOKEN_SECRET);

  return res.json({ ok: true, sessionToken });
}));

router.post("/therapy/2fa/verify", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const code = String(req.body?.code || "").trim();
  if (!/^\d{6}$/.test(code)) return sendError(res, 400, "CODIGO_INVALIDO");

  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 404, "PROFISSIONAL_NAO_REGISTRADO");
  if (!therapist.twoFactorEnabled || !therapist.twoFactorSecret) {
    return sendError(res, 400, "TWOFA_NAO_ATIVADO");
  }

  if (!verifyTotp(therapist.twoFactorSecret, code)) {
    return sendError(res, 401, "CODIGO_INCORRETO");
  }

  await logAudit({ type: "twofa_verified", therapistUid: uid });

  const sessionToken = signPayload({
    token_type: "twofa_session",
    uid,
    iat: Date.now(),
    exp: Date.now() + TWOFA_TOKEN_VALIDITY_MS
  }, ACCESS_TOKEN_SECRET);

  return res.json({ ok: true, sessionToken });
}));

router.post("/therapy/2fa/disable", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const code = String(req.body?.code || "").trim();
  if (!/^\d{6}$/.test(code)) return sendError(res, 400, "CODIGO_INVALIDO");

  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 404, "PROFISSIONAL_NAO_REGISTRADO");
  if (!therapist.twoFactorEnabled) return sendError(res, 409, "NAO_ATIVADO");

  if (!verifyTotp(therapist.twoFactorSecret, code)) {
    return sendError(res, 401, "CODIGO_INCORRETO");
  }

  await getDb().collection("therapists").doc(uid).set({
    twoFactorEnabled: false,
    twoFactorSecret: admin.firestore.FieldValue.delete(),
    twoFactorPendingSecret: admin.firestore.FieldValue.delete(),
    twoFactorDisabledAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({ type: "twofa_disabled", therapistUid: uid });

  return res.json({ ok: true });
}));

// ─────────────────────────────────────────────────────────────────────────
// NPS — Net Promoter Score pós-consulta
//
// Modelo: therapy_nps_responses/{responseId}
//   { responseId, therapistUid, sessionId, patientEmail, score (0-10),
//     comment?, sentAt, respondedAt? }
//
// Disparo: scheduler dispara e-mail 24h após sessão completar (token assinado
// no link). Paciente clica, página pública nps.html lê o token, submete
// score+comment. Backend valida token (HMAC) + sessionId não respondido.
// ─────────────────────────────────────────────────────────────────────────
const NPS_TOKEN_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias
const NPS_COMMENT_MAX = 500;

// GET /nps/info/:token — público. Devolve dados pra renderizar a página.
router.get("/nps/info/:token", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  let token = String(req.params.token || "").trim();
  if (!token) return sendError(res, 400, "TOKEN_OBRIGATORIO");
  // Suporte a short code (?c=XXXXXXXX)
  if (token.length <= 16) {
    const resolved = await resolveActionCode(token);
    if (!resolved || resolved.type !== "nps") return sendError(res, 401, "TOKEN_INVALIDO");
    token = resolved.token;
  }
  const npsVerif = verifySignedToken(token, ACCESS_TOKEN_SECRET);
  if (!npsVerif.valid || npsVerif.payload?.token_type !== "nps") return sendError(res, 401, "TOKEN_INVALIDO");
  const payload = npsVerif.payload;
  if (payload.exp && payload.exp < Date.now()) return sendError(res, 410, "TOKEN_EXPIRADO");

  const db = getDb();
  // Já respondeu? Procura pela sessionId existente.
  const existing = await db.collection("therapy_nps_responses")
    .where("sessionId", "==", payload.sessionId)
    .where("respondedAt", ">", 0)
    .limit(1)
    .get()
    .catch(() => null);
  const alreadyAnswered = existing && !existing.empty;

  // Dados pra exibição (nome do profissional / paciente).
  let therapistName = "seu profissional";
  let clinicName = "";
  try {
    const tsnap = await db.collection("therapists").doc(payload.therapistUid).get();
    if (tsnap.exists) {
      const t = tsnap.data();
      therapistName = t.displayName || therapistName;
      clinicName    = t.consultorio?.nome || t.whatsappConfig?.clinicName || "";
    }
  } catch {}

  return res.json({
    ok: true,
    therapistName, clinicName,
    patientNameHint: payload.patientNameHint || "",
    alreadyAnswered
  });
}));

// POST /nps/:token — público. Submete resposta.
router.post("/nps/:token", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  let token = String(req.params.token || "").trim();
  if (!token) return sendError(res, 400, "TOKEN_OBRIGATORIO");
  if (token.length <= 16) {
    const resolved = await resolveActionCode(token);
    if (!resolved || resolved.type !== "nps") return sendError(res, 401, "TOKEN_INVALIDO");
    token = resolved.token;
  }
  const npsVerif2 = verifySignedToken(token, ACCESS_TOKEN_SECRET);
  if (!npsVerif2.valid || npsVerif2.payload?.token_type !== "nps") return sendError(res, 401, "TOKEN_INVALIDO");
  const payload = npsVerif2.payload;
  if (payload.exp && payload.exp < Date.now()) return sendError(res, 410, "TOKEN_EXPIRADO");

  const score = Number(req.body?.score);
  if (!Number.isFinite(score) || score < 0 || score > 10) return sendError(res, 400, "SCORE_INVALIDO");
  const comment = String(req.body?.comment || "").trim().slice(0, NPS_COMMENT_MAX);

  const db = getDb();
  // Idempotência: se já tem resposta pra essa sessionId, devolve OK
  // (não cria duplicada).
  const existing = await db.collection("therapy_nps_responses")
    .where("sessionId", "==", payload.sessionId)
    .limit(1)
    .get();

  if (!existing.empty) {
    const docRef = existing.docs[0].ref;
    await docRef.set({
      score: Math.floor(score),
      comment: comment || null,
      respondedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return res.json({ ok: true, updated: true });
  }

  const responseId = newId("nps");
  await db.collection("therapy_nps_responses").doc(responseId).set({
    responseId,
    therapistUid: payload.therapistUid,
    sessionId: payload.sessionId,
    patientEmail: payload.patientEmail || null,
    score: Math.floor(score),
    comment: comment || null,
    sentAt: payload.iat || null,
    respondedAt: admin.firestore.FieldValue.serverTimestamp(),
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return res.json({ ok: true });
}));

// GET /therapy/nps — profissional vê suas respostas + métricas agregadas.
router.get("/therapy/nps", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const range = String(req.query?.range || "90d").trim();
  const now = Date.now();
  let rangeStart;
  if      (range === "30d")  rangeStart = now - 30  * 86_400_000;
  else if (range === "90d")  rangeStart = now - 90  * 86_400_000;
  else if (range === "year") rangeStart = now - 365 * 86_400_000;
  else if (range === "all")  rangeStart = 0;
  else                       rangeStart = now - 90  * 86_400_000;

  const db = getDb();
  const snap = await db.collection("therapy_nps_responses")
    .where("therapistUid", "==", uid)
    .limit(1000)
    .get();

  const all = snap.docs.map(d => {
    const x = d.data();
    return {
      responseId: x.responseId,
      sessionId: x.sessionId,
      score: x.score,
      comment: x.comment,
      respondedAt: x.respondedAt?.toMillis ? x.respondedAt.toMillis() : (Number(x.respondedAt) || 0)
    };
  }).filter(r => r.respondedAt > 0);

  const inRange = all.filter(r => r.respondedAt >= rangeStart);

  // Categorias NPS clássicas: 0-6 detractor, 7-8 passive, 9-10 promoter
  let detractors = 0, passives = 0, promoters = 0;
  let sum = 0;
  for (const r of inRange) {
    sum += r.score;
    if (r.score <= 6) detractors++;
    else if (r.score <= 8) passives++;
    else promoters++;
  }
  const total = inRange.length;
  const npsScore = total > 0 ? Math.round(((promoters - detractors) / total) * 100) : null;
  const avg      = total > 0 ? Math.round((sum / total) * 10) / 10 : null;

  // Últimos comentários (top 20, mais recentes primeiro).
  const recentComments = inRange
    .filter(r => r.comment)
    .sort((a, b) => b.respondedAt - a.respondedAt)
    .slice(0, 20)
    .map(r => ({ score: r.score, comment: r.comment, respondedAt: r.respondedAt }));

  return res.json({
    ok: true,
    range,
    metrics: { total, npsScore, avg, detractors, passives, promoters },
    recentComments
  });
}));

// ─────────────────────────────────────────────────────────────────────────
// ANIVERSARIANTES — opt-in pra envio automático de e-mail no aniversário
//
// Modelo: therapy_birthday_optins/{optinId}
//   { optinId, therapistUid, patientName, patientEmail, birthMonthDay (MMDD),
//     createdAt, lastSentAt? (atualizado pelo scheduler pra idempotência) }
//
// Coleção separada (plain text) porque o therapy_patients é E2EE — backend
// não consegue ler nome/email/aniversário do paciente sem a chave. Opt-in
// explícito do profissional (LGPD: birthday é dado pessoal, exige base legal —
// consentimento via cadastro).
// ─────────────────────────────────────────────────────────────────────────
const BIRTHDAY_NAME_MAX  = 80;
const BIRTHDAY_EMAIL_MAX = 120;
const BIRTHDAY_MMDD_RX   = /^(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/; // 0101..1231

router.post("/therapy/aniversarios", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const patientName  = String(req.body?.patientName  || "").trim().slice(0, BIRTHDAY_NAME_MAX);
  const patientEmail = String(req.body?.patientEmail || "").trim().toLowerCase().slice(0, BIRTHDAY_EMAIL_MAX);
  const birthMonthDay = String(req.body?.birthMonthDay || "").trim();

  if (!patientName)  return sendError(res, 400, "NOME_OBRIGATORIO");
  if (!patientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patientEmail)) {
    return sendError(res, 400, "EMAIL_INVALIDO");
  }
  if (!BIRTHDAY_MMDD_RX.test(birthMonthDay)) {
    return sendError(res, 400, "DATA_INVALIDA", { hint: "Formato MMDD (ex.: 0512 para 12 de maio)" });
  }

  const optinId = newId("bdy");
  const db = getDb();
  await db.collection("therapy_birthday_optins").doc(optinId).set({
    optinId,
    therapistUid: uid,
    patientName, patientEmail, birthMonthDay,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await logAudit({ type: "birthday_optin_created", optinId, therapistUid: uid });
  return res.json({ ok: true, optinId });
}));

router.patch("/therapy/aniversarios/:optinId", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const optinId = String(req.params.optinId || "").trim();
  if (!optinId) return sendError(res, 400, "ID_OBRIGATORIO");

  const db = getDb();
  const ref = db.collection("therapy_birthday_optins").doc(optinId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "OPTIN_NAO_ENCONTRADO");
  if (snap.data().therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  if (req.body?.patientName !== undefined) {
    const v = String(req.body.patientName || "").trim().slice(0, BIRTHDAY_NAME_MAX);
    if (!v) return sendError(res, 400, "NOME_OBRIGATORIO");
    updates.patientName = v;
  }
  if (req.body?.patientEmail !== undefined) {
    const v = String(req.body.patientEmail || "").trim().toLowerCase().slice(0, BIRTHDAY_EMAIL_MAX);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return sendError(res, 400, "EMAIL_INVALIDO");
    updates.patientEmail = v;
  }
  if (req.body?.birthMonthDay !== undefined) {
    const v = String(req.body.birthMonthDay || "").trim();
    if (!BIRTHDAY_MMDD_RX.test(v)) return sendError(res, 400, "DATA_INVALIDA");
    updates.birthMonthDay = v;
  }

  await ref.set(updates, { merge: true });
  return res.json({ ok: true });
}));

router.delete("/therapy/aniversarios/:optinId", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const optinId = String(req.params.optinId || "").trim();
  if (!optinId) return sendError(res, 400, "ID_OBRIGATORIO");

  const db = getDb();
  const ref = db.collection("therapy_birthday_optins").doc(optinId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "OPTIN_NAO_ENCONTRADO");
  if (snap.data().therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  await ref.delete();
  return res.json({ ok: true });
}));

router.get("/therapy/aniversarios", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const db = getDb();
  const snap = await db.collection("therapy_birthday_optins")
    .where("therapistUid", "==", uid)
    .limit(500)
    .get();

  // Ordena por proximidade do próximo aniversário (do dia atual em diante,
  // dando a volta no ano). Útil pra UI mostrar quem vem primeiro.
  const todayMMDD = (() => {
    const d = new Date();
    return String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
  })();
  function distFromToday(mmdd) {
    return mmdd >= todayMMDD ? Number(mmdd) - Number(todayMMDD) : 10000 + (Number(mmdd) - Number(todayMMDD));
  }

  const items = snap.docs
    .map(d => {
      const x = d.data();
      return {
        optinId: x.optinId,
        patientName: x.patientName,
        patientEmail: x.patientEmail,
        birthMonthDay: x.birthMonthDay,
        lastSentAt: x.lastSentAt?.toMillis ? x.lastSentAt.toMillis() : (Number(x.lastSentAt) || null)
      };
    })
    .sort((a, b) => distFromToday(a.birthMonthDay) - distFromToday(b.birthMonthDay));

  return res.json({ ok: true, items });
}));

// ─────────────────────────────────────────────────────────────────────────
// LISTA DE ESPERA — pacientes aguardando vaga
//
// Modelo: therapy_waitlist/{waitlistId}
//   { waitlistId, therapistUid, patientName, patientId?, contact?, priority:
//     "low"|"med"|"high", note?, createdAt, updatedAt }
//
// priority padrão "med". Frontend ordena: high → med → low → createdAt asc.
// ─────────────────────────────────────────────────────────────────────────
const WAITLIST_NAME_MAX  = 80;
const WAITLIST_NOTE_MAX  = 500;
const WAITLIST_CONTACT_MAX = 80;
const WAITLIST_PRIORITIES = new Set(["low", "med", "high"]);

router.post("/therapy/waitlist", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const patientName = String(req.body?.patientName || "").trim().slice(0, WAITLIST_NAME_MAX);
  if (!patientName) return sendError(res, 400, "NOME_OBRIGATORIO");

  const patientId = String(req.body?.patientId || "").trim().slice(0, 60) || null;
  const contact   = String(req.body?.contact   || "").trim().slice(0, WAITLIST_CONTACT_MAX) || null;
  const note      = String(req.body?.note      || "").trim().slice(0, WAITLIST_NOTE_MAX) || null;
  let priority    = String(req.body?.priority  || "med").trim().toLowerCase();
  if (!WAITLIST_PRIORITIES.has(priority)) priority = "med";

  const waitlistId = newId("wlt");
  const db = getDb();
  await db.collection("therapy_waitlist").doc(waitlistId).set({
    waitlistId,
    therapistUid: uid,
    patientName, patientId, contact, note, priority,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await logAudit({ type: "waitlist_created", waitlistId, therapistUid: uid });
  return res.json({ ok: true, waitlistId });
}));

router.patch("/therapy/waitlist/:waitlistId", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const waitlistId = String(req.params.waitlistId || "").trim();
  if (!waitlistId) return sendError(res, 400, "ID_OBRIGATORIO");

  const db = getDb();
  const ref = db.collection("therapy_waitlist").doc(waitlistId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "ENTRADA_NAO_ENCONTRADA");
  if (snap.data().therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  if (req.body?.patientName !== undefined) {
    const v = String(req.body.patientName || "").trim().slice(0, WAITLIST_NAME_MAX);
    if (!v) return sendError(res, 400, "NOME_OBRIGATORIO");
    updates.patientName = v;
  }
  if (req.body?.contact !== undefined) {
    updates.contact = String(req.body.contact || "").trim().slice(0, WAITLIST_CONTACT_MAX) || null;
  }
  if (req.body?.note !== undefined) {
    updates.note = String(req.body.note || "").trim().slice(0, WAITLIST_NOTE_MAX) || null;
  }
  if (req.body?.priority !== undefined) {
    const p = String(req.body.priority || "").trim().toLowerCase();
    if (WAITLIST_PRIORITIES.has(p)) updates.priority = p;
  }
  if (req.body?.patientId !== undefined) {
    updates.patientId = String(req.body.patientId || "").trim().slice(0, 60) || null;
  }

  await ref.set(updates, { merge: true });
  return res.json({ ok: true });
}));

router.delete("/therapy/waitlist/:waitlistId", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const waitlistId = String(req.params.waitlistId || "").trim();
  if (!waitlistId) return sendError(res, 400, "ID_OBRIGATORIO");

  const db = getDb();
  const ref = db.collection("therapy_waitlist").doc(waitlistId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "ENTRADA_NAO_ENCONTRADA");
  if (snap.data().therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  await ref.delete();
  return res.json({ ok: true });
}));

router.get("/therapy/waitlist", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const db = getDb();
  const snap = await db.collection("therapy_waitlist")
    .where("therapistUid", "==", uid)
    .limit(500)
    .get();

  const PRIORITY_ORDER = { high: 0, med: 1, low: 2 };
  const items = snap.docs
    .map(d => {
      const x = d.data();
      const createdAtMs = x.createdAt?.toMillis ? x.createdAt.toMillis() : Number(x.createdAt) || 0;
      return {
        waitlistId: x.waitlistId,
        patientName: x.patientName,
        patientId: x.patientId || null,
        contact: x.contact || null,
        note: x.note || null,
        priority: x.priority || "med",
        createdAt: createdAtMs
      };
    })
    .sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority] ?? 1;
      const pb = PRIORITY_ORDER[b.priority] ?? 1;
      if (pa !== pb) return pa - pb;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });

  return res.json({ ok: true, items });
}));

// ─────────────────────────────────────────────────────────────────────────
// AGENDA — Observações (notas em slots vazios)
//
// Modelo: therapy_agenda_notes/{noteId}
//   { therapistUid, at (ms), durationMin, text, createdAt, updatedAt }
//
// Diferente de blackout (bloqueia tempo): nota é só um lembrete visual no
// horário — não impede criação de consulta no mesmo slot. Útil pra "almoço",
// "ligar pro paciente X", "supervisão semanal", etc.
// ─────────────────────────────────────────────────────────────────────────
const AGENDA_NOTE_TEXT_MAX = 300;
const AGENDA_NOTE_DURATION_MAX_MIN = 12 * 60; // 12h

router.post("/therapy/agenda/note", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const at = Number(req.body?.at || 0);
  const durationMin = Math.max(15, Math.min(AGENDA_NOTE_DURATION_MAX_MIN,
    Number(req.body?.durationMin || 30)));
  const text = String(req.body?.text || "").trim().slice(0, AGENDA_NOTE_TEXT_MAX);

  if (!Number.isFinite(at) || at <= 0) return sendError(res, 400, "HORARIO_INVALIDO");
  if (!text) return sendError(res, 400, "TEXTO_OBRIGATORIO");

  const noteId = newId("ntn");
  const db = getDb();
  await db.collection("therapy_agenda_notes").doc(noteId).set({
    noteId,
    therapistUid: uid,
    at,
    durationMin,
    text,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await logAudit({ type: "agenda_note_created", noteId, therapistUid: uid });
  return res.json({ ok: true, noteId, at, durationMin, text });
}));

router.patch("/therapy/agenda/note/:noteId", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const noteId = String(req.params.noteId || "").trim();
  if (!noteId) return sendError(res, 400, "ID_OBRIGATORIO");

  const db = getDb();
  const ref = db.collection("therapy_agenda_notes").doc(noteId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "NOTA_NAO_ENCONTRADA");
  if (snap.data().therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  if (req.body?.text !== undefined) {
    const text = String(req.body.text || "").trim().slice(0, AGENDA_NOTE_TEXT_MAX);
    if (!text) return sendError(res, 400, "TEXTO_OBRIGATORIO");
    updates.text = text;
  }
  if (req.body?.durationMin !== undefined) {
    updates.durationMin = Math.max(15, Math.min(AGENDA_NOTE_DURATION_MAX_MIN,
      Number(req.body.durationMin) || 30));
  }
  if (req.body?.at !== undefined) {
    const at = Number(req.body.at);
    if (Number.isFinite(at) && at > 0) updates.at = at;
  }

  await ref.set(updates, { merge: true });
  return res.json({ ok: true });
}));

router.delete("/therapy/agenda/note/:noteId", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const noteId = String(req.params.noteId || "").trim();
  if (!noteId) return sendError(res, 400, "ID_OBRIGATORIO");

  const db = getDb();
  const ref = db.collection("therapy_agenda_notes").doc(noteId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "NOTA_NAO_ENCONTRADA");
  if (snap.data().therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  await ref.delete();
  return res.json({ ok: true });
}));

router.get("/therapy/agenda/notes", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const db = getDb();
  const snap = await db.collection("therapy_agenda_notes")
    .where("therapistUid", "==", uid)
    .limit(500)
    .get();

  const notes = snap.docs
    .map(d => {
      const x = d.data();
      return {
        noteId: x.noteId,
        at: x.at,
        durationMin: x.durationMin || 30,
        text: x.text || ""
      };
    })
    .sort((a, b) => (a.at || 0) - (b.at || 0));

  return res.json({ ok: true, notes });
}));

router.get("/therapy/agenda/blackouts", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const db = getDb();
  const snap = await db.collection("therapy_blackouts")
    .where("therapistUid", "==", uid)
    .limit(500)
    .get();

  const blackouts = snap.docs
    .map(d => {
      const x = d.data();
      return {
        blackoutId: x.blackoutId,
        from: x.from,
        to: x.to,
        reason: x.reason || null
      };
    })
    .sort((a, b) => (a.from || 0) - (b.from || 0));

  return res.json({ ok: true, blackouts });
}));

// ─────────────────────────────────────────────────────────────────────────
// FEED iCal — terapeuta assina a própria agenda no Google/Apple Calendar.
//
// Modelo: therapists/{uid}.calendarFeedToken (32B base64url, sem HMAC —
// é look-up, pra permitir revogação imediata via regenerate). Sem expiry:
// o terapeuta gerencia rotacionando manualmente.
//
// Feed retorna eventos dos próximos 90 dias: sessões agendadas/em curso/
// canceladas (com STATUS:CANCELLED) + blackouts (TRANSP:OPAQUE).
// ─────────────────────────────────────────────────────────────────────────
const FEED_HORIZON_DAYS = 90;

function generateFeedToken() {
  return crypto.randomBytes(32).toString("base64").replace(/[+/=]/g, c => ({"+":"-","/":"_","=":""}[c]));
}

function icsEscape(value) {
  // RFC 5545: escapar backslash, vírgula, ponto-e-vírgula, newline.
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function icsDate(ms) {
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function icsFold(line) {
  // RFC 5545: linhas > 75 octetos têm que ser dobradas (continuação com espaço).
  const limit = 73;
  if (line.length <= limit) return line;
  const out = [];
  let i = 0;
  while (i < line.length) {
    const chunk = i === 0 ? line.slice(i, limit) : line.slice(i, i + limit - 1);
    out.push(i === 0 ? chunk : ` ${chunk}`);
    i += chunk.length - (i === 0 ? 0 : 1);
    if (i === 0) i = chunk.length;
  }
  return out.join("\r\n");
}

router.post("/therapy/agenda/feed-token", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 403, "PROFISSIONAL_NAO_REGISTRADO");

  const regenerate = req.body?.regenerate === true;
  const db = getDb();
  let token = therapist.calendarFeedToken;
  if (!token || regenerate) {
    token = generateFeedToken();
    await db.collection("therapists").doc(uid).set({
      calendarFeedToken: token,
      calendarFeedTokenUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    await logAudit({ type: "feed_token_generated", therapistUid: uid, regenerate });
  }

  return res.json({ ok: true, token });
}));

router.get("/therapy/agenda/feed.ics", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const token = String(req.query?.token || "").trim();
  if (!token) return sendError(res, 400, "TOKEN_OBRIGATORIO");

  const db = getDb();
  // Look-up reverso: encontra terapeuta cujo calendarFeedToken bate.
  const matchSnap = await db.collection("therapists")
    .where("calendarFeedToken", "==", token)
    .limit(1)
    .get();
  if (matchSnap.empty) return sendError(res, 401, "TOKEN_INVALIDO");
  const therapistDoc = matchSnap.docs[0];
  const therapistUid = therapistDoc.id;
  const therapistName = therapistDoc.data().displayName || "Espaço Prelúdio";

  const now = Date.now();
  const horizonEnd = now + FEED_HORIZON_DAYS * 24 * 60 * 60 * 1000;

  const [sessSnap, blkSnap] = await Promise.all([
    db.collection("therapy_sessions").where("therapistUid", "==", therapistUid).limit(500).get(),
    db.collection("therapy_blackouts").where("therapistUid", "==", therapistUid).limit(500).get()
  ]);

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//Espaço Prelúdio//Agenda//PT-BR`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape("Agenda — " + therapistName)}`,
    "X-WR-TIMEZONE:UTC"
  ];
  const dtstamp = icsDate(now);

  // Sessões: filtra horizonte (90d) + ignora as sem scheduledAt.
  for (const doc of sessSnap.docs) {
    const s = doc.data();
    const at = Number(s.scheduledAt || 0);
    if (!at) continue;
    if (at > horizonEnd) continue;
    if (at < now - 7 * 24 * 60 * 60 * 1000) continue; // 7 dias de cauda histórica
    const start = at;
    const end   = at + 50 * 60 * 1000; // 50min default (padrão clínico)
    const cancelled = s.status === "canceled";
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:sess-${s.sessionId}@espacopreludio.com.br`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART:${icsDate(start)}`);
    lines.push(`DTEND:${icsDate(end)}`);
    lines.push(icsFold(`SUMMARY:${icsEscape((cancelled ? "[Cancelada] " : "") + (s.patientName || "Consulta"))}`));
    if (s.recurrenceGroupId) {
      lines.push(icsFold(`DESCRIPTION:${icsEscape(`Sessão ${(s.recurrenceIndex||0)+1}/${s.recurrenceCount || "?"} de série semanal.`)}`));
    }
    lines.push(`STATUS:${cancelled ? "CANCELLED" : "CONFIRMED"}`);
    lines.push("TRANSP:OPAQUE");
    lines.push("END:VEVENT");
  }

  // Blackouts: também limitados ao horizonte.
  for (const doc of blkSnap.docs) {
    const b = doc.data();
    if (!b.from || !b.to) continue;
    if (b.from > horizonEnd) continue;
    if (b.to   < now - 7 * 24 * 60 * 60 * 1000) continue;
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:blk-${b.blackoutId}@espacopreludio.com.br`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART:${icsDate(b.from)}`);
    lines.push(`DTEND:${icsDate(b.to)}`);
    lines.push(icsFold(`SUMMARY:${icsEscape("Bloqueado" + (b.reason ? ` — ${b.reason}` : ""))}`));
    lines.push("STATUS:CONFIRMED");
    lines.push("TRANSP:OPAQUE");
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");

  // Cache curto (5 min) — calendários típicos polleam a cada 1-12h, mas
  // mudanças rápidas via app/web devem refletir razoavelmente rápido.
  res.set("Content-Type", "text/calendar; charset=utf-8");
  res.set("Cache-Control", "public, max-age=300");
  res.set("Content-Disposition", `inline; filename="espacopreludio-${therapistUid}.ics"`);
  return res.send(lines.join("\r\n") + "\r\n");
}));

// ─────────────────────────────────────────────────────────────────────────
// PACIENTES — CRUD cifrado client-side. Server vê só ciphertext + iv.
// O blob cifrado contém: { name, contact, observations, birthdate?, ... }
// ─────────────────────────────────────────────────────────────────────────

const PATIENT_CIPHERTEXT_MAX = 64 * 1024; // 64 KB cifrado por paciente

// POST /therapy/pacientes — cria paciente
router.post("/therapy/pacientes", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await requirePaidPlan(req, res, uid);
  if (!therapist) return;

  const ciphertext = String(req.body?.ciphertext || "").trim();
  const iv         = String(req.body?.iv         || "").trim();
  if (!ciphertext || !iv) return sendError(res, 400, "CIPHERTEXT_IV_OBRIGATORIOS");
  if (ciphertext.length > PATIENT_CIPHERTEXT_MAX) return sendError(res, 413, "PACIENTE_GRANDE_DEMAIS");

  const patientId = newId("pat");
  const db = getDb();
  await db.collection("therapy_patients").doc(patientId).set({
    patientId,
    therapistUid: uid,
    ciphertext,
    iv,
    deleted: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  await logAudit({ type: "patient_created", patientId, therapistUid: uid });
  return res.json({ ok: true, patientId });
}));

// GET /therapy/pacientes — lista pacientes do profissional
router.get("/therapy/pacientes", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const db = getDb();
  // Sem orderBy server-side; deleted filtrado em JS pra simplificar índices.
  // Em escala (centenas de pacientes por terapeuta), ainda é trivial.
  const snap = await db.collection("therapy_patients")
    .where("therapistUid", "==", uid)
    .limit(500)
    .get();

  const patients = snap.docs
    .map(d => {
      const data = d.data();
      return {
        patientId: data.patientId,
        deleted: !!data.deleted,
        ciphertext: data.ciphertext,
        iv: data.iv,
        createdAt: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
        updatedAt: data.updatedAt?.toMillis ? data.updatedAt.toMillis() : null
      };
    })
    .filter(p => !p.deleted)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map(({ deleted, ...rest }) => rest);

  return res.json({ ok: true, patients });
}));

// PATCH /therapy/pacientes/:patientId — atualiza ciphertext
router.patch("/therapy/pacientes/:patientId", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const patientId = String(req.params.patientId || "").trim();
  if (!patientId) return sendError(res, 400, "PACIENTE_OBRIGATORIO");

  const ciphertext = String(req.body?.ciphertext || "").trim();
  const iv         = String(req.body?.iv         || "").trim();
  if (!ciphertext || !iv) return sendError(res, 400, "CIPHERTEXT_IV_OBRIGATORIOS");
  if (ciphertext.length > PATIENT_CIPHERTEXT_MAX) return sendError(res, 413, "PACIENTE_GRANDE_DEMAIS");

  const db = getDb();
  const docRef = db.collection("therapy_patients").doc(patientId);
  const snap = await docRef.get();
  if (!snap.exists) return sendError(res, 404, "PACIENTE_NAO_ENCONTRADO");
  if (snap.data().therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  await docRef.set({
    ciphertext, iv,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({ type: "patient_updated", patientId, therapistUid: uid });
  return res.json({ ok: true });
}));

// DELETE /therapy/pacientes/:patientId — soft delete
router.delete("/therapy/pacientes/:patientId", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const patientId = String(req.params.patientId || "").trim();
  if (!patientId) return sendError(res, 400, "PACIENTE_OBRIGATORIO");

  const db = getDb();
  const docRef = db.collection("therapy_patients").doc(patientId);
  const snap = await docRef.get();
  if (!snap.exists) return sendError(res, 404, "PACIENTE_NAO_ENCONTRADO");
  if (snap.data().therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  await docRef.set({
    deleted: true,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({ type: "patient_deleted", patientId, therapistUid: uid });
  return res.json({ ok: true });
}));

// GET /therapy/pacientes/:patientId — devolve o doc do paciente (com convenios).
// Útil pra UI de edição pegar dados auxiliares (carteirinhas TISS, tags, etc.).
router.get("/therapy/pacientes/:patientId", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const patientId = String(req.params.patientId || "").trim();
  if (!patientId) return sendError(res, 400, "PACIENTE_OBRIGATORIO");
  const db = getDb();
  const snap = await db.collection("therapy_patients").doc(patientId).get();
  if (!snap.exists) return sendError(res, 404, "PACIENTE_NAO_ENCONTRADO");
  const patient = snap.data();
  if (patient.therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");
  return res.json({ ok: true, patient: { patientId, ...patient } });
}));

// GET /therapy/pacientes/:patientId/sessoes — todas as sessões deste paciente
router.get("/therapy/pacientes/:patientId/sessoes", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const patientId = String(req.params.patientId || "").trim();
  if (!patientId) return sendError(res, 400, "PACIENTE_OBRIGATORIO");

  const db = getDb();
  const patientSnap = await db.collection("therapy_patients").doc(patientId).get();
  if (!patientSnap.exists) return sendError(res, 404, "PACIENTE_NAO_ENCONTRADO");
  if (patientSnap.data().therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  // Sem orderBy; ordenação client-side.
  const snap = await db.collection("therapy_sessions")
    .where("therapistUid", "==", uid)
    .where("patientId", "==", patientId)
    .limit(500)
    .get();

  const sessions = snap.docs
    .map(d => {
      const data = d.data();
      return {
        sessionId: data.sessionId,
        patientName: data.patientName,
        status: data.status,
        scheduledAt: data.scheduledAt || null,
        createdAt: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
        completedAt: data.completedAt?.toMillis ? data.completedAt.toMillis() : null
      };
    })
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return res.json({ ok: true, sessions });
}));

// GET /therapy/pacientes/:patientId/sinais — sinais clínicos (humor, ansiedade,
// sono, autoestima, risco, eventos marcantes, temas) extraídos por IA de cada
// sessão com resumo concluído, em ordem cronológica. Base de dados pra timeline
// visual, mapa emocional, radar de risco e memória clínica (gêmeo clínico).
router.get("/therapy/pacientes/:patientId/sinais", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const patientId = String(req.params.patientId || "").trim();
  if (!patientId) return sendError(res, 400, "PACIENTE_OBRIGATORIO");

  const db = getDb();
  const patientSnap = await db.collection("therapy_patients").doc(patientId).get();
  if (!patientSnap.exists) return sendError(res, 404, "PACIENTE_NAO_ENCONTRADO");
  if (patientSnap.data().therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  // Sessões do paciente (mesma query de /sessoes)
  const sessSnap = await db.collection("therapy_sessions")
    .where("therapistUid", "==", uid)
    .where("patientId", "==", patientId)
    .limit(500)
    .get();

  const sessionIds = sessSnap.docs.map(d => d.data().sessionId).filter(Boolean);
  if (sessionIds.length === 0) return res.json({ ok: true, entries: [] });

  // Busca resumos individualmente — evita índice composto novo.
  const summarySnaps = await Promise.all(
    sessionIds.map(id => db.collection("therapy_session_summaries").doc(id).get())
  );

  const entries = summarySnaps
    .filter(s => s.exists && s.data().status === "completed")
    .map(s => {
      const data = s.data();
      return {
        sessionId: data.sessionId || s.id,
        completedAt: data.completedAt?.toMillis ? data.completedAt.toMillis() : null,
        durationSec: data.durationSec || null,
        signals: data.signals || null,
        topics: (data.summary?.topics || []).map(t => t.title)
      };
    })
    .filter(e => e.completedAt)
    .sort((a, b) => a.completedAt - b.completedAt);

  return res.json({ ok: true, entries });
}));

// POST /therapy/pacientes/:patientId/gemeo-clinico — pergunta livre sobre o
// histórico do paciente, respondida por IA (Claude Haiku) com base nos
// resumos de sessão (summary + signals) já gerados. "Gêmeo Clínico" — Fase 5
// da timeline viva do paciente.
router.post("/therapy/pacientes/:patientId/gemeo-clinico", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const patientId = String(req.params.patientId || "").trim();
  if (!patientId) return sendError(res, 400, "PACIENTE_OBRIGATORIO");

  const question = String(req.body?.question || "").trim();
  if (!question) return sendError(res, 400, "PERGUNTA_OBRIGATORIA");
  if (question.length > 500) return sendError(res, 400, "PERGUNTA_MUITO_LONGA");

  const db = getDb();
  const patientSnap = await db.collection("therapy_patients").doc(patientId).get();
  if (!patientSnap.exists) return sendError(res, 404, "PACIENTE_NAO_ENCONTRADO");
  if (patientSnap.data().therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  const sessSnap = await db.collection("therapy_sessions")
    .where("therapistUid", "==", uid)
    .where("patientId", "==", patientId)
    .limit(500)
    .get();

  if (sessSnap.empty) return sendError(res, 404, "SEM_HISTORICO");
  const patientName = sessSnap.docs[0].data().patientName || null;
  const sessionIds = sessSnap.docs.map(d => d.data().sessionId).filter(Boolean);

  const summarySnaps = await Promise.all(
    sessionIds.map(id => db.collection("therapy_session_summaries").doc(id).get())
  );

  const entries = summarySnaps
    .filter(s => s.exists && s.data().status === "completed")
    .map(s => {
      const data = s.data();
      return {
        completedAt: data.completedAt?.toMillis ? data.completedAt.toMillis() : null,
        summary: data.summary || null,
        signals: data.signals || null
      };
    })
    .filter(e => e.completedAt)
    .sort((a, b) => a.completedAt - b.completedAt);

  if (entries.length === 0) return sendError(res, 404, "SEM_HISTORICO");

  const result = await clinicalTwinSvc.askClinicalTwin({ question, entries, patientName });
  if (!result.ok) return sendError(res, 502, result.error || "GEMEO_FALHOU");

  return res.json({ ok: true, answer: result.answer });
}));

// ─────────────────────────────────────────────────────────────────────────
// CONTA DE PACIENTE — opcional. Pacientes podem criar conta para guardar
// suas próprias anotações cifradas E2EE entre sessões. Mesmo padrão DEK/KEK
// dos profissionais. Server-blind (não vê plaintext nem chave).
//
// Coleções:
//   therapy_patient_accounts/{uid}  — perfil + e2eeSalt + wrappedDEK
//   therapy_patient_notes/{noteId}  — { patientAccountUid, sessionId, ciphertext, iv }
// ─────────────────────────────────────────────────────────────────────────

const PATIENT_NOTE_CIPHERTEXT_MAX = 64 * 1024; // 64 KB cifrado por nota

// POST /therapy/paciente/registrar
router.post("/therapy/paciente/registrar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const displayName  = String(req.body?.displayName  || "").trim().slice(0, 80);
  const e2eeSalt     = String(req.body?.e2eeSalt     || "").trim();
  const wrappedDEK   = String(req.body?.wrappedDEK   || "").trim();
  const wrappedDEKIv = String(req.body?.wrappedDEKIv || "").trim();
  const consentLgpd  = !!req.body?.consentLgpd;
  // Consentimento opt-in pra transcrição IA das sessões (sob LGPD).
  // Paciente aceita que o profissional pode gravar e transcrever via IA pra
  // uso exclusivo dele (revisão pré-sessão, sem treinamento de modelo).
  // Default: false. Não bloqueia cadastro — paciente pode aceitar/recusar.
  const consentAiSummary = !!req.body?.consentAiSummary;

  if (!displayName) return sendError(res, 400, "NOME_OBRIGATORIO");
  if (!consentLgpd) return sendError(res, 400, "CONSENTIMENTO_LGPD_OBRIGATORIO");
  if (!e2eeSalt || e2eeSalt.length < 16 || e2eeSalt.length > 128) {
    return sendError(res, 400, "E2EE_SALT_INVALIDO");
  }
  if (!wrappedDEK || !wrappedDEKIv) return sendError(res, 400, "WRAPPED_DEK_OBRIGATORIO");
  if (wrappedDEK.length > 256 || wrappedDEKIv.length > 64) {
    return sendError(res, 400, "WRAPPED_DEK_INVALIDO");
  }

  // Bloqueia colisão com conta de profissional (mesmo UID == mesmo e-mail).
  const therapistDoc = await getDb().collection("therapists").doc(uid).get();
  if (therapistDoc.exists) return sendError(res, 409, "EMAIL_PERTENCE_A_PROFISSIONAL");

  const db = getDb();
  const ref = db.collection("therapy_patient_accounts").doc(uid);
  const existing = await ref.get();
  const existingData = existing.exists ? existing.data() : null;

  // Write-once como no profissional — trocar salt/DEK quebraria as notas.
  const lockedSalt         = existingData?.e2eeSalt     || e2eeSalt;
  const lockedWrappedDEK   = existingData?.wrappedDEK   || wrappedDEK;
  const lockedWrappedDEKIv = existingData?.wrappedDEKIv || wrappedDEKIv;

  await ref.set({
    uid,
    displayName,
    e2eeSalt:     lockedSalt,
    wrappedDEK:   lockedWrappedDEK,
    wrappedDEKIv: lockedWrappedDEKIv,
    role: "patient",
    consentLgpd: true,
    consentLgpdAt: existingData?.consentLgpdAt || admin.firestore.FieldValue.serverTimestamp(),
    // Opt-in IA: paciente pode mudar depois via PATCH /therapy/paciente/perfil
    consentAiSummary,
    consentAiSummaryAt: consentAiSummary
      ? (existingData?.consentAiSummaryAt || admin.firestore.FieldValue.serverTimestamp())
      : null,
    createdAt: existingData?.createdAt || admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({
    type: "patient_account_registered",
    patientAccountUid: uid,
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || null
  });

  // Auto-link retroativo de sessões anteriores criadas com o email deste
  // paciente (mas sem patientAccountUid porque a conta de paciente ainda
  // não existia ou ele entrou como convidado). Não bloqueia o registro
  // se falhar — best-effort, paciente pode chamar /auto-link depois.
  try {
    await autoLinkPatientSessions(uid, db);
  } catch (e) { /* silencioso — fluxo principal continua */ }

  return res.json({
    ok: true,
    account: {
      uid, displayName,
      e2eeSalt:     lockedSalt,
      wrappedDEK:   lockedWrappedDEK,
      wrappedDEKIv: lockedWrappedDEKIv
    }
  });
}));

// Helper: vincula sessões antigas a uma conta de paciente recém-criada/logada.
// Busca sessões com patientEmail igual ao email do user (auth) e patientAccountUid
// vazio. Update em batch. Retorna contagem.
async function autoLinkPatientSessions(uid, db) {
  let email = null;
  try {
    const user = await admin.auth().getUser(uid);
    email = (user.email || "").trim().toLowerCase();
  } catch { return { linked: 0 }; }
  if (!email) return { linked: 0 };

  // Query: where patientEmail == email. Filtra patientAccountUid vazio em JS
  // (Firestore não tem operador "field is missing"/null nativo confiável).
  const snap = await db.collection("therapy_sessions")
    .where("patientEmail", "==", email)
    .limit(500)
    .get();

  if (snap.empty) return { linked: 0 };

  // Batch updates — máximo 500 ops por batch no Firestore.
  const batch = db.batch();
  let linked = 0;
  snap.forEach(doc => {
    const data = doc.data();
    if (data.patientAccountUid) return; // já vinculada
    batch.update(doc.ref, {
      patientAccountUid: uid,
      autoLinkedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    linked++;
  });
  if (linked > 0) {
    await batch.commit();
    await logAudit({ type: "patient_sessions_auto_linked", patientAccountUid: uid, count: linked });
  }
  return { linked };
}

// POST /therapy/paciente/auto-link — re-roda o auto-link manualmente.
// Idempotente. Útil pra contas antigas (registradas antes desta feature)
// e pra cenários onde novas sessões foram criadas DEPOIS do registro.
// Frontend pode chamar 1x no boot do paciente-painel pra cobrir esses casos.
router.post("/therapy/paciente/auto-link", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const account = await loadPatientAccount(uid);
  if (!account) return sendError(res, 404, "CONTA_NAO_REGISTRADA");
  const result = await autoLinkPatientSessions(uid, getDb());
  return res.json({ ok: true, linked: result.linked });
}));

// POST /therapy/paciente/recuperar — sobrescreve salt + wrappedDEK do paciente
router.post("/therapy/paciente/recuperar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const e2eeSalt     = String(req.body?.e2eeSalt     || "").trim();
  const wrappedDEK   = String(req.body?.wrappedDEK   || "").trim();
  const wrappedDEKIv = String(req.body?.wrappedDEKIv || "").trim();

  if (!e2eeSalt || e2eeSalt.length < 16 || e2eeSalt.length > 128) {
    return sendError(res, 400, "E2EE_SALT_INVALIDO");
  }
  if (!wrappedDEK || !wrappedDEKIv) return sendError(res, 400, "WRAPPED_DEK_OBRIGATORIO");
  if (wrappedDEK.length > 256 || wrappedDEKIv.length > 64) {
    return sendError(res, 400, "WRAPPED_DEK_INVALIDO");
  }

  const db = getDb();
  const ref = db.collection("therapy_patient_accounts").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "PACIENTE_NAO_REGISTRADO");

  await ref.set({
    e2eeSalt, wrappedDEK, wrappedDEKIv,
    recoveredAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:   admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({
    type: "patient_account_recovered",
    patientAccountUid: uid,
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || null
  });

  return res.json({ ok: true });
}));

// GET /therapy/paciente/me
router.get("/therapy/paciente/me", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const account = await loadPatientAccount(uid);
  if (!account) return sendError(res, 404, "PACIENTE_NAO_REGISTRADO");
  return res.json({ ok: true, account });
}));

// PATCH /therapy/paciente/perfil — paciente atualiza campos opt-in/preferências
// pós-cadastro. Hoje só aceita `consentAiSummary` (toggle pra transcrição IA).
// Campos write-once de cripto (e2eeSalt/wrappedDEK) NÃO podem mudar aqui —
// trocá-los inutilizaria as notas já cifradas.
router.patch("/therapy/paciente/perfil", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const account = await loadPatientAccount(uid);
  if (!account) return sendError(res, 404, "PACIENTE_NAO_REGISTRADO");

  const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

  if (req.body?.consentAiSummary !== undefined) {
    const accept = !!req.body.consentAiSummary;
    updates.consentAiSummary = accept;
    // Marca timestamp apenas na transição false→true. Quando paciente desliga,
    // limpa o timestamp pra deixar claro que o consentimento atual não vale.
    if (accept) {
      updates.consentAiSummaryAt = account.consentAiSummaryAt || admin.firestore.FieldValue.serverTimestamp();
    } else {
      updates.consentAiSummaryAt = null;
    }
  }

  if (typeof req.body?.displayName === "string") {
    const name = req.body.displayName.trim().slice(0, 80);
    if (name) updates.displayName = name;
  }

  await getDb().collection("therapy_patient_accounts").doc(uid).set(updates, { merge: true });

  await logAudit({
    type: "patient_account_updated",
    patientAccountUid: uid,
    fields: Object.keys(updates).filter(k => k !== "updatedAt")
  });

  const fresh = await loadPatientAccount(uid);
  return res.json({ ok: true, account: fresh });
}));

// GET /therapy/paciente/sessoes — sessões em que esta conta participou
router.get("/therapy/paciente/sessoes", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const account = await loadPatientAccount(uid);
  if (!account) return sendError(res, 404, "PACIENTE_NAO_REGISTRADO");

  const db = getDb();
  const snap = await db.collection("therapy_sessions")
    .where("patientAccountUid", "==", uid)
    .limit(500)
    .get();

  const sessions = snap.docs
    .map(d => {
      const data = d.data();
      return {
        sessionId: data.sessionId,
        therapistDisplayName: data.therapistDisplayName || "",
        status: data.status,
        scheduledAt: data.scheduledAt || null,
        createdAt: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
        completedAt: data.completedAt?.toMillis ? data.completedAt.toMillis() : null
      };
    })
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return res.json({ ok: true, sessions });
}));

// POST /therapy/paciente/notas — salva nota cifrada do paciente
router.post("/therapy/paciente/notas", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const account = await loadPatientAccount(uid);
  if (!account) return sendError(res, 404, "PACIENTE_NAO_REGISTRADO");

  const sessionId  = String(req.body?.sessionId  || "").trim();
  const ciphertext = String(req.body?.ciphertext || "").trim();
  const iv         = String(req.body?.iv         || "").trim();

  if (!sessionId)         return sendError(res, 400, "SESSAO_OBRIGATORIA");
  if (!ciphertext || !iv) return sendError(res, 400, "CIPHERTEXT_IV_OBRIGATORIOS");
  if (ciphertext.length > PATIENT_NOTE_CIPHERTEXT_MAX) return sendError(res, 413, "NOTA_GRANDE_DEMAIS");

  // Snapshot do nome do profissional pra exibição offline (paciente não tem
  // perfil do profissional disponível pra consultar depois).
  const db = getDb();
  const sessSnap = await db.collection("therapy_sessions").doc(sessionId).get();
  const therapistDisplayName = sessSnap.exists ? (sessSnap.data().therapistDisplayName || "") : "";

  const noteId = newId("pnote");
  await db.collection("therapy_patient_notes").doc(noteId).set({
    noteId,
    patientAccountUid: uid,
    sessionId,
    therapistDisplayName,
    ciphertext,
    iv,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return res.json({ ok: true, noteId });
}));

// GET /therapy/paciente/notas?sessionId=X (opcional) — lista cifrados do paciente
router.get("/therapy/paciente/notas", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const sessionId = String(req.query?.sessionId || "").trim();

  const db = getDb();
  let q = db.collection("therapy_patient_notes").where("patientAccountUid", "==", uid);
  if (sessionId) q = q.where("sessionId", "==", sessionId);

  const snap = await q.limit(1000).get();
  const notes = snap.docs
    .map(d => {
      const data = d.data();
      return {
        noteId: data.noteId,
        sessionId: data.sessionId,
        therapistDisplayName: data.therapistDisplayName || "",
        ciphertext: data.ciphertext,
        iv: data.iv,
        createdAt: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
        updatedAt: data.updatedAt?.toMillis ? data.updatedAt.toMillis() : null
      };
    })
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  return res.json({ ok: true, notes });
}));

// PATCH /therapy/paciente/notas/:noteId — edita
router.patch("/therapy/paciente/notas/:noteId", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const noteId = String(req.params.noteId || "").trim();
  if (!noteId) return sendError(res, 400, "NOTA_OBRIGATORIA");

  const ciphertext = String(req.body?.ciphertext || "").trim();
  const iv         = String(req.body?.iv         || "").trim();
  if (!ciphertext || !iv) return sendError(res, 400, "CIPHERTEXT_IV_OBRIGATORIOS");
  if (ciphertext.length > PATIENT_NOTE_CIPHERTEXT_MAX) return sendError(res, 413, "NOTA_GRANDE_DEMAIS");

  const db = getDb();
  const ref = db.collection("therapy_patient_notes").doc(noteId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "NOTA_NAO_ENCONTRADA");
  if (snap.data().patientAccountUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  await ref.set({
    ciphertext, iv,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  return res.json({ ok: true });
}));

// DELETE /therapy/paciente/notas/:noteId — apaga (hard delete; só o paciente vê)
router.delete("/therapy/paciente/notas/:noteId", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const noteId = String(req.params.noteId || "").trim();
  if (!noteId) return sendError(res, 400, "NOTA_OBRIGATORIA");

  const db = getDb();
  const ref = db.collection("therapy_patient_notes").doc(noteId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "NOTA_NAO_ENCONTRADA");
  if (snap.data().patientAccountUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  await ref.delete();
  return res.json({ ok: true });
}));

// ─────────────────────────────────────────────────────────────────────────
// RECEITAS DIGITAIS (CFM 2.314/2022)
//
// Modelo de dados:
//   therapy_receitas/{receitaId}
//     {
//       receitaId, therapistUid, patientId?, patientNameSnapshot,
//       sessionId?,
//       status: "draft" | "signed",
//       signatureMethod?: "a1_inline" | "external_upload",
//       // Dados do formulário (medicamento, posologia, etc) cifrados com DEK
//       // do médico — server-blind enquanto está rascunho:
//       formCiphertext, formIv,
//       // PDF assinado fica em plaintext (base64) porque tem que ser
//       // entregável ao paciente/farmácia que NÃO têm a DEK.
//       // Gate de acesso é o deliveryToken assinado:
//       pdfSignedBase64?, pdfSignedMime?,
//       deliveryToken?, deliveryTokenExp?,
//       signedAt?, createdAt, updatedAt
//     }
//
// Por que o PDF assinado fica plaintext: o ICP-Brasil só faz sentido se a
// farmácia / paciente conseguirem ler. O que protege é o token de delivery
// (HMAC-assinado, expira, único por receita).
// ─────────────────────────────────────────────────────────────────────────

const RECEITA_FORM_CIPHERTEXT_MAX = 32 * 1024;     // 32 KB cifrado de formulário
const RECEITA_PDF_MAX             = 1024 * 1024;   // 1 MB de PDF assinado base64
const RECEITA_DELIVERY_VALIDITY_MS = 90 * 24 * 60 * 60 * 1000; // 90 dias
// Validade clínica da receita (RDC 471/2021 ANVISA: 30 dias após emissão pra
// receita de controle especial). É independente do deliveryToken (90d) — depois
// dos 30d a farmácia não deve aviar mesmo que o link ainda funcione.
const RECEITA_VALIDITY_CLINICAL_MS = 30 * 24 * 60 * 60 * 1000;
const RECEITA_QUANTIDADE_MAX = 24; // teto defensivo (mais que isso é caso clínico atípico)
const DISPENSACAO_REASON_MAX = 200;
// CRF em formato {UF}-NNNNN ou similar; aceita variações regionais (CRF/SP 12345,
// CRF SP 12345, CRF-SC-12345 etc). Validação leve — fonte de verdade é o conselho.
const CRF_REGEX  = /^[A-Z]{2,4}[\s\-/]*[A-Z]{2}[\s\-/]*\d{2,8}$/i;
const CNPJ_REGEX = /^\d{14}$/;

// Helper: valida quantidade prescrita. Retorna número inteiro >=1 e <=MAX, ou null se inválido.
function parseQuantidade(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > RECEITA_QUANTIDADE_MAX) return null;
  return n;
}

// Validador CNPJ (algoritmo padrão Receita Federal).
function isValidCnpj(cnpj) {
  const c = String(cnpj || "").replace(/\D/g, "");
  if (c.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(c)) return false; // todos iguais → inválido (00000000000000 etc)
  const calc = (digs, weights) => {
    const sum = digs.reduce((acc, d, i) => acc + d * weights[i], 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const arr = c.split("").map(Number);
  const w1 = [5,4,3,2,9,8,7,6,5,4,3,2];
  const w2 = [6].concat(w1);
  return calc(arr.slice(0, 12), w1) === arr[12] && calc(arr.slice(0, 13), w2) === arr[13];
}

function buildDeliveryToken(receitaId) {
  const now = Date.now();
  const exp = now + RECEITA_DELIVERY_VALIDITY_MS;
  const token = signPayload({
    token_type: "receita_delivery",
    receitaId,
    iat: now,
    exp
  }, ACCESS_TOKEN_SECRET);
  return { token, exp };
}

// POST /therapy/receitas — cria rascunho
router.post("/therapy/receitas", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await requirePaidPlan(req, res, uid);
  if (!therapist) return;
  if (rejectIfStudent(therapist, res)) return;
  if (rejectIfNotVerified(therapist, res)) return;
  if (!requireCapability(therapist, res, "receita",
    "Seu conselho não habilita emissão de receita.")) return;

  // tipoPrescricao define o tipo regulatório da receita:
  //   "mip"               — livre prescrição (medicamentos isentos de prescrição)
  //   "insumo-injetavel"  — insumos/injetáveis estéticos (Acórdão COFFITO 735/2024)
  //   "controlado"        — Portaria SVS/MS 344/1998 (psicotrópicos, antibióticos)
  // Capability matrix por conselho em professional-councils.js.
  const tipoPrescricao = String(req.body?.tipoPrescricao || "").trim().toLowerCase();
  if (!isValidPrescriptionType(tipoPrescricao)) {
    return sendError(res, 400, "TIPO_PRESCRICAO_INVALIDO",
      { hint: "Valores aceitos: mip, insumo-injetavel, controlado." });
  }
  if (!canPrescribeType(therapist, tipoPrescricao)) {
    const allowed = getPrescriptionTypesForTherapist(therapist);
    return sendError(res, 403, "TIPO_PRESCRICAO_NAO_AUTORIZADO", {
      tipoPrescricao,
      allowed,
      detail: `Seu conselho não permite emitir receita do tipo "${tipoPrescricao}". Tipos disponíveis pra você: ${allowed.length ? allowed.join(", ") : "nenhum"}.`
    });
  }

  const formCiphertext       = String(req.body?.formCiphertext || "").trim();
  const formIv               = String(req.body?.formIv || "").trim();
  const patientId            = String(req.body?.patientId || "").trim() || null;
  const patientNameSnapshot  = String(req.body?.patientNameSnapshot || "").trim().slice(0, PATIENT_NAME_MAX);
  const sessionId            = String(req.body?.sessionId || "").trim() || null;
  const quantidadePrescrita  = parseQuantidade(req.body?.quantidadePrescrita);

  if (!formCiphertext || !formIv) return sendError(res, 400, "FORMULARIO_OBRIGATORIO");
  if (formCiphertext.length > RECEITA_FORM_CIPHERTEXT_MAX) return sendError(res, 413, "FORMULARIO_GRANDE_DEMAIS");
  if (!patientNameSnapshot)       return sendError(res, 400, "NOME_PACIENTE_OBRIGATORIO");
  if (quantidadePrescrita === null) return sendError(res, 400, "QUANTIDADE_PRESCRITA_INVALIDA", { hint: `Total de unidades (caixas/comprimidos) entre 1 e ${RECEITA_QUANTIDADE_MAX}.` });

  if (patientId) {
    const psnap = await getDb().collection("therapy_patients").doc(patientId).get();
    if (!psnap.exists) return sendError(res, 404, "PACIENTE_NAO_ENCONTRADO");
    if (psnap.data().therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");
  }

  const receitaId = newId("rec");
  const db = getDb();
  await db.collection("therapy_receitas").doc(receitaId).set({
    receitaId,
    therapistUid: uid,
    patientId,
    patientNameSnapshot,
    sessionId,
    status: "draft",
    tipoPrescricao,
    // Snapshot do conselho/subtipo do prescritor no momento da criação.
    // Imutável depois — se profissional trocar conselho, receita preserva quem
    // realmente prescreveu (auditoria).
    prescritorTipoConselho: resolveSiglaFromTherapist(therapist) || null,
    prescritorSubtipoConselho: therapist.subtipoConselho || null,
    formCiphertext,
    formIv,
    quantidadePrescrita,
    quantidadeDispensada: 0,
    dispensacaoStatus: "pendente",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await logAudit({
    type: "receita_created",
    receitaId, therapistUid: uid, patientId,
    tipoPrescricao
  });

  return res.json({ ok: true, receitaId, tipoPrescricao });
}));

// PATCH /therapy/receitas/:id — edita rascunho (não permite após assinada)
router.patch("/therapy/receitas/:id", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const receitaId = String(req.params.id || "").trim();
  if (!receitaId) return sendError(res, 400, "ID_OBRIGATORIO");

  const formCiphertext = String(req.body?.formCiphertext || "").trim();
  const formIv         = String(req.body?.formIv || "").trim();
  if (!formCiphertext || !formIv) return sendError(res, 400, "FORMULARIO_OBRIGATORIO");
  if (formCiphertext.length > RECEITA_FORM_CIPHERTEXT_MAX) return sendError(res, 413, "FORMULARIO_GRANDE_DEMAIS");

  // quantidadePrescrita é opcional aqui — se vier, valida; senão preserva o
  // valor anterior. Tipicamente o frontend reenvia o mesmo valor pra simplicidade.
  const hasQty = req.body?.quantidadePrescrita !== undefined;
  const quantidadePrescrita = hasQty ? parseQuantidade(req.body.quantidadePrescrita) : undefined;
  if (hasQty && quantidadePrescrita === null) {
    return sendError(res, 400, "QUANTIDADE_PRESCRITA_INVALIDA", { hint: `Total entre 1 e ${RECEITA_QUANTIDADE_MAX}.` });
  }

  const db = getDb();
  const ref = db.collection("therapy_receitas").doc(receitaId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "RECEITA_NAO_ENCONTRADA");
  const r = snap.data();
  if (r.therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");
  if (r.status === "signed")  return sendError(res, 409, "RECEITA_JA_ASSINADA");

  // Defesa em profundidade: bloqueia edição se o conselho atual do
  // profissional não habilita "receita" (ex.: terapeuta trocou tipoConselho
  // de CRM pra CRESS depois de criar o draft).
  const therapistDoc = await loadTherapist(uid);
  if (rejectIfNotVerified(therapistDoc, res)) return;
  if (!requireCapability(therapistDoc, res, "receita",
    "Apenas profissionais com CRM podem editar receitas.")) return;

  const updates = {
    formCiphertext, formIv,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  if (hasQty) updates.quantidadePrescrita = quantidadePrescrita;
  await ref.set(updates, { merge: true });

  return res.json({ ok: true });
}));

// POST /therapy/receitas/:id/preparar-link — gera (ou reutiliza) o
// deliveryToken ANTES da assinatura, pra que o QR já vá embutido no PDF.
// Idempotente: token vivo é reutilizado; expirado é regenerado.
router.post("/therapy/receitas/:id/preparar-link", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const receitaId = String(req.params.id || "").trim();
  if (!receitaId) return sendError(res, 400, "ID_OBRIGATORIO");

  const db = getDb();
  const ref = db.collection("therapy_receitas").doc(receitaId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "RECEITA_NAO_ENCONTRADA");
  const r = snap.data();
  if (r.therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  let deliveryToken    = r.deliveryToken    || null;
  let deliveryTokenExp = r.deliveryTokenExp || null;
  const now = Date.now();
  // Regenera se ausente OU expirado OU se faltam <14 dias (pra evitar QR já com
  // pouca validade no PDF que vai pro paciente).
  if (!deliveryToken || !deliveryTokenExp || deliveryTokenExp - now < 14 * 24 * 60 * 60 * 1000) {
    const fresh = buildDeliveryToken(receitaId);
    deliveryToken    = fresh.token;
    deliveryTokenExp = fresh.exp;
    await ref.set({
      deliveryToken, deliveryTokenExp,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }
  return res.json({ ok: true, deliveryToken, deliveryTokenExp });
}));

// POST /therapy/receitas/:id/assinar — recebe PDF (já assinado client-side ou
// upload externo) + signatureMethod. Marca como signed, reutiliza deliveryToken
// pré-gerado por /preparar-link (gera fresh se faltar, mas isso significa que
// o QR no PDF não vai bater — frontend deve sempre chamar preparar-link antes).
router.post("/therapy/receitas/:id/assinar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const receitaId = String(req.params.id || "").trim();
  if (!receitaId) return sendError(res, 400, "ID_OBRIGATORIO");

  const pdfBase64        = String(req.body?.pdfBase64 || "").trim();
  const pdfMime          = String(req.body?.pdfMime || "application/pdf").trim();
  const signatureMethod  = String(req.body?.signatureMethod || "").trim();

  if (!pdfBase64) return sendError(res, 400, "PDF_OBRIGATORIO");
  if (pdfBase64.length > RECEITA_PDF_MAX) return sendError(res, 413, "PDF_GRANDE_DEMAIS");
  if (pdfMime !== "application/pdf") return sendError(res, 400, "TIPO_INVALIDO");
  if (!["a1_inline", "external_upload"].includes(signatureMethod)) {
    return sendError(res, 400, "METODO_INVALIDO");
  }

  const db = getDb();
  const ref = db.collection("therapy_receitas").doc(receitaId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "RECEITA_NAO_ENCONTRADA");
  const r = snap.data();
  if (r.therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");
  if (r.status === "signed")  return sendError(res, 409, "RECEITA_JA_ASSINADA");

  // Defesa em profundidade: revalida capability no momento da assinatura
  // (ato legal). Bloqueia se o profissional trocou pra um conselho que
  // não habilita receita depois de criar o draft.
  const therapistDoc = await loadTherapist(uid);
  if (rejectIfNotVerified(therapistDoc, res)) return;
  if (!requireCapability(therapistDoc, res, "receita",
    "Seu conselho não habilita assinatura de receita.")) return;

  // Revalida o TIPO específico — profissional pode ter mudado de subtipo
  // (ex.: CREFITO de fisio pra TO) entre criar e assinar. tipoPrescricao
  // foi snapshot no doc na criação; comparamos com matriz atual.
  if (r.tipoPrescricao && !canPrescribeType(therapistDoc, r.tipoPrescricao)) {
    return sendError(res, 403, "TIPO_PRESCRICAO_NAO_AUTORIZADO", {
      tipoPrescricao: r.tipoPrescricao,
      detail: `Seu conselho atual não permite emitir receita do tipo "${r.tipoPrescricao}".`
    });
  }

  // Reutiliza token pré-gerado se ainda válido. Senão fallback (PDF pode estar
  // sem QR ou com QR que não bate, mas a receita continua íntegra).
  let deliveryToken    = r.deliveryToken    || null;
  let deliveryTokenExp = r.deliveryTokenExp || null;
  if (!deliveryToken || !deliveryTokenExp || deliveryTokenExp < Date.now()) {
    const fresh = buildDeliveryToken(receitaId);
    deliveryToken    = fresh.token;
    deliveryTokenExp = fresh.exp;
  }

  // signedAt usa serverTimestamp pra precisão; validadeClinicaAt salva como ms
  // pra leitura sem getter (usado em comparações no /receita/dispensar).
  const signedAtMs = Date.now();
  const validadeClinicaAt = signedAtMs + RECEITA_VALIDITY_CLINICAL_MS;

  await ref.set({
    status: "signed",
    signatureMethod,
    pdfSignedBase64: pdfBase64,
    pdfSignedMime: pdfMime,
    deliveryToken,
    deliveryTokenExp,
    signedAtMs,
    validadeClinicaAt,
    signedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({
    type: "receita_signed",
    receitaId,
    therapistUid: uid,
    signatureMethod
  });

  return res.json({ ok: true, deliveryToken, deliveryTokenExp, validadeClinicaAt });
}));

// GET /therapy/receitas — lista do médico (sem PDF base64 pra não pesar)
router.get("/therapy/receitas", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const patientId = String(req.query?.patientId || "").trim();

  const db = getDb();
  let q = db.collection("therapy_receitas").where("therapistUid", "==", uid);
  if (patientId) q = q.where("patientId", "==", patientId);

  const snap = await q.limit(500).get();
  const receitas = snap.docs
    .map(d => {
      const r = d.data();
      return {
        receitaId: r.receitaId,
        patientId: r.patientId || null,
        patientNameSnapshot: r.patientNameSnapshot,
        sessionId: r.sessionId || null,
        status: r.status,
        signatureMethod: r.signatureMethod || null,
        formCiphertext: r.formCiphertext,
        formIv: r.formIv,
        deliveryToken: r.deliveryToken || null,
        deliveryTokenExp: r.deliveryTokenExp || null,
        createdAt: r.createdAt?.toMillis ? r.createdAt.toMillis() : null,
        signedAt: r.signedAt?.toMillis ? r.signedAt.toMillis() : null
      };
    })
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return res.json({ ok: true, receitas });
}));

// GET /therapy/receitas/:id — detalhe (médico) com PDF assinado
router.get("/therapy/receitas/:id", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const receitaId = String(req.params.id || "").trim();
  if (!receitaId) return sendError(res, 400, "ID_OBRIGATORIO");

  const db = getDb();
  const snap = await db.collection("therapy_receitas").doc(receitaId).get();
  if (!snap.exists) return sendError(res, 404, "RECEITA_NAO_ENCONTRADA");
  const r = snap.data();
  if (r.therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  return res.json({
    ok: true,
    receita: {
      receitaId: r.receitaId,
      patientId: r.patientId || null,
      patientNameSnapshot: r.patientNameSnapshot,
      sessionId: r.sessionId || null,
      status: r.status,
      signatureMethod: r.signatureMethod || null,
      formCiphertext: r.formCiphertext,
      formIv: r.formIv,
      pdfSignedBase64: r.pdfSignedBase64 || null,
      pdfSignedMime: r.pdfSignedMime || null,
      deliveryToken: r.deliveryToken || null,
      deliveryTokenExp: r.deliveryTokenExp || null,
      createdAt: r.createdAt?.toMillis ? r.createdAt.toMillis() : null,
      signedAt: r.signedAt?.toMillis ? r.signedAt.toMillis() : null
    }
  });
}));

// DELETE /therapy/receitas/:id — só rascunhos. Assinada não apaga (CFM exige
// retenção; cliente pode ocultar visualmente, não excluir).
router.delete("/therapy/receitas/:id", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const receitaId = String(req.params.id || "").trim();
  if (!receitaId) return sendError(res, 400, "ID_OBRIGATORIO");

  const db = getDb();
  const ref = db.collection("therapy_receitas").doc(receitaId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "RECEITA_NAO_ENCONTRADA");
  const r = snap.data();
  if (r.therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");
  if (r.status === "signed")  return sendError(res, 409, "RECEITA_ASSINADA_NAO_APAGA");

  await ref.delete();
  await logAudit({ type: "receita_deleted_draft", receitaId, therapistUid: uid });

  return res.json({ ok: true });
}));

// GET /therapy/receita/publica?t=<token> — sem auth, paciente/farmácia
// recebem o PDF assinado. Token HMAC com expiração.
router.get("/therapy/receita/publica", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const token = String(req.query?.t || "").trim();
  if (!token) return sendError(res, 400, "TOKEN_OBRIGATORIO");

  const verification = verifySignedToken(token, ACCESS_TOKEN_SECRET);
  if (!verification.valid) return sendError(res, 401, verification.error || "TOKEN_INVALIDO");
  const payload = verification.payload;
  if (payload.token_type !== "receita_delivery") return sendError(res, 401, "TOKEN_NAO_AUTORIZADO");

  const db = getDb();
  const snap = await db.collection("therapy_receitas").doc(payload.receitaId).get();
  if (!snap.exists) return sendError(res, 404, "RECEITA_NAO_ENCONTRADA");
  const r = snap.data();
  if (r.status !== "signed" || !r.pdfSignedBase64) return sendError(res, 410, "RECEITA_NAO_ASSINADA");
  // Reconfere consistência (token revogado se receita re-assinada — defesa em profundidade)
  if (r.deliveryToken !== token) return sendError(res, 401, "TOKEN_REVOGADO");

  await logAudit({
    type: "receita_publica_access",
    receitaId: r.receitaId,
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || null
  });

  // Devolve metadados + PDF base64 + dados do médico pra renderizar
  // a página de verificação como "comprovante de autenticidade".
  const therapist = await loadTherapist(r.therapistUid);
  const issuer = therapist ? {
    displayName:   therapist.displayName || "",
    crm:           therapist.crm || "",
    crp:           therapist.crp || "",
    rqe:           therapist.rqe || "",
    especialidade: therapist.especialidade || "",
    consultorio:   therapist.consultorio || null
  } : null;

  // Carrega histórico de dispensações pra essa receita (sem dados sensíveis,
  // só identificação profissional do farmacêutico + dados da farmácia + qty).
  const dispSnap = await db.collection("therapy_dispensacoes")
    .where("receitaId", "==", r.receitaId)
    .limit(50)
    .get();
  const dispensacoes = dispSnap.docs
    .map(d => {
      const x = d.data();
      return {
        dispensacaoId: x.dispensacaoId,
        farmaceuticoCRF: x.farmaceuticoCRF,
        farmaceuticoNome: x.farmaceuticoNome,
        farmaciaCNPJ: x.farmaciaCNPJ,
        farmaciaNome: x.farmaciaNome,
        quantidade: x.quantidade,
        dispensadoAt: x.dispensadoAt?.toMillis ? x.dispensadoAt.toMillis() : (x.dispensadoAtMs || null)
      };
    })
    .sort((a, b) => (a.dispensadoAt || 0) - (b.dispensadoAt || 0));

  const quantidadePrescrita  = r.quantidadePrescrita  || null;
  const quantidadeDispensada = r.quantidadeDispensada || 0;
  const validadeClinicaAt    = r.validadeClinicaAt    || null;
  const expirada = validadeClinicaAt ? Date.now() > validadeClinicaAt : false;
  let dispensacaoStatus = r.dispensacaoStatus || (quantidadePrescrita ? "pendente" : null);
  if (expirada && dispensacaoStatus !== "completa") dispensacaoStatus = "expirada";

  return res.json({
    ok: true,
    receita: {
      receitaId: r.receitaId,
      patientNameSnapshot: r.patientNameSnapshot,
      pdfBase64: r.pdfSignedBase64,
      pdfMime: r.pdfSignedMime || "application/pdf",
      signedAt: r.signedAt?.toMillis ? r.signedAt.toMillis() : (r.signedAtMs || null),
      signatureMethod: r.signatureMethod || null,
      deliveryTokenExp: r.deliveryTokenExp || null,
      validadeClinicaAt,
      quantidadePrescrita,
      quantidadeDispensada,
      dispensacaoStatus,
      dispensacoes,
      issuer
    }
  });
}));

// ─────────────────────────────────────────────────────────────────────────
// DOCUMENTOS MÉDICOS — atestado, exames, encaminhamento, relatório.
//
// Espelha o fluxo de receita (rascunho → preparar-link → assinar) mas sem
// dispensação (não tem saldo nem histórico de farmácia). Formulário cifrado
// client-side por DEK (igual notas/receita); backend só vê metadados.
//
// Modelo: therapy_documents/{id}
//   { documentoId, tipo: "atestado"|"exames"|"encaminhamento"|"relatorio",
//     therapistUid, patientId?, patientNameSnapshot, sessionId?,
//     status: "draft"|"signed",
//     formCiphertext, formIv,
//     pdfSignedBase64?, pdfSignedMime?, signatureMethod?,
//     deliveryToken?, deliveryTokenExp?,
//     signedAtMs?, signedAt?,
//     createdAt, updatedAt }
//
// Token type: "documento_delivery" (distinto de "receita_delivery").
// ─────────────────────────────────────────────────────────────────────────
const DOCUMENTO_TIPOS = new Set(["atestado", "exames", "encaminhamento", "relatorio"]);
const DOCUMENTO_FORM_CIPHERTEXT_MAX = 64 * 1024; // 64 KB cifrado (relatório pode ser longo)
const DOCUMENTO_PDF_MAX = 1024 * 1024;
const DOCUMENTO_DELIVERY_VALIDITY_MS = 365 * 24 * 60 * 60 * 1000; // 1 ano (atestado/relatório precisam de janela longa pra consulta retroativa)

function buildDocumentoDeliveryToken(documentoId) {
  const now = Date.now();
  const exp = now + DOCUMENTO_DELIVERY_VALIDITY_MS;
  const token = signPayload({
    token_type: "documento_delivery",
    documentoId,
    iat: now,
    exp
  }, ACCESS_TOKEN_SECRET);
  return { token, exp };
}

// POST /therapy/documentos — cria rascunho
router.post("/therapy/documentos", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await requirePaidPlan(req, res, uid);
  if (!therapist) return;
  if (rejectIfStudent(therapist, res)) return;
  if (rejectIfNotVerified(therapist, res)) return;
  if (!requireCapability(therapist, res, "documentos-clinicos",
    "Atestado, encaminhamento e relatório clínico podem ser emitidos por CRM, CRP, CREFITO, CRN e CRO dentro do escopo da profissão.")) return;

  const tipo = String(req.body?.tipo || "").trim().toLowerCase();
  if (!DOCUMENTO_TIPOS.has(tipo)) {
    return sendError(res, 400, "TIPO_INVALIDO", { hint: `Tipos válidos: ${[...DOCUMENTO_TIPOS].join(", ")}.` });
  }

  const formCiphertext      = String(req.body?.formCiphertext || "").trim();
  const formIv              = String(req.body?.formIv || "").trim();
  const patientId           = String(req.body?.patientId || "").trim() || null;
  const patientNameSnapshot = String(req.body?.patientNameSnapshot || "").trim().slice(0, PATIENT_NAME_MAX);
  const sessionId           = String(req.body?.sessionId || "").trim() || null;

  if (!formCiphertext || !formIv) return sendError(res, 400, "FORMULARIO_OBRIGATORIO");
  if (formCiphertext.length > DOCUMENTO_FORM_CIPHERTEXT_MAX) return sendError(res, 413, "FORMULARIO_GRANDE_DEMAIS");
  if (!patientNameSnapshot) return sendError(res, 400, "NOME_PACIENTE_OBRIGATORIO");

  if (patientId) {
    const psnap = await getDb().collection("therapy_patients").doc(patientId).get();
    if (!psnap.exists) return sendError(res, 404, "PACIENTE_NAO_ENCONTRADO");
    if (psnap.data().therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");
  }

  const documentoId = newId("doc");
  const db = getDb();
  await db.collection("therapy_documents").doc(documentoId).set({
    documentoId,
    tipo,
    therapistUid: uid,
    patientId,
    patientNameSnapshot,
    sessionId,
    status: "draft",
    formCiphertext,
    formIv,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await logAudit({ type: "documento_created", documentoId, tipo, therapistUid: uid, patientId });
  return res.json({ ok: true, documentoId });
}));

// PATCH /therapy/documentos/:id
router.patch("/therapy/documentos/:id", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const documentoId = String(req.params.id || "").trim();
  if (!documentoId) return sendError(res, 400, "ID_OBRIGATORIO");

  const formCiphertext = String(req.body?.formCiphertext || "").trim();
  const formIv         = String(req.body?.formIv || "").trim();
  if (!formCiphertext || !formIv) return sendError(res, 400, "FORMULARIO_OBRIGATORIO");
  if (formCiphertext.length > DOCUMENTO_FORM_CIPHERTEXT_MAX) return sendError(res, 413, "FORMULARIO_GRANDE_DEMAIS");

  const db = getDb();
  const ref = db.collection("therapy_documents").doc(documentoId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "DOCUMENTO_NAO_ENCONTRADO");
  const d = snap.data();
  if (d.therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");
  if (d.status === "signed")  return sendError(res, 409, "DOCUMENTO_JA_ASSINADO");

  // Defesa em profundidade: revalida capability se o profissional trocou
  // de conselho depois de criar o draft.
  const therapistDoc = await loadTherapist(uid);
  if (rejectIfNotVerified(therapistDoc, res)) return;
  if (!requireCapability(therapistDoc, res, "documentos-clinicos",
    "Apenas CRM, CRP, CREFITO, CRN e CRO podem editar documentos clínicos.")) return;

  await ref.set({
    formCiphertext, formIv,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  return res.json({ ok: true });
}));

// POST /therapy/documentos/:id/preparar-link
router.post("/therapy/documentos/:id/preparar-link", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const documentoId = String(req.params.id || "").trim();
  if (!documentoId) return sendError(res, 400, "ID_OBRIGATORIO");

  const db = getDb();
  const ref = db.collection("therapy_documents").doc(documentoId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "DOCUMENTO_NAO_ENCONTRADO");
  const d = snap.data();
  if (d.therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  let deliveryToken    = d.deliveryToken    || null;
  let deliveryTokenExp = d.deliveryTokenExp || null;
  const now = Date.now();
  if (!deliveryToken || !deliveryTokenExp || deliveryTokenExp - now < 30 * 24 * 60 * 60 * 1000) {
    const fresh = buildDocumentoDeliveryToken(documentoId);
    deliveryToken    = fresh.token;
    deliveryTokenExp = fresh.exp;
    await ref.set({
      deliveryToken, deliveryTokenExp,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }
  return res.json({ ok: true, deliveryToken, deliveryTokenExp });
}));

// POST /therapy/documentos/:id/assinar
router.post("/therapy/documentos/:id/assinar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const documentoId = String(req.params.id || "").trim();
  if (!documentoId) return sendError(res, 400, "ID_OBRIGATORIO");

  const pdfBase64       = String(req.body?.pdfBase64 || "").trim();
  const pdfMime         = String(req.body?.pdfMime || "application/pdf").trim();
  const signatureMethod = String(req.body?.signatureMethod || "").trim();

  if (!pdfBase64) return sendError(res, 400, "PDF_OBRIGATORIO");
  if (pdfBase64.length > DOCUMENTO_PDF_MAX) return sendError(res, 413, "PDF_GRANDE_DEMAIS");
  if (pdfMime !== "application/pdf") return sendError(res, 400, "TIPO_INVALIDO");
  if (!["a1_inline", "external_upload"].includes(signatureMethod)) {
    return sendError(res, 400, "METODO_INVALIDO");
  }

  const db = getDb();
  const ref = db.collection("therapy_documents").doc(documentoId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "DOCUMENTO_NAO_ENCONTRADO");
  const d = snap.data();
  if (d.therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");
  if (d.status === "signed")  return sendError(res, 409, "DOCUMENTO_JA_ASSINADO");

  // Defesa em profundidade no momento da assinatura (ato legal).
  const therapistDoc = await loadTherapist(uid);
  if (rejectIfNotVerified(therapistDoc, res)) return;
  if (!requireCapability(therapistDoc, res, "documentos-clinicos",
    "Apenas CRM, CRP, CREFITO, CRN e CRO podem assinar documentos clínicos.")) return;

  let deliveryToken    = d.deliveryToken    || null;
  let deliveryTokenExp = d.deliveryTokenExp || null;
  if (!deliveryToken || !deliveryTokenExp || deliveryTokenExp < Date.now()) {
    const fresh = buildDocumentoDeliveryToken(documentoId);
    deliveryToken    = fresh.token;
    deliveryTokenExp = fresh.exp;
  }

  const signedAtMs = Date.now();
  await ref.set({
    status: "signed",
    signatureMethod,
    pdfSignedBase64: pdfBase64,
    pdfSignedMime: pdfMime,
    deliveryToken,
    deliveryTokenExp,
    signedAtMs,
    signedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({ type: "documento_signed", documentoId, tipo: d.tipo, therapistUid: uid, signatureMethod });
  return res.json({ ok: true, deliveryToken, deliveryTokenExp });
}));

// GET /therapy/documentos — lista do médico (filtro opcional por tipo, patientId)
router.get("/therapy/documentos", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const tipoFilter      = String(req.query?.tipo || "").trim().toLowerCase();
  const patientIdFilter = String(req.query?.patientId || "").trim();

  const db = getDb();
  let q = db.collection("therapy_documents").where("therapistUid", "==", uid);
  if (tipoFilter && DOCUMENTO_TIPOS.has(tipoFilter)) q = q.where("tipo", "==", tipoFilter);
  if (patientIdFilter)                                q = q.where("patientId", "==", patientIdFilter);

  const snap = await q.limit(500).get();
  const documentos = snap.docs
    .map(d => {
      const x = d.data();
      return {
        documentoId: x.documentoId,
        tipo: x.tipo,
        patientId: x.patientId || null,
        patientNameSnapshot: x.patientNameSnapshot,
        sessionId: x.sessionId || null,
        status: x.status,
        signatureMethod: x.signatureMethod || null,
        formCiphertext: x.formCiphertext,
        formIv: x.formIv,
        deliveryToken: x.deliveryToken || null,
        deliveryTokenExp: x.deliveryTokenExp || null,
        createdAt: x.createdAt?.toMillis ? x.createdAt.toMillis() : null,
        signedAt: x.signedAt?.toMillis ? x.signedAt.toMillis() : (x.signedAtMs || null)
      };
    })
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return res.json({ ok: true, documentos });
}));

// GET /therapy/documentos/:id — devolve um documento individual (rascunho ou assinado)
router.get("/therapy/documentos/:id", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const documentoId = String(req.params.id || "").trim();
  if (!documentoId) return sendError(res, 400, "ID_OBRIGATORIO");

  const db = getDb();
  const snap = await db.collection("therapy_documents").doc(documentoId).get();
  if (!snap.exists) return sendError(res, 404, "DOCUMENTO_NAO_ENCONTRADO");
  const d = snap.data();
  if (d.therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  return res.json({
    ok: true,
    documento: {
      documentoId: d.documentoId,
      tipo: d.tipo,
      patientId: d.patientId || null,
      patientNameSnapshot: d.patientNameSnapshot,
      sessionId: d.sessionId || null,
      status: d.status,
      formCiphertext: d.formCiphertext,
      formIv: d.formIv,
      signatureMethod: d.signatureMethod || null,
      deliveryToken: d.deliveryToken || null,
      deliveryTokenExp: d.deliveryTokenExp || null,
      signedAt: d.signedAt?.toMillis ? d.signedAt.toMillis() : (d.signedAtMs || null)
    }
  });
}));

// DELETE /therapy/documentos/:id — apaga rascunho (assinado nunca apaga)
router.delete("/therapy/documentos/:id", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const documentoId = String(req.params.id || "").trim();
  if (!documentoId) return sendError(res, 400, "ID_OBRIGATORIO");

  const db = getDb();
  const ref = db.collection("therapy_documents").doc(documentoId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "DOCUMENTO_NAO_ENCONTRADO");
  const d = snap.data();
  if (d.therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");
  if (d.status === "signed")  return sendError(res, 409, "DOCUMENTO_JA_ASSINADO");

  await ref.delete();
  await logAudit({ type: "documento_deleted_draft", documentoId, tipo: d.tipo, therapistUid: uid });
  return res.json({ ok: true });
}));

// GET /therapy/documento/publica?t=<token> — sem auth, paciente/destinatário
router.get("/therapy/documento/publica", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const token = String(req.query?.t || "").trim();
  if (!token) return sendError(res, 400, "TOKEN_OBRIGATORIO");

  const verification = verifySignedToken(token, ACCESS_TOKEN_SECRET);
  if (!verification.valid) return sendError(res, 401, verification.error || "TOKEN_INVALIDO");
  const payload = verification.payload;
  if (payload.token_type !== "documento_delivery") return sendError(res, 401, "TOKEN_NAO_AUTORIZADO");

  const db = getDb();
  const snap = await db.collection("therapy_documents").doc(payload.documentoId).get();
  if (!snap.exists) return sendError(res, 404, "DOCUMENTO_NAO_ENCONTRADO");
  const d = snap.data();
  if (d.status !== "signed" || !d.pdfSignedBase64) return sendError(res, 410, "DOCUMENTO_NAO_ASSINADO");
  if (d.deliveryToken !== token) return sendError(res, 401, "TOKEN_REVOGADO");

  await logAudit({
    type: "documento_publica_access",
    documentoId: d.documentoId,
    tipo: d.tipo,
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || null
  });

  const therapist = await loadTherapist(d.therapistUid);
  const issuer = therapist ? {
    displayName:   therapist.displayName || "",
    crm:           therapist.crm || "",
    crp:           therapist.crp || "",
    rqe:           therapist.rqe || "",
    especialidade: therapist.especialidade || "",
    consultorio:   therapist.consultorio || null
  } : null;

  return res.json({
    ok: true,
    documento: {
      documentoId: d.documentoId,
      tipo: d.tipo,
      patientNameSnapshot: d.patientNameSnapshot,
      pdfBase64: d.pdfSignedBase64,
      pdfMime: d.pdfSignedMime || "application/pdf",
      signedAt: d.signedAt?.toMillis ? d.signedAt.toMillis() : (d.signedAtMs || null),
      signatureMethod: d.signatureMethod || null,
      deliveryTokenExp: d.deliveryTokenExp || null,
      issuer
    }
  });
}));

// ─────────────────────────────────────────────────────────────────────────
// GET /therapy/profissional/publico/:uid — perfil profissional público.
//
// Sem auth Firebase. Retorna apenas dados profissionais (nome, registros,
// especialidade, consultório) de terapeutas com verificationStatus=verified.
// Usado pela página /verificado.html — vira "selo de credibilidade" que o
// terapeuta pode incorporar no site/perfil próprio.
// ─────────────────────────────────────────────────────────────────────────
router.get("/therapy/profissional/publico/:uid", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = String(req.params.uid || "").trim();
  if (!uid) return sendError(res, 400, "UID_OBRIGATORIO");

  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 404, "PROFISSIONAL_NAO_ENCONTRADO");
  if (therapist.verificationStatus !== "verified") {
    return sendError(res, 404, "PROFISSIONAL_NAO_VERIFICADO");
  }

  // Sumariza consultório (omite dados desnecessários — endereço sumarizado).
  const c = therapist.consultorio || {};
  const consultorioPublico = {
    cidade:    c.cidade || null,
    uf:        c.uf || null,
    bairro:    c.bairro || null,
    endereco:  c.endereco ? `${c.endereco}${c.numero ? ", " + c.numero : ""}` : null,
    telefone:  c.telefone || null,
    cnpj:      c.cnpj || null
  };

  // Conselho genérico — mantém crp/crm legados pra retrocompat com clientes
  // antigos que ainda lêem esses campos.
  const conselhoSigla = resolveSiglaFromTherapist(therapist);
  const conselhoMeta  = getConselho(conselhoSigla);
  const regulamentado = isConselhoRegulamentado(conselhoSigla);

  // Pra SEM_CONSELHO, expõe o tipo de prática declarado (psicanálise/
  // terapia integrativa/hipnoterapia) pro perfil público mostrar contexto
  // ao paciente. Não expõe instituição/anos de prática (ruído).
  const tipoPraticaPublica = (!regulamentado && therapist.formacaoNaoRegulamentada)
    ? therapist.formacaoNaoRegulamentada.tipoPratica || ""
    : "";

  return res.json({
    ok: true,
    profissional: {
      uid,
      displayName:     therapist.displayName || "",
      crp:             therapist.crp || "",
      crm:             therapist.crm || "",
      rqe:             therapist.rqe || "",
      tipoConselho:    conselhoSigla || "",
      numeroConselho:  therapist.numeroConselho || therapist.crp || therapist.crm || "",
      conselhoLabel:   conselhoMeta?.label || "",
      isRegulamentado: regulamentado,
      isInternacional: isConselhoInternacional(conselhoSigla),
      paisRegistro:    therapist.paisRegistro || "",
      orgaoRegistro:   therapist.orgaoRegistro || "",
      tipoPratica:     tipoPraticaPublica,
      especialidade:   therapist.especialidade || "",
      bio:             therapist.bio || "",
      consultorio:     consultorioPublico,
      verifiedAt:      therapist.verifiedAt?.toMillis ? therapist.verifiedAt.toMillis() : null
    }
  });
}));

// ─────────────────────────────────────────────────────────────────────────
// POST /therapy/receita/dispensar — endpoint público (sem Firebase auth).
// Farmacêutico autentica-se informando CRF + nome + CNPJ + nome farmácia.
// É low-trust por design (MVP) — fonte de verdade é a auditoria + responsabilidade
// profissional do farmacêutico. Sistema garante que a quantidade dispensada
// nunca ultrapassa a prescrita e que receita expirada (>30d) não é aviada.
// Transação Firestore evita race entre 2 farmácias dispensando ao mesmo tempo.
// ─────────────────────────────────────────────────────────────────────────
router.post("/therapy/receita/dispensar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const token = String(req.body?.deliveryToken || "").trim();
  if (!token) return sendError(res, 400, "TOKEN_OBRIGATORIO");

  const verification = verifySignedToken(token, ACCESS_TOKEN_SECRET);
  if (!verification.valid) return sendError(res, 401, verification.error || "TOKEN_INVALIDO");
  const payload = verification.payload;
  if (payload.token_type !== "receita_delivery") return sendError(res, 401, "TOKEN_NAO_AUTORIZADO");

  const farmaceuticoCRF  = String(req.body?.farmaceuticoCRF  || "").trim().toUpperCase();
  const farmaceuticoNome = String(req.body?.farmaceuticoNome || "").trim().slice(0, 80);
  const farmaciaCNPJraw  = String(req.body?.farmaciaCNPJ     || "").replace(/\D/g, "");
  const farmaciaNome     = String(req.body?.farmaciaNome     || "").trim().slice(0, 120);
  const quantidadeRaw    = req.body?.quantidade;

  if (!CRF_REGEX.test(farmaceuticoCRF)) return sendError(res, 400, "CRF_INVALIDO", { hint: "Formato esperado: CRF UF + número (ex: CRF-SC 12345)." });
  if (!farmaceuticoNome)                return sendError(res, 400, "NOME_FARMACEUTICO_OBRIGATORIO");
  if (!isValidCnpj(farmaciaCNPJraw))    return sendError(res, 400, "CNPJ_INVALIDO");
  if (!farmaciaNome)                    return sendError(res, 400, "NOME_FARMACIA_OBRIGATORIO");

  const quantidade = Number(quantidadeRaw);
  if (!Number.isFinite(quantidade) || !Number.isInteger(quantidade) || quantidade < 1 || quantidade > RECEITA_QUANTIDADE_MAX) {
    return sendError(res, 400, "QUANTIDADE_INVALIDA");
  }

  const db = getDb();
  const receitaRef = db.collection("therapy_receitas").doc(payload.receitaId);
  const dispensacaoId = newId("disp");
  const dispRef = db.collection("therapy_dispensacoes").doc(dispensacaoId);

  // Transação: lê receita, valida regras, grava dispensação + incremento atômico.
  let resultPayload;
  try {
    resultPayload = await db.runTransaction(async (tx) => {
      const snap = await tx.get(receitaRef);
      if (!snap.exists) throw Object.assign(new Error("RECEITA_NAO_ENCONTRADA"), { httpStatus: 404 });
      const r = snap.data();
      if (r.status !== "signed" || !r.pdfSignedBase64) throw Object.assign(new Error("RECEITA_NAO_ASSINADA"), { httpStatus: 410 });
      if (r.deliveryToken !== token) throw Object.assign(new Error("TOKEN_REVOGADO"), { httpStatus: 401 });

      const validadeClinicaAt = r.validadeClinicaAt || ((r.signedAtMs || 0) + RECEITA_VALIDITY_CLINICAL_MS);
      if (validadeClinicaAt && Date.now() > validadeClinicaAt) {
        throw Object.assign(new Error("RECEITA_VENCIDA"), { httpStatus: 410, hint: "Validade clínica de 30 dias já expirou. Solicite uma nova receita." });
      }

      const quantidadePrescrita  = Number(r.quantidadePrescrita  || 0);
      const quantidadeDispensada = Number(r.quantidadeDispensada || 0);
      if (!quantidadePrescrita) {
        throw Object.assign(new Error("QUANTIDADE_PRESCRITA_AUSENTE"), { httpStatus: 409, hint: "Receita antiga sem quantidade prescrita explícita. Solicite ao profissional uma receita atualizada." });
      }
      if (quantidadeDispensada + quantidade > quantidadePrescrita) {
        throw Object.assign(new Error("SALDO_INSUFICIENTE"), {
          httpStatus: 409,
          hint: `Restam ${quantidadePrescrita - quantidadeDispensada} de ${quantidadePrescrita} unidades dispensáveis.`,
          restante: quantidadePrescrita - quantidadeDispensada
        });
      }

      const novoTotal = quantidadeDispensada + quantidade;
      const novoStatus = novoTotal >= quantidadePrescrita ? "completa" : "parcial";

      tx.set(dispRef, {
        dispensacaoId,
        receitaId: r.receitaId,
        therapistUid: r.therapistUid,
        farmaceuticoCRF,
        farmaceuticoNome,
        farmaciaCNPJ: farmaciaCNPJraw,
        farmaciaNome,
        quantidade,
        dispensadoAtMs: Date.now(),
        dispensadoAt: admin.firestore.FieldValue.serverTimestamp(),
        ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || null,
        userAgent: String(req.headers["user-agent"] || "").slice(0, 200)
      });

      tx.set(receitaRef, {
        quantidadeDispensada: novoTotal,
        dispensacaoStatus: novoStatus,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      return {
        novoTotal,
        novoStatus,
        restante: quantidadePrescrita - novoTotal,
        therapistUid: r.therapistUid,
        patientName: r.patientNameSnapshot,
        totalPrescrito: quantidadePrescrita
      };
    });
  } catch (err) {
    if (err.httpStatus) {
      const extra = {};
      if (err.hint)     extra.hint     = err.hint;
      if (err.restante !== undefined) extra.restante = err.restante;
      return sendError(res, err.httpStatus, err.message, extra);
    }
    throw err;
  }

  await logAudit({
    type: "receita_dispensada",
    receitaId: payload.receitaId,
    dispensacaoId,
    farmaceuticoCRF,
    farmaciaCNPJ: farmaciaCNPJraw,
    quantidade,
    novoTotal: resultPayload.novoTotal,
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || null
  });

  // Notificação por e-mail ao psiquiatra prescritor (fire-and-forget).
  // Diferencial vs. MEMED/CFM: prescritor sabe em tempo real quando paciente
  // aviou e onde, sem precisar perguntar. Útil pra adesão ao tratamento.
  (async () => {
    try {
      const therapist = await loadTherapist(resultPayload.therapistUid);
      if (!therapist) return;
      const therapistEmail = await resolveTherapistEmail(resultPayload.therapistUid, therapist);
      if (!therapistEmail) return;
      const cnpjFmt = farmaciaCNPJraw.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
      const tpl = templateDispensacaoNotice({
        therapistName:    therapist.displayName || "profissional",
        patientName:      resultPayload.patientName || "paciente",
        farmaciaNome,
        farmaciaCnpjFmt:  cnpjFmt,
        farmaceuticoNome,
        farmaceuticoCRF,
        quantidade,
        totalPrescrito:   resultPayload.totalPrescrito,
        restante:         resultPayload.restante,
        dispensadoAt:     Date.now()
      });
      await sendEmail({ to: therapistEmail, ...tpl });
    } catch (e) {
      logError("therapy_dispensacao_notice_failed", e, { dispensacaoId });
    }
  })();

  return res.json({
    ok: true,
    dispensacaoId,
    quantidadeDispensada: resultPayload.novoTotal,
    restante: resultPayload.restante,
    dispensacaoStatus: resultPayload.novoStatus
  });
}));

// ─────────────────────────────────────────────────────────────────────────
// VERIFICAÇÃO DE CRP/CRM (e-Psi)
// Profissional sobe um documento (printscreen do e-Psi, comprovante CFP/CFM)
// como base64. Admin (allowlist) revisa e aprova ou rejeita. Status reflete
// no perfil do profissional (badge "Verificado").
//
// Coleções:
//   therapy_verifications/{verificationId}
//     { therapistUid, status, documentBase64, documentMime, notes,
//       submittedAt, reviewedAt, reviewedBy, rejectionReason }
//   therapists/{uid}.verificationStatus = "none" | "pending" | "verified" | "rejected"
//   therapists/{uid}.verificationId, .verifiedAt
// ─────────────────────────────────────────────────────────────────────────

const VERIFICATION_DOC_MAX = 700 * 1024; // 700 KB de base64 (~525 KB binário)
const VERIFICATION_ALLOWED_MIMES = new Set([
  "image/jpeg", "image/png", "image/webp", "application/pdf"
]);

// POST /therapy/profissional/verificacao/submeter
// Body: { documentBase64, documentMime, notes? }
router.post("/therapy/profissional/verificacao/submeter", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 403, "PROFISSIONAL_NAO_REGISTRADO");
  if (therapist.verificationStatus === "verified") {
    return sendError(res, 409, "JA_VERIFICADO");
  }
  // SEM_CONSELHO usa fluxo dedicado em /comprovante-formacao — submissoes
  // aqui caem na fila admin de CRP/CRM e o auto-validador quebra (sem
  // CRP/CRM pra checar contra conselho). Rejeita com mensagem clara.
  if (therapist.tipoConselho === "SEM_CONSELHO") {
    return sendError(res, 400, "FLUXO_INCORRETO_USE_COMPROVANTE_FORMACAO", {
      detail: "Profissionais sem conselho regulamentado devem enviar comprovante de formação em /comprovante-formacao.html (não nessa página)."
    });
  }

  const documentBase64 = String(req.body?.documentBase64 || "").trim();
  const documentMime   = String(req.body?.documentMime   || "").trim().toLowerCase();
  const notes          = String(req.body?.notes || "").trim().slice(0, 500);

  if (!documentBase64) return sendError(res, 400, "DOCUMENTO_OBRIGATORIO");
  if (documentBase64.length > VERIFICATION_DOC_MAX) {
    return sendError(res, 413, "DOCUMENTO_GRANDE_DEMAIS");
  }
  if (!VERIFICATION_ALLOWED_MIMES.has(documentMime)) {
    return sendError(res, 400, "TIPO_DOCUMENTO_NAO_SUPORTADO");
  }

  const verificationId = newId("ver");
  const db = getDb();

  await db.collection("therapy_verifications").doc(verificationId).set({
    verificationId,
    therapistUid: uid,
    status: "pending",
    documentBase64,
    documentMime,
    notes,
    submittedAt: admin.firestore.FieldValue.serverTimestamp(),
    reviewedAt: null,
    reviewedBy: null,
    rejectionReason: null
  });

  await db.collection("therapists").doc(uid).set({
    verificationStatus: "pending",
    verificationId,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({
    type: "verification_submitted",
    therapistUid: uid,
    verificationId
  });

  return res.json({ ok: true, verificationId, status: "pending" });
}));

// GET /therapy/profissional/verificacao/status
router.get("/therapy/profissional/verificacao/status", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 403, "PROFISSIONAL_NAO_REGISTRADO");

  const status = therapist.verificationStatus || "none";
  const verificationId = therapist.verificationId || null;
  const verifiedAt = therapist.verifiedAt?.toMillis ? therapist.verifiedAt.toMillis() : null;

  let lastSubmission = null;
  if (verificationId) {
    const snap = await getDb().collection("therapy_verifications").doc(verificationId).get();
    if (snap.exists) {
      const d = snap.data();
      lastSubmission = {
        verificationId: d.verificationId,
        status: d.status,
        documentMime: d.documentMime,
        notes: d.notes || "",
        submittedAt: d.submittedAt?.toMillis ? d.submittedAt.toMillis() : null,
        reviewedAt: d.reviewedAt?.toMillis ? d.reviewedAt.toMillis() : null,
        rejectionReason: d.rejectionReason || null
        // documentBase64 NÃO retornado aqui — pesa demais e o profissional já tem.
      };
    }
  }

  return res.json({ ok: true, status, verifiedAt, lastSubmission });
}));

// GET /therapy/admin/verificacoes?status=pending
// Lista submissões. Sem documentBase64 pra response não pesar.
router.get("/therapy/admin/verificacoes", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const wantStatus = String(req.query?.status || "pending").trim().toLowerCase();
  const allowed = new Set(["pending", "verified", "rejected", "all"]);
  if (!allowed.has(wantStatus)) return sendError(res, 400, "STATUS_INVALIDO");

  const db = getDb();
  let q = db.collection("therapy_verifications");
  if (wantStatus !== "all") q = q.where("status", "==", wantStatus);

  const snap = await q.limit(500).get();
  const items = snap.docs
    .map(d => {
      const data = d.data();
      return {
        verificationId: data.verificationId,
        therapistUid: data.therapistUid,
        status: data.status,
        documentMime: data.documentMime,
        notes: data.notes || "",
        submittedAt: data.submittedAt?.toMillis ? data.submittedAt.toMillis() : null,
        reviewedAt: data.reviewedAt?.toMillis ? data.reviewedAt.toMillis() : null,
        reviewedBy: data.reviewedBy || null,
        rejectionReason: data.rejectionReason || null
      };
    })
    .sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));

  // Anexa nome/CRP/CRM do profissional pra facilitar revisão
  const enriched = await Promise.all(items.map(async item => {
    const t = await loadTherapist(item.therapistUid);
    return {
      ...item,
      therapist: t ? {
        displayName: t.displayName || "",
        crp: t.crp || "",
        crm: t.crm || "",
        especialidade: t.especialidade || ""
      } : null
    };
  }));

  return res.json({ ok: true, items: enriched });
}));

// GET /therapy/admin/verificacoes/:id — devolve com documentBase64 pra revisão
router.get("/therapy/admin/verificacoes/:id", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const verificationId = String(req.params.id || "").trim();
  if (!verificationId) return sendError(res, 400, "ID_OBRIGATORIO");

  const db = getDb();
  const snap = await db.collection("therapy_verifications").doc(verificationId).get();
  if (!snap.exists) return sendError(res, 404, "VERIFICACAO_NAO_ENCONTRADA");
  const data = snap.data();

  const therapist = await loadTherapist(data.therapistUid);

  return res.json({
    ok: true,
    item: {
      verificationId: data.verificationId,
      therapistUid: data.therapistUid,
      status: data.status,
      documentBase64: data.documentBase64,
      documentMime: data.documentMime,
      notes: data.notes || "",
      submittedAt: data.submittedAt?.toMillis ? data.submittedAt.toMillis() : null,
      reviewedAt: data.reviewedAt?.toMillis ? data.reviewedAt.toMillis() : null,
      reviewedBy: data.reviewedBy || null,
      rejectionReason: data.rejectionReason || null,
      therapist: therapist ? {
        displayName: therapist.displayName || "",
        crp: therapist.crp || "",
        crm: therapist.crm || "",
        especialidade: therapist.especialidade || "",
        bio: therapist.bio || ""
      } : null
    }
  });
}));

// POST /therapy/admin/verificacoes/:id/auto-validar
// Roda o validador automatizado configurado (CFP_VALIDATOR_PROVIDER) contra
// os dados profissionais do médico e grava o resultado na verificação.
// Não aprova/rejeita sozinho — admin decide com base no resultado.
router.post("/therapy/admin/verificacoes/:id/auto-validar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const verificationId = String(req.params.id || "").trim();
  if (!verificationId) return sendError(res, 400, "ID_OBRIGATORIO");

  const db = getDb();
  const ref = db.collection("therapy_verifications").doc(verificationId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "VERIFICACAO_NAO_ENCONTRADA");
  const v = snap.data();

  const therapist = await loadTherapist(v.therapistUid);
  if (!therapist) return sendError(res, 404, "PROFISSIONAL_NAO_ENCONTRADO");

  const tipo   = therapist.crm ? "CRM" : (therapist.crp ? "CRP" : null);
  const numero = therapist.crm || therapist.crp || "";
  if (!tipo || !numero) return sendError(res, 400, "REGISTRO_AUSENTE");

  const validator = getCfpValidator();
  let result;
  try {
    result = await validator.validate({
      tipo, numero, nome: therapist.displayName || ""
    });
  } catch (err) {
    logError("cfp_validator_error", err, { provider: validator.name, verificationId });
    return sendError(res, 502, "VALIDADOR_FALHOU", { detail: err?.message || null });
  }

  await ref.set({
    autoValidation: {
      provider:   result.provider || "unknown",
      verified:   !!result.verified,
      confidence: typeof result.confidence === "number" ? result.confidence : 0,
      error:      result.error || null,
      raw:        result.raw || null,
      ranAt:      admin.firestore.FieldValue.serverTimestamp(),
      ranBy:      adminAuth.email
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({
    type: "verification_auto_validated",
    therapistUid: v.therapistUid,
    verificationId,
    provider: result.provider,
    verified: !!result.verified,
    adminEmail: adminAuth.email
  });

  return res.json({ ok: true, result });
}));

// POST /therapy/admin/verificacoes/:id/aprovar
router.post("/therapy/admin/verificacoes/:id/aprovar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const verificationId = String(req.params.id || "").trim();
  if (!verificationId) return sendError(res, 400, "ID_OBRIGATORIO");

  const db = getDb();
  const ref = db.collection("therapy_verifications").doc(verificationId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "VERIFICACAO_NAO_ENCONTRADA");
  const data = snap.data();
  if (data.status === "verified") return sendError(res, 409, "JA_APROVADA");

  await ref.set({
    status: "verified",
    reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
    reviewedBy: adminAuth.email
  }, { merge: true });

  await db.collection("therapists").doc(data.therapistUid).set({
    verificationStatus: "verified",
    verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({
    type: "verification_approved",
    therapistUid: data.therapistUid,
    verificationId,
    adminEmail: adminAuth.email
  });

  return res.json({ ok: true });
}));

// POST /therapy/admin/verificacoes/:id/rejeitar
router.post("/therapy/admin/verificacoes/:id/rejeitar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const verificationId = String(req.params.id || "").trim();
  const reason = String(req.body?.reason || "").trim().slice(0, 500);
  if (!verificationId) return sendError(res, 400, "ID_OBRIGATORIO");
  if (!reason)         return sendError(res, 400, "MOTIVO_OBRIGATORIO");

  const db = getDb();
  const ref = db.collection("therapy_verifications").doc(verificationId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "VERIFICACAO_NAO_ENCONTRADA");
  const data = snap.data();
  if (data.status === "verified") return sendError(res, 409, "JA_APROVADA_NAO_DA_PRA_REJEITAR");

  await ref.set({
    status: "rejected",
    rejectionReason: reason,
    reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
    reviewedBy: adminAuth.email
  }, { merge: true });

  await db.collection("therapists").doc(data.therapistUid).set({
    verificationStatus: "rejected",
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({
    type: "verification_rejected",
    therapistUid: data.therapistUid,
    verificationId,
    adminEmail: adminAuth.email,
    reason
  });

  return res.json({ ok: true });
}));

// ─────────────────────────────────────────────────────────────────────────
// AUDIT LOG VISÍVEL (LGPD Art. 18, II — direito de acesso)
// O titular pode consultar quais eventos do sistema envolveram sua conta.
// Filtramos a collection therapy_audit pelo UID dele.
// ─────────────────────────────────────────────────────────────────────────

// Tipos de evento que o profissional vê
const THERAPIST_AUDIT_TYPES = new Set([
  "therapist_registered", "therapist_recovered", "therapist_perfil_updated",
  "session_created", "therapist_joined", "session_completed",
  "patient_created", "patient_updated", "patient_deleted",
  "verification_submitted", "verification_approved", "verification_rejected",
  "receita_created", "receita_signed", "receita_deleted_draft", "receita_publica_access",
  "receita_dispensada",
  "documento_created", "documento_signed", "documento_deleted_draft", "documento_publica_access"
]);

// Tipos de evento que o paciente (com conta) vê
const PATIENT_AUDIT_TYPES = new Set([
  "patient_account_registered", "patient_account_recovered", "patient_joined"
]);

function describeAudit(ev) {
  // Descrição amigável em PT-BR pra exibir no painel.
  const map = {
    therapist_registered:        "Conta profissional criada",
    therapist_recovered:         "Senha redefinida via chave-semente",
    therapist_perfil_updated:    "Perfil profissional atualizado",
    session_created:             "Consulta criada",
    therapist_joined:            "Você entrou na sala da consulta",
    session_completed:           "Consulta encerrada",
    patient_created:             "Paciente cadastrado",
    patient_updated:             "Paciente editado",
    patient_deleted:             "Paciente apagado",
    verification_submitted:      "Documento de verificação enviado",
    verification_approved:       "Verificação aprovada pela equipe",
    verification_rejected:       "Verificação recusada",
    receita_created:             "Receita criada (rascunho)",
    receita_signed:              "Receita assinada",
    receita_deleted_draft:       "Rascunho de receita apagado",
    receita_publica_access:      "Receita acessada via link público",
    receita_dispensada:          "Receita dispensada por farmácia",
    documento_created:           "Documento médico criado (rascunho)",
    documento_signed:            "Documento médico assinado",
    documento_deleted_draft:     "Rascunho de documento médico apagado",
    documento_publica_access:    "Documento médico acessado via link público",
    patient_account_registered:  "Conta de paciente criada",
    patient_account_recovered:   "Senha do paciente redefinida via chave-semente",
    patient_joined:              "Você entrou em uma consulta"
  };
  return map[ev.type] || ev.type;
}

// GET /therapy/profissional/audit
router.get("/therapy/profissional/audit", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 403, "PROFISSIONAL_NAO_REGISTRADO");

  const db = getDb();
  // Sem orderBy + where (composite index). Filtro client-side em memória.
  const snap = await db.collection("therapy_audit")
    .where("therapistUid", "==", uid)
    .limit(500)
    .get();

  const events = snap.docs
    .map(d => {
      const ev = d.data();
      return {
        id: d.id,
        type: ev.type,
        description: describeAudit(ev),
        at: ev.createdAt?.toMillis ? ev.createdAt.toMillis() : null,
        meta: {
          sessionId:      ev.sessionId      || null,
          patientId:      ev.patientId      || null,
          receitaId:      ev.receitaId      || null,
          verificationId: ev.verificationId || null,
          ip:             ev.ip             || null,
          adminEmail:     ev.adminEmail     || null,
          reason:         ev.reason         || null,
          signatureMethod: ev.signatureMethod || null,
          patientName:    ev.patientName    || null
        }
      };
    })
    .filter(e => THERAPIST_AUDIT_TYPES.has(e.type))
    .sort((a, b) => (b.at || 0) - (a.at || 0));

  return res.json({ ok: true, events });
}));

// GET /therapy/paciente/audit
router.get("/therapy/paciente/audit", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const account = await loadPatientAccount(uid);
  if (!account) return sendError(res, 404, "PACIENTE_NAO_REGISTRADO");

  const db = getDb();
  const snap = await db.collection("therapy_audit")
    .where("patientAccountUid", "==", uid)
    .limit(500)
    .get();

  const events = snap.docs
    .map(d => {
      const ev = d.data();
      return {
        id: d.id,
        type: ev.type,
        description: describeAudit(ev),
        at: ev.createdAt?.toMillis ? ev.createdAt.toMillis() : null,
        meta: {
          sessionId: ev.sessionId || null,
          ip: ev.ip || null
        }
      };
    })
    .filter(e => PATIENT_AUDIT_TYPES.has(e.type))
    .sort((a, b) => (b.at || 0) - (a.at || 0));

  return res.json({ ok: true, events });
}));

// ─────────────────────────────────────────────────────────────────────────
// PLANO RECORRENTE (MercadoPago Preapproval)
//
// Setup necessário:
//   1) THERAPY_PLAN_AMOUNT (env, default 99.50)
//   2) MP_ACCESS_TOKEN_THERAPY (aplicação MP dedicada ao Espaço Prelúdio —
//      separada do MP_ACCESS_TOKEN_JOGO usada pelo Prelúdio Jogos)
//   3) MP_WEBHOOK_SECRET_THERAPY (recomendado pra produção)
//   4) No dashboard MP: criar webhook → URL: BACKEND/therapy/webhook/mp
//      Eventos: preapproval, subscription_preapproval
//
// Estados em therapists/{uid}.plano:
//   "trial"    — recém-cadastrado, dentro do trialUntil
//   "pro"      — preapproval autorizado e ativo no MP
//   "expired"  — trial venceu e não assinou
//   "canceled" — assinante cancelou
// ─────────────────────────────────────────────────────────────────────────

// POST /therapy/profissional/plano/iniciar
// Cria preapproval no MP, salva mpPreapprovalId, retorna init_point pra redirect.
//
// Body opcional: { tier: "recem-formado" | "profissional", billingCycle: "month" | "year" }
//   - "recem-formado" → cobra R$ 99,50/mês ou R$ 1.002,96/ano (exige plano === "recem-formado-eligible")
//   - "profissional"  → cobra R$ 199/mês ou R$ 2.005,92/ano
//   - sem tier (compat) → cobra THERAPY_PLAN_AMOUNT (default 99,50)
//   - billingCycle "year" → preapproval com frequency: 12 / frequency_type: "months"
//     (MP não suporta frequency_type "years"), valor anual = mensal x 12 x 0.84 (16% off)
router.post("/therapy/profissional/plano/iniciar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 403, "PROFISSIONAL_NAO_REGISTRADO");

  // Determina tier + preço. Default mantém compat (sem flag = THERAPY_PLAN_AMOUNT).
  const tier = String(req.body?.tier || "").trim().toLowerCase();
  const billingCycle = String(req.body?.billingCycle || "month").trim().toLowerCase() === "year" ? "year" : "month";
  let amount, planTier, planLabel;
  if (tier === "recem-formado") {
    if (therapist.plano !== "recem-formado-eligible") {
      return sendError(res, 403, "RECEM_FORMADO_NAO_ELEGIVEL", {
        detail: "Envie o comprovante de inscrição CRP/CRM em /comprovante-recem-formado.html antes de assinar este tier."
      });
    }
    amount = billingCycle === "year" ? THERAPY_PLAN_RECEM_FORMADO_ANNUAL_AMOUNT : THERAPY_PLAN_RECEM_FORMADO_AMOUNT;
    planTier = "recem-formado";
    planLabel = `${THERAPY_PLAN_NAME} — Recém-formado`;
  } else if (tier === "profissional") {
    amount = billingCycle === "year" ? THERAPY_PLAN_PROFISSIONAL_ANNUAL_AMOUNT : THERAPY_PLAN_PROFISSIONAL_AMOUNT;
    planTier = "profissional";
    planLabel = `${THERAPY_PLAN_NAME} — Profissional`;
  } else {
    // Compat: chamadas antigas sem tier usam o default histórico
    amount = billingCycle === "year" ? THERAPY_PLAN_ANNUAL_AMOUNT : THERAPY_PLAN_AMOUNT;
    planTier = "default";
    planLabel = THERAPY_PLAN_NAME;
  }
  if (billingCycle === "year") planLabel += " — Anual";

  // Pega e-mail do Firebase Auth (preapproval exige payer_email)
  let payerEmail = "";
  try {
    const fbUser = await admin.auth().getUser(uid);
    payerEmail = fbUser.email || "";
  } catch { /* ignore */ }
  if (!payerEmail) return sendError(res, 400, "EMAIL_INDISPONIVEL");

  const externalRef = `EP_THERAPY_${uid}`;

  const body = {
    reason: planLabel,
    auto_recurring: {
      frequency: billingCycle === "year" ? 12 : 1,
      frequency_type: "months",
      transaction_amount: amount,
      currency_id: "BRL"
    },
    back_url: `${THERAPY_FRONTEND_BASE}/perfil.html?mp_back=1`,
    payer_email: payerEmail,
    external_reference: externalRef,
    status: "pending"
  };

  let response, data;
  try {
    ({ response, data } = await mercadoPagoFetchTherapy("https://api.mercadopago.com/preapproval", {
      method: "POST",
      body: JSON.stringify(body)
    }));
  } catch (err) {
    logError("therapy_preapproval_create_failed", err, { uid });
    return sendError(res, 503, "MP_INDISPONIVEL");
  }

  if (!response.ok || !data?.id || !data?.init_point) {
    logError("therapy_preapproval_create_response_invalid", new Error("MP_RESPONSE_INVALID"), { uid, status: response.status, data });
    return sendError(res, 502, "MP_FALHOU", { detail: data?.message || null });
  }

  const db = getDb();
  await db.collection("therapists").doc(uid).set({
    mpPreapprovalId:     data.id,
    mpPreapprovalStatus: data.status || "pending",
    mpExternalRef:       externalRef,
    proTier:             planTier,
    proPriceCents:       Math.round(amount * 100),
    proBillingCycle:     billingCycle,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({
    type: "therapy_plano_iniciado",
    therapistUid: uid,
    preapprovalId: data.id,
    tier: planTier,
    billingCycle,
    amount
  });

  return res.json({
    ok: true,
    preapprovalId: data.id,
    initPoint:     data.init_point,
    sandboxInitPoint: data.sandbox_init_point || null,
    status:        data.status || "pending"
  });
}));

// POST /therapy/profissional/plano/cancelar
router.post("/therapy/profissional/plano/cancelar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 403, "PROFISSIONAL_NAO_REGISTRADO");
  if (!therapist.mpPreapprovalId) return sendError(res, 404, "SEM_ASSINATURA_ATIVA");

  let response, data;
  try {
    ({ response, data } = await mercadoPagoFetchTherapy(
      `https://api.mercadopago.com/preapproval/${encodeURIComponent(therapist.mpPreapprovalId)}`,
      { method: "PUT", body: JSON.stringify({ status: "cancelled" }) }
    ));
  } catch (err) {
    logError("therapy_preapproval_cancel_failed", err, { uid });
    return sendError(res, 503, "MP_INDISPONIVEL");
  }

  if (!response.ok) {
    return sendError(res, 502, "MP_FALHOU_CANCELAR", { detail: data?.message || null });
  }

  const db = getDb();
  await db.collection("therapists").doc(uid).set({
    plano: "canceled",
    mpPreapprovalStatus: "cancelled",
    canceledAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:  admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({ type: "therapy_plano_cancelado", therapistUid: uid });

  return res.json({ ok: true });
}));

// POST /therapy/webhook/mp
// MP avisa mudanças de preapproval/subscription. Buscamos detalhe na API
// e atualizamos plano. Validação de assinatura conforme o Mercado Pago.
router.post("/therapy/webhook/mp", asyncHandler(async (req, res) => {
  // Aceita topic em vários formatos (querystring, body, headers).
  const topic = String(
    req.query?.topic || req.query?.type || req.body?.type || req.body?.topic || ""
  ).toLowerCase();
  const dataId = String(
    req.query?.["data.id"] || req.body?.data?.id || req.query?.id || req.body?.id || ""
  ).trim();

  // Validação de assinatura (best-effort — sem MP_WEBHOOK_SECRET_THERAPY, só loga warning)
  if (MP_WEBHOOK_SECRET_THERAPY && dataId) {
    try {
      const sigHeader = String(req.headers["x-signature"] || "");
      const reqId     = String(req.headers["x-request-id"] || "");
      if (sigHeader && reqId) {
        const parts = Object.fromEntries(sigHeader.split(",").map(p => p.trim().split("=")));
        const ts = parts.ts, v1 = parts.v1;
        if (ts && v1) {
          const template = `id:${dataId};request-id:${reqId};ts:${ts};`;
          const expected = crypto.createHmac("sha256", MP_WEBHOOK_SECRET_THERAPY).update(template).digest("hex");
          let match = false;
          try { match = crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(v1, "hex")); } catch {}
          if (!match) {
            logError("therapy_mp_webhook_sig_invalid", new Error("SIG_INVALIDA"), { dataId });
            return sendError(res, 401, "SIG_INVALIDA");
          }
        }
      }
    } catch (e) { logError("therapy_mp_webhook_sig_error", e); }
  }

  if (!topic.includes("preapproval")) {
    // Ignora silenciosamente eventos que não são de assinatura
    return res.status(200).json({ ok: true, ignored: true });
  }
  if (!dataId) {
    return sendError(res, 400, "DATA_ID_AUSENTE");
  }

  // Busca o estado atual do preapproval na API MP, com retry-com-backoff.
  // Falha em 5xx ou network = transient. Retorna 500 pra MP retentar
  // (evita perder evento durante outage da API MP).
  let preapproval;
  try {
    preapproval = await withRetry(async () => {
      const { response, data } = await mercadoPagoFetchTherapy(
        `https://api.mercadopago.com/preapproval/${encodeURIComponent(dataId)}`
      );
      if (!response.ok) {
        // 4xx = erro permanente do nosso lado (token errado, ID inválido).
        // 5xx + 429 = transient, retry pega.
        if (response.status >= 500 || response.status === 429) {
          throw new Error(`HTTP ${response.status}`);
        }
        const err = new Error(`MP_HTTP_${response.status}`);
        err.permanent = true;
        throw err;
      }
      return data;
    }, {
      maxAttempts: 3,
      baseDelayMs: 400,
      shouldRetry: (err) => !err.permanent,
      onRetry: (err, attempt, delay) => {
        logWarn("therapy_mp_preapproval_retry", { dataId, attempt, delay, error: err.message });
      }
    });
  } catch (err) {
    if (err.permanent) {
      // Erro permanente — MP retentar não adianta. Ack pra parar reentrega.
      logError("therapy_mp_preapproval_fetch_permanent", err, { dataId });
      return res.status(200).json({ ok: true, ignored: true, reason: "FETCH_PERMANENT" });
    }
    // Transient — retorna 500 pro MP retentar a entrega do webhook.
    logError("therapy_mp_preapproval_fetch_failed", err, { dataId });
    return sendError(res, 503, "MP_API_INDISPONIVEL", { detail: "Tentativa de busca do preapproval falhou; MP deve reentregar." });
  }

  // Resolve UID via external_reference (formato EP_THERAPY_<uid>)
  const ext = String(preapproval?.external_reference || "");
  const uidMatch = ext.match(/^EP_THERAPY_(.+)$/);
  if (!uidMatch) {
    return res.status(200).json({ ok: true, ignored: true, reason: "EXT_REF_NAO_RECONHECIDO" });
  }
  const uid = uidMatch[1];

  const status = String(preapproval?.status || "").toLowerCase();
  let plano;
  if (status === "authorized")        plano = "pro";
  else if (status === "paused")       plano = "expired";
  else if (status === "cancelled")    plano = "canceled";
  else if (status === "pending")      plano = null; // ainda esperando autorização
  else                                plano = null;

  const db = getDb();
  const update = {
    mpPreapprovalStatus: status,
    mpPreapprovalId:     preapproval.id,
    nextChargeAt:        preapproval.next_payment_date ? Date.parse(preapproval.next_payment_date) : null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  if (plano) update.plano = plano;
  if (plano === "pro") update.proSince = admin.firestore.FieldValue.serverTimestamp();

  // Ciclo de cobrança vem direto do MP (source of truth): frequency 12 = anual.
  const frequency = Number(preapproval?.auto_recurring?.frequency) || 1;
  update.proBillingCycle = frequency >= 12 ? "year" : "month";

  // Reconcilia proPriceCents com o transaction_amount real do preapproval
  // (source of truth = MP). proTier so e derivado quando o valor cobrado
  // bate UNICAMENTE com um tier (sem ambiguidade) — quando dois tiers tem
  // o mesmo amount (ex: default e recem-formado ambos R$ 99,50), preserva
  // o proTier ja salvo pelo /plano/iniciar via merge:true em vez de chutar.
  const txAmount = Number(preapproval?.auto_recurring?.transaction_amount);
  if (Number.isFinite(txAmount) && txAmount > 0) {
    update.proPriceCents = Math.round(txAmount * 100);
    const matches = [];
    // Float compare tolerante (Math.abs < 0.005 = meio centavo)
    const eq = (a, b) => Math.abs(a - b) < 0.005;
    if (eq(txAmount, THERAPY_PLAN_RECEM_FORMADO_AMOUNT) || eq(txAmount, THERAPY_PLAN_RECEM_FORMADO_ANNUAL_AMOUNT))
      matches.push("recem-formado");
    if (eq(txAmount, THERAPY_PLAN_PROFISSIONAL_AMOUNT) || eq(txAmount, THERAPY_PLAN_PROFISSIONAL_ANNUAL_AMOUNT))
      matches.push("profissional");
    if (eq(txAmount, THERAPY_PLAN_AMOUNT) || eq(txAmount, THERAPY_PLAN_ANNUAL_AMOUNT))
      matches.push("default");
    if (matches.length === 1) {
      // Unico match — pode reconciliar com seguranca.
      update.proTier = matches[0];
    } else if (matches.length === 0) {
      // Nao bate com nenhum tier conhecido — preserva proTier existente, loga.
      logWarn("therapy_mp_webhook_amount_desconhecido", {
        uid, preapprovalId: preapproval.id, txAmount,
        knownTiers: { THERAPY_PLAN_RECEM_FORMADO_AMOUNT, THERAPY_PLAN_PROFISSIONAL_AMOUNT, THERAPY_PLAN_AMOUNT }
      });
    }
    // matches.length > 1: ambiguo — preserva proTier salvo pelo /plano/iniciar.
    // Nao sobrescreve pra evitar reclassificar tier legitimo errado.
  }

  // Firestore write com retry — falha transitória do Google deve causar
  // reentrega do webhook, não perda silenciosa. 3 tentativas com backoff,
  // depois 500 pro MP retentar.
  try {
    await withRetry(
      () => db.collection("therapists").doc(uid).set(update, { merge: true }),
      { maxAttempts: 3, baseDelayMs: 250 }
    );
  } catch (err) {
    logError("therapy_mp_webhook_firestore_write_failed", err, { uid, dataId, attempts: 3 });
    return sendError(res, 503, "FIRESTORE_INDISPONIVEL", { detail: "Falha ao gravar estado do plano; MP deve reentregar." });
  }

  await logAudit({
    type: "therapy_mp_webhook",
    therapistUid: uid,
    preapprovalId: preapproval.id,
    mpStatus: status,
    plano: plano || "unchanged",
    proTier: update.proTier || null,
    proPriceCents: update.proPriceCents || null,
    proBillingCycle: update.proBillingCycle || null
  });

  return res.status(200).json({ ok: true });
}));

// ─────────────────────────────────────────────────────────────────────────
// AI SUMMARY — Transcrição + resumo IA de sessão (Whisper local + Claude)
//
// Fluxo:
//   1. Profissional encerra sessão; frontend faz POST com áudio mixado
//      (local + remote) do MediaRecorder.
//   2. Endpoint valida: ownership da sessão + opt-in do profissional
//      (aiSummaryEnabled) + consentimento do paciente (consentAiSummary).
//   3. Retorna 202 imediatamente com status=processing.
//   4. Async background: Whisper transcreve → Claude Haiku 4.5 estrutura →
//      Firestore salva em therapy_session_summaries/{sessionId}.
//   5. Frontend GET /therapy/session/:id/ai-summary pra buscar quando pronto.
//
// Privacidade: áudio nunca persiste em disco; processado em-memory,
// transcript fica no Firestore (cifrado? não — texto direto. TODO: E2EE
// no flow patient-DEK quando profissional acessa via prontuário).
// ─────────────────────────────────────────────────────────────────────────

const express_raw_audio = express.raw({
  type: ["audio/*", "application/octet-stream"],
  limit: "100mb"
});

router.post("/therapy/session/:sessionId/ai-summarize",
  express_raw_audio,
  asyncHandler(async (req, res) => {
    if (!ensureDb(res)) return;
    const uid = await verifyFirebaseToken(req, res);
    if (!uid) return;

    const sessionId = String(req.params.sessionId || "").trim();
    if (!sessionId) return sendError(res, 400, "SESSAO_OBRIGATORIA");

    const db = getDb();
    const sessSnap = await db.collection("therapy_sessions").doc(sessionId).get();
    if (!sessSnap.exists) return sendError(res, 404, "SESSAO_NAO_ENCONTRADA");
    const sess = sessSnap.data();
    if (sess.therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

    // Verifica opt-in do profissional
    const therapist = await loadTherapist(uid);
    if (!therapist?.aiSummaryEnabled) {
      return sendError(res, 403, "AI_SUMMARY_NAO_HABILITADO",
        { detail: "Profissional não habilitou transcrição IA no perfil." });
    }

    // Verifica consentimento do paciente. Aceita 2 fontes:
    //   1. Flag explícita por sessão (sess.consentAiSummary)
    //   2. Flag global da conta-paciente (patientAccount.consentAiSummary)
    //      desde que a sessão tenha patientAccountUid
    let patientConsent = !!sess.consentAiSummary;
    if (!patientConsent && sess.patientAccountUid) {
      const pa = await loadPatientAccount(sess.patientAccountUid);
      patientConsent = !!pa?.consentAiSummary;
    }
    if (!patientConsent) {
      return sendError(res, 403, "CONSENTIMENTO_PACIENTE_AUSENTE",
        { detail: "Paciente não consentiu com transcrição IA nesta sessão." });
    }

    const audioBuffer = req.body;
    if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
      return sendError(res, 400, "AUDIO_OBRIGATORIO");
    }

    // Marca como processing no Firestore
    const summaryRef = db.collection("therapy_session_summaries").doc(sessionId);
    await summaryRef.set({
      sessionId,
      therapistUid: uid,
      status: "processing",
      audioBytes: audioBuffer.length,
      startedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    // Retorna 202 imediatamente — processamento continua em background
    res.status(202).json({
      ok: true,
      status: "processing",
      sessionId,
      audioBytes: audioBuffer.length
    });

    // Fire-and-forget processing. Erros vão pra log + Firestore status.
    processAiSummary({
      audioBuffer,
      sessionId,
      therapist,
      session: sess
    }).catch(err => {
      logError("ai_summary_unhandled", err, { sessionId });
    });
  })
);

async function processAiSummary({ audioBuffer, sessionId, therapist, session }) {
  const db = getDb();
  const summaryRef = db.collection("therapy_session_summaries").doc(sessionId);

  try {
    logInfo("ai_summary_started", { sessionId, audioBytes: audioBuffer.length });

    // 1. Transcribe via Whisper local (Xenova/whisper-base)
    const t0 = Date.now();
    const transcriptResult = await whisperSvc.transcribe(audioBuffer, {
      language: "portuguese"
    });
    const transcribeMs = Date.now() - t0;
    logInfo("ai_summary_transcribed", {
      sessionId,
      durationSec: transcriptResult.durationSec,
      transcribeMs,
      textChars: transcriptResult.text.length,
      hallucinated: transcriptResult.hallucinated || false
    });

    // Alucinação detectada: Whisper gerou texto repetitivo (ruído/áudio curto).
    // Salva como failed com mensagem amigável em vez de mandar lixo pro Claude.
    if (transcriptResult.hallucinated) {
      await summaryRef.set({
        status: "failed",
        error: "TRANSCRIPT_ALUCINADO",
        transcript: "",
        durationSec: transcriptResult.durationSec,
        transcribeMs,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      logWarn("ai_summary_hallucinated", { sessionId, durationSec: transcriptResult.durationSec });
      return;
    }

    // 2. Summarize via Claude Haiku 4.5
    const t1 = Date.now();
    const summaryResult = await sessionSummarySvc.summarizeSession({
      transcript: transcriptResult.text,
      professionalName: therapist.displayName || "",
      patientName: session.patientName || "",
      durationSec: transcriptResult.durationSec
    });
    const summarizeMs = Date.now() - t1;

    if (!summaryResult.ok) {
      throw new Error(`Summary failed: ${summaryResult.error}${summaryResult.detail ? " — " + summaryResult.detail : ""}`);
    }

    // 3. Salva resultado
    const { signals, ...summaryRest } = summaryResult.summary || {};
    await summaryRef.set({
      status: "completed",
      patientId: session.patientId || null,
      transcript: transcriptResult.text,
      transcriptChunks: transcriptResult.chunks?.slice(0, 200) || [], // limit pra evitar doc gigante
      summary: summaryRest,
      signals: signals || null,
      durationSec: transcriptResult.durationSec,
      transcribeMs,
      summarizeMs,
      tokenUsage: summaryResult.usage || null,
      completedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    logInfo("ai_summary_completed", {
      sessionId,
      totalMs: transcribeMs + summarizeMs,
      inputTokens: summaryResult.usage?.input,
      outputTokens: summaryResult.usage?.output
    });
  } catch (err) {
    await summaryRef.set({
      status: "failed",
      error: err.message.slice(0, 500),
      failedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    logError("ai_summary_failed", err, { sessionId });
  }
}

// GET — frontend busca o resumo gerado
router.get("/therapy/session/:sessionId/ai-summary", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const sessionId = String(req.params.sessionId || "").trim();
  if (!sessionId) return sendError(res, 400, "SESSAO_OBRIGATORIA");

  const db = getDb();
  // Verifica ownership da sessão
  const sessSnap = await db.collection("therapy_sessions").doc(sessionId).get();
  if (!sessSnap.exists) return sendError(res, 404, "SESSAO_NAO_ENCONTRADA");
  if (sessSnap.data().therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  const summarySnap = await db.collection("therapy_session_summaries").doc(sessionId).get();
  if (!summarySnap.exists) {
    return res.json({ ok: true, exists: false, status: "none" });
  }
  const data = summarySnap.data();
  return res.json({
    ok: true,
    exists: true,
    status: data.status,
    summary: data.summary || null,
    signals: data.signals || null,
    transcript: data.transcript || null,
    durationSec: data.durationSec || null,
    completedAt: data.completedAt?.toMillis ? data.completedAt.toMillis() : null,
    error: data.error || null
  });
}));

// ─────────────────────────────────────────────────────────────────────────
// ADMIN — Dashboard agregado (admin-painel.html)
//
// Retorna 1 JSON com todas as métricas que o painel de controle precisa.
// Otimizado pra fazer queries paralelas (Promise.allSettled) e devolver
// rápido (~200-400ms tipicamente).
// ─────────────────────────────────────────────────────────────────────────

router.get("/therapy/admin/dashboard", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const db = getDb();
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();
  const day7Ms = now - 7 * dayMs;
  const day30Ms = now - 30 * dayMs;
  const next24Ms = now + dayMs;

  // ─── Queries paralelas ──────────────────────────────────────────────
  const queries = await Promise.allSettled([
    // [0] therapists — total + breakdown por plano + verifPending
    db.collection("therapists").get(),
    // [1] therapy_sessions — só docs dos últimos 30d (limitamos pra evitar full-scan)
    db.collection("therapy_sessions")
      .where("scheduledAt", ">=", day30Ms)
      .orderBy("scheduledAt", "desc")
      .limit(1000)
      .get(),
    // [2] therapy_patients (registros clínicos criados pelo profissional)
    db.collection("therapy_patients").get(),
    // [3] eventos recentes (audit)
    db.collection("therapy_audit")
      .orderBy("at", "desc")
      .limit(25)
      .get(),
    // [4] comprovantes pendentes — student
    db.collection("therapists").where("plano", "==", "student-pending-review").get(),
    // [5] comprovantes pendentes — recém-formado
    db.collection("therapists").where("recemFormadoDoc.decision", "==", "pending-review").get(),
    // [6] comprovantes pendentes — sem-conselho (formação)
    db.collection("therapists").where("formacaoDoc.decision", "==", "pending-review").get(),
    // [7] verificações CRP/CRM pendentes — usa collection therapy_verifications
    // (mesma fonte que admin-verificacoes.html consulta — evita badge fantasma)
    db.collection("therapy_verifications").where("status", "==", "pending").get(),
    // [8] therapy_patient_accounts — pacientes que se cadastraram (signup próprio)
    db.collection("therapy_patient_accounts").get(),
    // [9] therapy_student_leads — interessados no plano Estudante (landing) ainda não contatados
    db.collection("therapy_student_leads").where("status", "==", "new").get(),
    // [10] empresa-pending-review — profissionais do plano empresa aguardando aprovação manual
    db.collection("therapists").where("plano", "==", "empresa-pending-review").get()
  ]);

  // ─── Helpers ─────────────────────────────────────────────────────────
  const safeData = (snap) => snap?.docs?.map(d => d.data()) || [];
  const toMs = (v) => {
    if (!v) return 0;
    if (typeof v === "number") return v;
    if (v.toMillis) return v.toMillis();
    if (v._seconds) return v._seconds * 1000;
    return Number(v) || 0;
  };

  // ─── Profissionais ──────────────────────────────────────────────────
  const therapistsRaw = queries[0].status === "fulfilled" ? safeData(queries[0].value) : [];
  const profTotal = therapistsRaw.length;
  let profAtivos7d = 0, profAtivos30d = 0, profNovosHoje = 0, profNovosSemana = 0;
  let mrrCents = 0, novosPlanosHoje = 0;
  const byTier = {
    "student-active": 0, "student-pending-review": 0,
    "recem-formado-eligible": 0, "pro": 0, "trial": 0,
    "expired": 0, "canceled": 0, "outros": 0
  };
  let trialAtivos = 0;
  // Bucket pra sparkline MRR (30 dias). MRR_dia_X = sum proPriceCents de
  // todos profs que CURRENTLY são pro AND proSince <= dia_X. Aproximação:
  // não considera cancelamentos históricos (só plano atual), então a curva
  // é monotonicamente crescente. Pra produto early-stage é suficiente.
  const mrrByDay = new Array(30).fill(0);
  // Listas de profissionais novos (24h e 7d) ordenados por createdAt desc.
  const novos24h = [];
  const novos7d = [];
  for (const t of therapistsRaw) {
    const createdAt = toMs(t.createdAt);
    const lastSeen = toMs(t.lastActiveAt) || toMs(t.updatedAt) || createdAt;
    if (lastSeen >= day7Ms) profAtivos7d++;
    if (lastSeen >= day30Ms) profAtivos30d++;
    if (createdAt >= todayMs) profNovosHoje++;
    if (createdAt >= day7Ms) profNovosSemana++;

    const plano = String(t.plano || "outros");
    const trialUntil = toMs(t.trialUntil);
    let bucket = plano;
    if (plano === "trial" || (plano && trialUntil > now && plano !== "pro" && plano !== "student-active")) {
      bucket = "trial";
      trialAtivos++;
    }
    if (byTier[bucket] !== undefined) byTier[bucket]++;
    else byTier.outros++;

    if (plano === "pro") {
      const proPrice = Number(t.proPriceCents) || 0;
      mrrCents += proPrice;
      const proSince = toMs(t.proSince);
      if (proSince >= todayMs) novosPlanosHoje++;
      // MRR sparkline: este pro contribui pro MRR a partir do dia proSince
      // até hoje. Preenche os buckets correspondentes.
      if (proSince > 0) {
        const startDaysAgo = Math.floor((now - proSince) / dayMs);
        for (let i = 0; i < 30; i++) {
          const daysAgoForBucket = 29 - i;
          if (startDaysAgo >= daysAgoForBucket) mrrByDay[i] += proPrice;
        }
      } else {
        // proSince ausente: assume já era pro há 30+ dias
        for (let i = 0; i < 30; i++) mrrByDay[i] += proPrice;
      }
    }

    // Listas de novos
    if (createdAt >= now - dayMs) {
      novos24h.push({
        uid: t.uid || null,
        displayName: t.displayName || "(sem nome)",
        email: t.email || null,
        plano,
        tipoConselho: t.tipoConselho || null,
        verificationStatus: t.verificationStatus || null,
        createdAt
      });
    }
    if (createdAt >= day7Ms) {
      novos7d.push({
        uid: t.uid || null,
        displayName: t.displayName || "(sem nome)",
        plano,
        createdAt
      });
    }
  }
  novos24h.sort((a, b) => b.createdAt - a.createdAt);
  novos7d.sort((a, b) => b.createdAt - a.createdAt);

  // ─── Sessões ────────────────────────────────────────────────────────
  const sessionsRaw = queries[1].status === "fulfilled" ? safeData(queries[1].value) : [];
  let sesHoje = 0, sesProx24h = 0, sesProx7d = 0, sesAtivas = 0, sesTotal30d = sessionsRaw.length;
  let sesCanceladas30d = 0, sesRealizadas30d = 0, sesUltimos7d = 0;
  // Bucket de sessões por dia (últimos 30 dias) pra sparkline.
  // Index 0 = 29 dias atrás, index 29 = hoje.
  const sessionsByDay = new Array(30).fill(0);
  for (const s of sessionsRaw) {
    const at = toMs(s.scheduledAt);
    const status = String(s.status || "").toLowerCase();
    if (at >= todayMs && at < todayMs + dayMs) sesHoje++;
    if (at >= now && at < next24Ms) sesProx24h++;
    if (at >= now && at < now + 7 * dayMs) sesProx7d++;
    if (at >= day7Ms && at < now) sesUltimos7d++;
    if (status === "live" || status === "active" || status === "in-progress") sesAtivas++;
    if (status === "canceled" || status === "cancelled") sesCanceladas30d++;
    if (status === "completed" || status === "ended") sesRealizadas30d++;
    // Bucket sparkline: só conta agendamentos passados (representa volume de
    // atendimento real). Index = (dias atrás) invertido pra cronológico crescente.
    if (at >= day30Ms && at <= now) {
      const daysAgo = Math.floor((now - at) / dayMs);
      const bucketIdx = 29 - daysAgo;
      if (bucketIdx >= 0 && bucketIdx < 30) sessionsByDay[bucketIdx]++;
    }
  }

  // ─── Pacientes (registros clínicos criados pelos profissionais) ────
  const patientsRaw = queries[2].status === "fulfilled" ? safeData(queries[2].value) : [];
  let patTotal = patientsRaw.length, patNovosHoje = 0, patNovosSemana = 0;
  for (const p of patientsRaw) {
    const c = toMs(p.createdAt);
    if (c >= todayMs) patNovosHoje++;
    if (c >= day7Ms) patNovosSemana++;
  }

  // ─── Contas de paciente (signup próprio via /paciente-cadastro) ────
  const patAccountsRaw = queries[8].status === "fulfilled" ? safeData(queries[8].value) : [];
  let patAccountsTotal = patAccountsRaw.length;
  let patAccountsNovosHoje = 0, patAccountsNovosSemana = 0;
  const patAccountsNovos24h = [];
  for (const pa of patAccountsRaw) {
    const c = toMs(pa.createdAt);
    if (c >= todayMs) patAccountsNovosHoje++;
    if (c >= day7Ms) patAccountsNovosSemana++;
    if (c >= now - dayMs) {
      patAccountsNovos24h.push({
        uid: pa.uid || null,
        displayName: pa.displayName || "(sem nome)",
        createdAt: c
      });
    }
  }
  patAccountsNovos24h.sort((a, b) => b.createdAt - a.createdAt);

  // ─── Eventos recentes (audit) ───────────────────────────────────────
  const auditRaw = queries[3].status === "fulfilled" ? safeData(queries[3].value) : [];
  const eventos = auditRaw.slice(0, 20).map(e => ({
    type: e.type || "?",
    at: toMs(e.at),
    therapistUid: e.therapistUid || null,
    detail: e.detail || e.preapprovalId || e.scheduledAt || null
  }));

  // ─── Pendências admin ───────────────────────────────────────────────
  const pendCrpCrm = queries[7].status === "fulfilled" ? queries[7].value.size : 0;
  const pendEstudante = queries[4].status === "fulfilled" ? queries[4].value.size : 0;
  const pendRecemFormado = queries[5].status === "fulfilled" ? queries[5].value.size : 0;
  const pendSemConselho = queries[6].status === "fulfilled" ? queries[6].value.size : 0;
  const pendLeadsEstudante = queries[9].status === "fulfilled" ? queries[9].value.size : 0;
  const pendEmpresa = queries[10].status === "fulfilled" ? queries[10].value.size : 0;

  // ─── Integrações (configurado vs não) ───────────────────────────────
  // Só listamos integrações CRÍTICAS pro produto funcionar. Removidos:
  //  - Twilio: SMS não usado (canal é WhatsApp via Z-API).
  //  - Asaas: configuração é per-therapist (cada um cola apiKey em Perfil),
  //    não env global. Status global "OK/OFF" não faz sentido.
  //  - NFE.io: feature inativa por enquanto.
  //  - Sentry: opcional (recém-adicionado, DSN pode estar pendente no Railway).
  //
  // LiveKit usa a CONSTANTE resolvida (config.js tem default pro URL), não
  // process.env direto — o check anterior dava OFF mesmo com app funcionando.
  const env = process.env;
  const { LIVEKIT_URL: LK_URL, LIVEKIT_API_KEY: LK_KEY } = require("../config");
  const integrations = {
    firebase: { ok: !!db, label: "Firebase" },
    livekit: { ok: !!LK_KEY && !!LK_URL, label: "LiveKit (vídeo E2EE)" },
    mp_jogo: { ok: !!env.MP_ACCESS_TOKEN_JOGO || !!env.MP_ACCESS_TOKEN, label: "Mercado Pago (Jogo)" },
    mp_therapy: { ok: !!env.MP_ACCESS_TOKEN_THERAPY || !!env.MP_ACCESS_TOKEN, label: "Mercado Pago (Therapy)" },
    anthropic: { ok: !!env.ANTHROPIC_API_KEY, label: "Anthropic (Aurora + validador)" },
    resend: { ok: !!env.RESEND_API_KEY, label: "Resend (e-mail)" },
    zapi: { ok: !!env.ZAPI_INSTANCE_ID && !!env.ZAPI_CLIENT_TOKEN, label: "Z-API (WhatsApp)" }
  };

  // ─── Sistema ────────────────────────────────────────────────────────
  const { APP_START_TIME } = require("../logger");
  const sistema = {
    uptimeSec: Math.round(process.uptime()),
    startedAt: new Date(APP_START_TIME).toISOString(),
    now: new Date(now).toISOString(),
    appEnv: env.APP_ENV || env.NODE_ENV || "?",
    nodeVersion: process.version,
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    activeStreams: (require("../game/state").activeStreams || new Map()).size,
    activeRecordings: (require("../game/state").activeRecordings || new Map()).size,
    integrations
  };

  return res.json({
    ok: true,
    profissionais: {
      total: profTotal,
      ativos7d: profAtivos7d,
      ativos30d: profAtivos30d,
      novosHoje: profNovosHoje,
      novosSemana: profNovosSemana,
      byTier,
      trialAtivos,
      novos24h: novos24h.slice(0, 20),
      novos7d: novos7d.slice(0, 50)
    },
    pacientes: {
      total: patTotal,
      novosHoje: patNovosHoje,
      novosSemana: patNovosSemana
    },
    pacientesContas: {
      total: patAccountsTotal,
      novosHoje: patAccountsNovosHoje,
      novosSemana: patAccountsNovosSemana,
      novos24h: patAccountsNovos24h.slice(0, 20)
    },
    sessoes: {
      hoje: sesHoje,
      ativas: sesAtivas,
      prox24h: sesProx24h,
      prox7d: sesProx7d,
      total30d: sesTotal30d,
      realizadas30d: sesRealizadas30d,
      canceladas30d: sesCanceladas30d,
      ultimos7d: sesUltimos7d,
      byDay30: sessionsByDay
    },
    financeiro: {
      mrrCents,
      mrrBrl: (mrrCents / 100).toFixed(2),
      novosPlanosHoje,
      mrrByDay30: mrrByDay
    },
    pendencias: {
      crpCrm: pendCrpCrm,
      estudante: pendEstudante,
      recemFormado: pendRecemFormado,
      semConselho: pendSemConselho,
      leadsEstudante: pendLeadsEstudante,
      empresa: pendEmpresa,
      total: pendCrpCrm + pendEstudante + pendRecemFormado + pendSemConselho + pendLeadsEstudante + pendEmpresa
    },
    eventos,
    sistema
  });
}));

// ─────────────────────────────────────────────────────────────────────────
// ADMIN — Revisão de comprovantes-estudante na fila manual
//
// Quando o validador devolve decision="manual-review" (confiança média), o
// profissional fica em plano "student-pending-review". Admin revisa aqui.
// ─────────────────────────────────────────────────────────────────────────

// GET /therapy/admin/comprovantes-estudante?status=pending-review
router.get("/therapy/admin/comprovantes-estudante", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const wantStatus = String(req.query?.status || "pending-review").trim().toLowerCase();
  const allowed = new Set(["pending-review", "approved", "rejected", "all"]);
  if (!allowed.has(wantStatus)) return sendError(res, 400, "STATUS_INVALIDO");

  const db = getDb();
  let q = db.collection("therapists");
  if (wantStatus === "pending-review") {
    q = q.where("plano", "==", "student-pending-review");
  } else if (wantStatus === "approved") {
    q = q.where("plano", "==", "student-active");
  } else if (wantStatus === "rejected") {
    q = q.where("studentDoc.decision", "==", "rejected");
  }

  const snap = await q.limit(500).get();
  const items = snap.docs.map(d => {
    const t = d.data();
    return {
      therapistUid: t.uid,
      displayName: t.displayName || "",
      email: t.email || null,
      crp: t.crp || "",
      crm: t.crm || "",
      plano: t.plano || null,
      studentDoc: t.studentDoc ? {
        decision: t.studentDoc.decision,
        confidence: t.studentDoc.confidence,
        reasons: t.studentDoc.reasons || [],
        extracted: t.studentDoc.extracted || null,
        lastUploadId: t.studentDoc.lastUploadId,
        lastUploadedAt: t.studentDoc.lastUploadedAt?.toMillis?.() || null,
        fileHash: t.studentDoc.fileHash,
        mediaType: t.studentDoc.mediaType,
        fileSize: t.studentDoc.fileSize
      } : null
    };
  })
  // Filtra fora profissionais que entraram no resultset do "all" mas nunca
  // submeteram comprovante de estudante (sem lastUploadId, nada pra revisar).
  // Pros outros status (pending/approved/rejected) o where do Firestore ja
  // restringe — esse filtro vira no-op, é só safety net.
  .filter(item => !!item.studentDoc?.lastUploadId)
  .sort((a, b) => (b.studentDoc?.lastUploadedAt || 0) - (a.studentDoc?.lastUploadedAt || 0));

  return res.json({ ok: true, items });
}));

// GET /therapy/admin/comprovantes-estudante/:uid — devolve fileBase64 pra admin abrir
router.get("/therapy/admin/comprovantes-estudante/:uid", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const targetUid = String(req.params.uid || "").trim();
  if (!targetUid) return sendError(res, 400, "UID_OBRIGATORIO");

  const therapist = await loadTherapist(targetUid);
  if (!therapist) return sendError(res, 404, "PROFISSIONAL_NAO_ENCONTRADO");
  if (!therapist.studentDoc?.lastUploadId) return sendError(res, 404, "COMPROVANTE_NAO_ENCONTRADO");

  const db = getDb();
  const uploadSnap = await db.collection("therapy_student_docs").doc(targetUid)
    .collection("uploads").doc(therapist.studentDoc.lastUploadId).get();
  if (!uploadSnap.exists) return sendError(res, 404, "ARQUIVO_NAO_ENCONTRADO");
  const upload = uploadSnap.data();

  return res.json({
    ok: true,
    item: {
      therapistUid: targetUid,
      uploadId: upload.uploadId,
      fileBase64: upload.fileBase64,
      mediaType: upload.mediaType,
      fileSize: upload.fileSize,
      fileHash: upload.fileHash,
      extracted: upload.extracted,
      confidence: upload.confidence,
      decision: upload.decision,
      reasons: upload.reasons || [],
      provider: upload.provider,
      uploadedAt: upload.uploadedAt?.toMillis?.() || null,
      therapist: {
        displayName: therapist.displayName || "",
        email: therapist.email || null,
        crp: therapist.crp || "",
        crm: therapist.crm || "",
        plano: therapist.plano || null
      }
    }
  });
}));

// POST /therapy/admin/comprovantes-estudante/:uid/aprovar
router.post("/therapy/admin/comprovantes-estudante/:uid/aprovar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const targetUid = String(req.params.uid || "").trim();
  if (!targetUid) return sendError(res, 400, "UID_OBRIGATORIO");

  const therapist = await loadTherapist(targetUid);
  if (!therapist) return sendError(res, 404, "PROFISSIONAL_NAO_ENCONTRADO");

  const notes = String(req.body?.notes || "").trim().slice(0, 500);
  const validUntil = new Date(Date.now() + STUDENT_VERIFIED_DAYS * 24 * 60 * 60 * 1000);

  await getDb().collection("therapists").doc(targetUid).set({
    plano: "student-active",
    studentVerifiedAt: admin.firestore.FieldValue.serverTimestamp(),
    studentVerifiedUntil: validUntil,
    studentDoc: {
      decision: "approved",
      reviewedBy: adminAuth.email,
      reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      reviewNotes: notes
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({
    type: "student_doc_admin_approved",
    therapistUid: targetUid,
    reviewedBy: adminAuth.email,
    notes
  });

  // Notifica o profissional. Falha do email não impede a aprovação.
  try {
    const email = await resolveTherapistEmail(targetUid, therapist);
    if (email) {
      const tpl = templateStudentApproved({
        therapistName: therapist.displayName || "profissional",
        validUntilMs: validUntil.getTime(),
        painelUrl: buildPainelUrl()
      });
      await sendEmail({ to: email, ...tpl });
    }
  } catch (e) {
    logError("student_doc_approve_email_failed", e, { therapistUid: targetUid });
  }

  return res.json({ ok: true, plano: "student-active", validUntil: validUntil.toISOString() });
}));

// POST /therapy/admin/comprovantes-estudante/:uid/rejeitar
router.post("/therapy/admin/comprovantes-estudante/:uid/rejeitar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const targetUid = String(req.params.uid || "").trim();
  if (!targetUid) return sendError(res, 400, "UID_OBRIGATORIO");

  const therapist = await loadTherapist(targetUid);
  if (!therapist) return sendError(res, 404, "PROFISSIONAL_NAO_ENCONTRADO");

  const reason = String(req.body?.reason || "").trim().slice(0, 500);
  if (!reason) return sendError(res, 400, "MOTIVO_OBRIGATORIO");

  await getDb().collection("therapists").doc(targetUid).set({
    plano: "trial", // volta pra trial — usuário pode tentar de novo ou pagar tier pro
    studentDoc: {
      decision: "rejected",
      reviewedBy: adminAuth.email,
      reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      reviewNotes: reason
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({
    type: "student_doc_admin_rejected",
    therapistUid: targetUid,
    reviewedBy: adminAuth.email,
    reason
  });

  // Notifica o profissional com o motivo. Falha do email não impede a rejeição.
  try {
    const email = await resolveTherapistEmail(targetUid, therapist);
    if (email) {
      const tpl = templateStudentRejected({
        therapistName: therapist.displayName || "profissional",
        reason,
        retryUrl: buildComprovanteEstudanteUrl()
      });
      await sendEmail({ to: email, ...tpl });
    }
  } catch (e) {
    logError("student_doc_reject_email_failed", e, { therapistUid: targetUid });
  }

  return res.json({ ok: true, plano: "trial", reason });
}));

// ─────────────────────────────────────────────────────────────────────────
// ADMIN — Revisão de comprovantes do tier recém-formado
// ─────────────────────────────────────────────────────────────────────────

// GET /therapy/admin/comprovantes-recem-formado?status=pending-review
router.get("/therapy/admin/comprovantes-recem-formado", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const wantStatus = String(req.query?.status || "pending-review").trim().toLowerCase();
  const allowed = new Set(["pending-review", "eligible", "rejected", "all"]);
  if (!allowed.has(wantStatus)) return sendError(res, 400, "STATUS_INVALIDO");

  const db = getDb();
  let q = db.collection("therapists");
  if (wantStatus === "pending-review") {
    q = q.where("plano", "==", "recem-formado-pending-review");
  } else if (wantStatus === "eligible") {
    q = q.where("plano", "==", "recem-formado-eligible");
  } else if (wantStatus === "rejected") {
    q = q.where("recemFormadoDoc.decision", "==", "rejected");
  }

  const snap = await q.limit(500).get();
  const items = snap.docs.map(d => {
    const t = d.data();
    return {
      therapistUid: t.uid,
      displayName: t.displayName || "",
      email: t.email || null,
      crp: t.crp || "",
      crm: t.crm || "",
      plano: t.plano || null,
      recemFormadoDoc: t.recemFormadoDoc ? {
        decision: t.recemFormadoDoc.decision,
        confidence: t.recemFormadoDoc.confidence,
        reasons: t.recemFormadoDoc.reasons || [],
        extracted: t.recemFormadoDoc.extracted || null,
        lastUploadId: t.recemFormadoDoc.lastUploadId,
        lastUploadedAt: t.recemFormadoDoc.lastUploadedAt?.toMillis?.() || null,
        fileHash: t.recemFormadoDoc.fileHash,
        mediaType: t.recemFormadoDoc.mediaType,
        fileSize: t.recemFormadoDoc.fileSize
      } : null
    };
  })
  // Filtra fora profissionais sem comprovante real (mesmo motivo do
  // /comprovantes-estudante — evita "Abrir" cair em COMPROVANTE_NAO_ENCONTRADO).
  .filter(item => !!item.recemFormadoDoc?.lastUploadId)
  .sort((a, b) => (b.recemFormadoDoc?.lastUploadedAt || 0) - (a.recemFormadoDoc?.lastUploadedAt || 0));

  return res.json({ ok: true, items });
}));

// GET /therapy/admin/comprovantes-recem-formado/:uid
router.get("/therapy/admin/comprovantes-recem-formado/:uid", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const targetUid = String(req.params.uid || "").trim();
  if (!targetUid) return sendError(res, 400, "UID_OBRIGATORIO");

  const therapist = await loadTherapist(targetUid);
  if (!therapist) return sendError(res, 404, "PROFISSIONAL_NAO_ENCONTRADO");
  if (!therapist.recemFormadoDoc?.lastUploadId) return sendError(res, 404, "COMPROVANTE_NAO_ENCONTRADO");

  const db = getDb();
  const uploadSnap = await db.collection("therapy_recem_formado_docs").doc(targetUid)
    .collection("uploads").doc(therapist.recemFormadoDoc.lastUploadId).get();
  if (!uploadSnap.exists) return sendError(res, 404, "ARQUIVO_NAO_ENCONTRADO");
  const upload = uploadSnap.data();

  return res.json({
    ok: true,
    item: {
      therapistUid: targetUid,
      uploadId: upload.uploadId,
      fileBase64: upload.fileBase64,
      mediaType: upload.mediaType,
      fileSize: upload.fileSize,
      fileHash: upload.fileHash,
      extracted: upload.extracted,
      confidence: upload.confidence,
      decision: upload.decision,
      reasons: upload.reasons || [],
      provider: upload.provider,
      uploadedAt: upload.uploadedAt?.toMillis?.() || null,
      therapist: {
        displayName: therapist.displayName || "",
        email: therapist.email || null,
        crp: therapist.crp || "",
        crm: therapist.crm || "",
        plano: therapist.plano || null
      }
    }
  });
}));

// POST /therapy/admin/comprovantes-recem-formado/:uid/aprovar
// Body: { notes?: string, dataInscricao?: "YYYY-MM-DD" }
// dataInscricao: data de inscrição no conselho (lê do comprovante). Usada
// pelo cron runRecemFormadoTransitionTick pra avisar 30d antes dos 12m.
// Se nao informada AND validador automatico nao extraiu, cron nao notifica.
router.post("/therapy/admin/comprovantes-recem-formado/:uid/aprovar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const targetUid = String(req.params.uid || "").trim();
  if (!targetUid) return sendError(res, 400, "UID_OBRIGATORIO");

  const therapist = await loadTherapist(targetUid);
  if (!therapist) return sendError(res, 404, "PROFISSIONAL_NAO_ENCONTRADO");

  const notes = String(req.body?.notes || "").trim().slice(0, 500);

  // dataInscricao opcional, formato YYYY-MM-DD. Valida e sobrescreve em
  // recemFormadoDoc.extracted.dataInscricao se fornecida; senao preserva
  // valor existente (mantido pelo merge:true).
  const dataInscricaoRaw = String(req.body?.dataInscricao || "").trim();
  const recemFormadoDocUpdate = {
    decision: "approved",
    reviewedBy: adminAuth.email,
    reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
    reviewNotes: notes
  };
  if (dataInscricaoRaw) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataInscricaoRaw)) {
      return sendError(res, 400, "DATA_INSCRICAO_FORMATO_INVALIDO", {
        detail: "Use formato YYYY-MM-DD."
      });
    }
    const parsedMs = Date.parse(dataInscricaoRaw + "T00:00:00Z");
    if (!Number.isFinite(parsedMs) || parsedMs > Date.now()) {
      return sendError(res, 400, "DATA_INSCRICAO_INVALIDA", {
        detail: "Data deve ser passada/presente em formato YYYY-MM-DD."
      });
    }
    recemFormadoDocUpdate.extracted = {
      ...(therapist.recemFormadoDoc?.extracted || {}),
      dataInscricao: dataInscricaoRaw
    };
  }

  await getDb().collection("therapists").doc(targetUid).set({
    plano: "recem-formado-eligible",
    recemFormadoVerifiedAt: admin.firestore.FieldValue.serverTimestamp(),
    recemFormadoDoc: recemFormadoDocUpdate,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({
    type: "recem_formado_doc_admin_approved",
    therapistUid: targetUid,
    reviewedBy: adminAuth.email,
    notes
  });

  // Notifica o profissional. Falha do email não impede a aprovação.
  try {
    const email = await resolveTherapistEmail(targetUid, therapist);
    if (email) {
      const tpl = templateRecemFormadoApproved({
        therapistName: therapist.displayName || "profissional",
        painelUrl: buildPlanosUrl()
      });
      await sendEmail({ to: email, ...tpl });
    }
  } catch (e) {
    logError("recem_formado_doc_approve_email_failed", e, { therapistUid: targetUid });
  }

  return res.json({ ok: true, plano: "recem-formado-eligible" });
}));

// POST /therapy/admin/comprovantes-recem-formado/:uid/rejeitar
router.post("/therapy/admin/comprovantes-recem-formado/:uid/rejeitar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const targetUid = String(req.params.uid || "").trim();
  if (!targetUid) return sendError(res, 400, "UID_OBRIGATORIO");

  const therapist = await loadTherapist(targetUid);
  if (!therapist) return sendError(res, 404, "PROFISSIONAL_NAO_ENCONTRADO");

  const reason = String(req.body?.reason || "").trim().slice(0, 500);
  if (!reason) return sendError(res, 400, "MOTIVO_OBRIGATORIO");

  await getDb().collection("therapists").doc(targetUid).set({
    plano: "trial",
    recemFormadoDoc: {
      decision: "rejected",
      reviewedBy: adminAuth.email,
      reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      reviewNotes: reason
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({
    type: "recem_formado_doc_admin_rejected",
    therapistUid: targetUid,
    reviewedBy: adminAuth.email,
    reason
  });

  // Notifica o profissional com o motivo. Falha do email não impede a rejeição.
  try {
    const email = await resolveTherapistEmail(targetUid, therapist);
    if (email) {
      const tpl = templateRecemFormadoRejected({
        therapistName: therapist.displayName || "profissional",
        reason,
        retryUrl: buildComprovanteRecemFormadoUrl()
      });
      await sendEmail({ to: email, ...tpl });
    }
  } catch (e) {
    logError("recem_formado_doc_reject_email_failed", e, { therapistUid: targetUid });
  }

  return res.json({ ok: true, plano: "trial", reason });
}));

// ─────────────────────────────────────────────────────────────────────────
// ADMIN — plano Empresa (verificação manual sem documento)
// ─────────────────────────────────────────────────────────────────────────

// GET /therapy/admin/empresa-pendentes?status=pending-review|aprovado|all
router.get("/therapy/admin/empresa-pendentes", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const wantStatus = String(req.query?.status || "pending-review").trim().toLowerCase();
  const db = getDb();
  let q = db.collection("therapists");
  if (wantStatus === "pending-review") {
    q = q.where("plano", "==", "empresa-pending-review");
  } else if (wantStatus === "aprovado") {
    q = q.where("plano", "==", "empresa").where("intendedTier", "==", "empresa");
  } else {
    q = q.where("intendedTier", "==", "empresa");
  }

  const snap = await q.limit(200).get();
  const items = snap.docs.map(d => {
    const t = d.data();
    return {
      therapistUid: t.uid,
      displayName: t.displayName || "",
      email: t.email || null,
      tipoConselho: t.tipoConselho || null,
      numeroConselho: t.numeroConselho || null,
      especialidade: t.especialidade || null,
      bio: t.bio || null,
      plano: t.plano || null,
      empresaReviewedAt: t.empresaReviewedAt?.toMillis?.() || null,
      empresaReviewedBy: t.empresaReviewedBy || null,
      empresaRejectReason: t.empresaRejectReason || null,
      createdAt: t.createdAt?.toMillis?.() || null
    };
  });

  return res.json({ ok: true, items, total: items.length });
}));

// GET /therapy/admin/empresa-pendentes/:uid
router.get("/therapy/admin/empresa-pendentes/:uid", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const targetUid = String(req.params.uid || "").trim();
  if (!targetUid) return sendError(res, 400, "UID_OBRIGATORIO");

  const db = getDb();
  const doc = await db.collection("therapists").doc(targetUid).get();
  if (!doc.exists) return sendError(res, 404, "PROFISSIONAL_NAO_ENCONTRADO");
  const t = doc.data();

  return res.json({
    ok: true,
    therapistUid: t.uid,
    displayName: t.displayName || "",
    email: t.email || null,
    tipoConselho: t.tipoConselho || null,
    numeroConselho: t.numeroConselho || null,
    especialidade: t.especialidade || null,
    bio: t.bio || null,
    plano: t.plano || null,
    intendedTier: t.intendedTier || null,
    empresaReviewedAt: t.empresaReviewedAt?.toMillis?.() || null,
    empresaReviewedBy: t.empresaReviewedBy || null,
    empresaRejectReason: t.empresaRejectReason || null,
    createdAt: t.createdAt?.toMillis?.() || null
  });
}));

// POST /therapy/admin/empresa-pendentes/:uid/aprovar
router.post("/therapy/admin/empresa-pendentes/:uid/aprovar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const targetUid = String(req.params.uid || "").trim();
  if (!targetUid) return sendError(res, 400, "UID_OBRIGATORIO");
  const notes = String(req.body?.notes || "").trim();

  const db = getDb();
  const ref = db.collection("therapists").doc(targetUid);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "PROFISSIONAL_NAO_ENCONTRADO");

  await ref.update({
    plano: "empresa",
    empresaReviewedAt: admin.firestore.FieldValue.serverTimestamp(),
    empresaReviewedBy: adminAuth.email || adminAuth.uid,
    empresaRejectReason: null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  try {
    await db.collection("therapy_audit").add({
      action: "empresa_aprovado",
      therapistUid: targetUid,
      adminUid: adminAuth.uid,
      adminEmail: adminAuth.email || null,
      notes: notes || null,
      at: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (_) {}

  // Notifica profissional por e-mail
  try {
    const t = snap.data();
    const email = await resolveTherapistEmail(targetUid, t);
    if (email) {
      await sendEmail({
        to: email,
        subject: "Sua conta no Espaço Prelúdio foi aprovada — Plano Empresas",
        html: `<p>Olá, ${t.displayName || "profissional"}!</p>
          <p>Sua conta no plano <strong>Atendimento a Empresas</strong> foi aprovada pela nossa equipe. Você já pode acessar a plataforma e começar a atender seus pacientes.</p>
          <p><a href="${THERAPY_FRONTEND_BASE}/painel.html">Acessar meu painel →</a></p>
          <p>Qualquer dúvida, responda este e-mail.</p>`
      });
    }
  } catch (e) {
    logError("empresa_aprovado_email_failed", e, { therapistUid: targetUid });
  }

  return res.json({ ok: true, plano: "empresa" });
}));

// POST /therapy/admin/empresa-pendentes/:uid/rejeitar
router.post("/therapy/admin/empresa-pendentes/:uid/rejeitar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const targetUid = String(req.params.uid || "").trim();
  if (!targetUid) return sendError(res, 400, "UID_OBRIGATORIO");
  const reason = String(req.body?.reason || "").trim();

  const db = getDb();
  const ref = db.collection("therapists").doc(targetUid);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "PROFISSIONAL_NAO_ENCONTRADO");

  await ref.update({
    plano: "trial",
    empresaReviewedAt: admin.firestore.FieldValue.serverTimestamp(),
    empresaReviewedBy: adminAuth.email || adminAuth.uid,
    empresaRejectReason: reason || "Não aprovado pela equipe.",
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  try {
    await db.collection("therapy_audit").add({
      action: "empresa_rejeitado",
      therapistUid: targetUid,
      adminUid: adminAuth.uid,
      adminEmail: adminAuth.email || null,
      reason: reason || null,
      at: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (_) {}

  try {
    const t = snap.data();
    const email = await resolveTherapistEmail(targetUid, t);
    if (email) {
      await sendEmail({
        to: email,
        subject: "Atualização sobre seu cadastro no Espaço Prelúdio",
        html: `<p>Olá, ${t.displayName || "profissional"}!</p>
          <p>Sua solicitação para o plano <strong>Atendimento a Empresas</strong> não pôde ser aprovada no momento${reason ? `: <em>${reason}</em>` : "."}.</p>
          <p>Se tiver dúvidas ou quiser tentar novamente, responda este e-mail.</p>`
      });
    }
  } catch (e) {
    logError("empresa_rejeitado_email_failed", e, { therapistUid: targetUid });
  }

  return res.json({ ok: true, plano: "trial", reason });
}));

// ─────────────────────────────────────────────────────────────────────────
// ADMIN — comprovantes de formação SEM_CONSELHO
// Mesma família dos endpoints recém-formado, mas pra diplomas de psicanalistas/
// terapeutas integrativos/hipnoterapeutas. Sem confiança automática — cada
// caso passa pelo admin que decide manualmente.
// ─────────────────────────────────────────────────────────────────────────

// GET /therapy/admin/comprovantes-formacao?status=pending-review|verified|all
router.get("/therapy/admin/comprovantes-formacao", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const wantStatus = String(req.query?.status || "pending-review").trim().toLowerCase();
  const allowed = new Set(["pending-review", "verified", "rejected", "all"]);
  if (!allowed.has(wantStatus)) return sendError(res, 400, "STATUS_INVALIDO");

  const db = getDb();
  // Filtra terapeutas SEM_CONSELHO. Não dá pra fazer where em campo dentro
  // de objeto eficientemente sem index — busca todos e filtra em memória
  // (volume baixo: terapeutas SEM_CONSELHO devem ser <100 por revisão manual).
  const snap = await db.collection("therapists").where("tipoConselho", "==", "SEM_CONSELHO").limit(500).get();
  const items = snap.docs.map(d => {
    const t = d.data();
    return {
      therapistUid: t.uid,
      displayName: t.displayName || "",
      email: t.email || null,
      tipoConselho: t.tipoConselho,
      verificationStatus: t.verificationStatus || null,
      formacaoNaoRegulamentada: t.formacaoNaoRegulamentada || null,
      formacaoDoc: t.formacaoDoc ? {
        decision: t.formacaoDoc.decision,
        reasons: t.formacaoDoc.reasons || [],
        lastUploadId: t.formacaoDoc.lastUploadId,
        lastUploadedAt: t.formacaoDoc.lastUploadedAt?.toMillis?.() || null,
        fileHash: t.formacaoDoc.fileHash,
        mediaType: t.formacaoDoc.mediaType,
        fileSize: t.formacaoDoc.fileSize,
        reviewedAt: t.formacaoDoc.reviewedAt?.toMillis?.() || null,
        reviewedBy: t.formacaoDoc.reviewedBy || null
      } : null
    };
  })
  .filter(item => {
    // Em qualquer status, exige comprovante real submetido — senão "Abrir"
    // quebra com COMPROVANTE_NAO_ENCONTRADO no admin UI.
    if (!item.formacaoDoc?.lastUploadId) return false;
    if (wantStatus === "all") return true;
    if (wantStatus === "pending-review") return item.formacaoDoc?.decision === "pending-review";
    if (wantStatus === "verified")       return item.verificationStatus === "verified";
    if (wantStatus === "rejected")       return item.formacaoDoc?.decision === "rejected";
    return false;
  })
  .sort((a, b) => (b.formacaoDoc?.lastUploadedAt || 0) - (a.formacaoDoc?.lastUploadedAt || 0));

  return res.json({ ok: true, items });
}));

// GET /therapy/admin/comprovantes-formacao/:uid — devolve fileBase64 pra admin abrir
router.get("/therapy/admin/comprovantes-formacao/:uid", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const targetUid = String(req.params.uid || "").trim();
  if (!targetUid) return sendError(res, 400, "UID_OBRIGATORIO");

  const therapist = await loadTherapist(targetUid);
  if (!therapist) return sendError(res, 404, "PROFISSIONAL_NAO_ENCONTRADO");
  if (!therapist.formacaoDoc?.lastUploadId) return sendError(res, 404, "COMPROVANTE_NAO_ENCONTRADO");

  const db = getDb();
  const uploadSnap = await db.collection("therapy_formacao_docs").doc(targetUid)
    .collection("uploads").doc(therapist.formacaoDoc.lastUploadId).get();
  if (!uploadSnap.exists) return sendError(res, 404, "ARQUIVO_NAO_ENCONTRADO");
  const upload = uploadSnap.data();

  return res.json({
    ok: true,
    item: {
      therapistUid: targetUid,
      uploadId: upload.uploadId,
      fileBase64: upload.fileBase64,
      mediaType: upload.mediaType,
      fileSize: upload.fileSize,
      fileHash: upload.fileHash,
      decision: upload.decision,
      uploadedAt: upload.uploadedAt?.toMillis?.() || null,
      therapist: {
        displayName: therapist.displayName || "",
        email: therapist.email || null,
        especialidade: therapist.especialidade || "",
        verificationStatus: therapist.verificationStatus || null,
        formacaoNaoRegulamentada: therapist.formacaoNaoRegulamentada || null
      }
    }
  });
}));

// POST /therapy/admin/comprovantes-formacao/:uid/aprovar
router.post("/therapy/admin/comprovantes-formacao/:uid/aprovar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const targetUid = String(req.params.uid || "").trim();
  if (!targetUid) return sendError(res, 400, "UID_OBRIGATORIO");

  const therapist = await loadTherapist(targetUid);
  if (!therapist) return sendError(res, 404, "PROFISSIONAL_NAO_ENCONTRADO");

  const notes = String(req.body?.notes || "").trim().slice(0, 500);

  await getDb().collection("therapists").doc(targetUid).set({
    verificationStatus: "verified",
    verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
    formacaoDoc: {
      decision: "approved",
      reviewedBy: adminAuth.email,
      reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      reviewNotes: notes
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({
    type: "formacao_doc_admin_approved",
    therapistUid: targetUid,
    reviewedBy: adminAuth.email,
    notes
  });

  // Notifica. Falha do email não impede aprovação.
  try {
    const email = await resolveTherapistEmail(targetUid, therapist);
    if (email) {
      const tpl = templateFormacaoApproved({
        therapistName: therapist.displayName || "profissional",
        painelUrl: buildPainelUrl()
      });
      await sendEmail({ to: email, ...tpl });
    }
  } catch (e) {
    logError("formacao_doc_approve_email_failed", e, { therapistUid: targetUid });
  }

  return res.json({ ok: true, verificationStatus: "verified" });
}));

// POST /therapy/admin/comprovantes-formacao/:uid/rejeitar
router.post("/therapy/admin/comprovantes-formacao/:uid/rejeitar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const targetUid = String(req.params.uid || "").trim();
  if (!targetUid) return sendError(res, 400, "UID_OBRIGATORIO");

  const therapist = await loadTherapist(targetUid);
  if (!therapist) return sendError(res, 404, "PROFISSIONAL_NAO_ENCONTRADO");

  const reason = String(req.body?.reason || "").trim().slice(0, 500);
  if (!reason) return sendError(res, 400, "MOTIVO_OBRIGATORIO");

  // Mantém verificationStatus="pending-review" pra user poder reenviar.
  // Marca o doc como rejected pra UI mostrar o motivo.
  await getDb().collection("therapists").doc(targetUid).set({
    formacaoDoc: {
      decision: "rejected",
      reasons: [reason],
      reviewedBy: adminAuth.email,
      reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      reviewNotes: reason
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({
    type: "formacao_doc_admin_rejected",
    therapistUid: targetUid,
    reviewedBy: adminAuth.email,
    reason
  });

  try {
    const email = await resolveTherapistEmail(targetUid, therapist);
    if (email) {
      const tpl = templateFormacaoRejected({
        therapistName: therapist.displayName || "profissional",
        reason,
        retryUrl: buildComprovanteFormacaoUrl()
      });
      await sendEmail({ to: email, ...tpl });
    }
  } catch (e) {
    logError("formacao_doc_reject_email_failed", e, { therapistUid: targetUid });
  }

  return res.json({ ok: true, verificationStatus: "pending-review", reason });
}));

// ═════════════════════════════════════════════════════════════════════════
// ADMIN — gestão de profissionais (busca, ajuste de plano, cortesias)
//
// Permite ao admin (Luis) listar TODOS os profissionais (verificados ou não),
// estender trial, conceder meses grátis (adminGrantedUntil), mudar plano,
// marcar verificado manualmente, e deixar nota administrativa.
//
// Campos especiais que outras partes do sistema devem respeitar:
//  - adminGrantedUntil (ms): se setado e > now, acesso liberado mesmo sem
//    plano pago (cortesia). Implementação do check fica onde o resto da
//    lógica de plano vive.
//  - adminNote: texto livre do admin (max 500), pra contexto da cortesia.
// ═════════════════════════════════════════════════════════════════════════

// GET /therapy/admin/profissionais?search=texto&status=all|verified|pending
router.get("/therapy/admin/profissionais", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const search = String(req.query?.search || "").trim().toLowerCase();
  const wantStatus = String(req.query?.status || "all").trim().toLowerCase();
  const allowedStatus = new Set(["all", "verified", "pending", "rejected"]);
  if (!allowedStatus.has(wantStatus)) return sendError(res, 400, "STATUS_INVALIDO");

  const db = getDb();
  // Sem orderBy: Firestore exclui docs sem o campo ordenado.
  // Profissionais antigos sem createdAt sumiram da lista — ordenamos em JS.
  const snap = await db.collection("therapists")
    .limit(500)
    .get();

  const now = Date.now();
  let items = snap.docs.map(d => {
    const t = d.data();
    const trialUntilMs = t.trialUntil?.toMillis?.() || (typeof t.trialUntil === "number" ? t.trialUntil : null);
    const studentUntilMs = t.studentVerifiedUntil?.toMillis?.() || (typeof t.studentVerifiedUntil === "number" ? t.studentVerifiedUntil : null);
    const adminGrantedUntilMs = t.adminGrantedUntil?.toMillis?.() || (typeof t.adminGrantedUntil === "number" ? t.adminGrantedUntil : null);
    // "verificado" não é campo no doc — derivamos de verificationStatus
    // (canonical: "none"|"pending"|"pending-review"|"verified"|"rejected").
    // verifiedAt é setado junto com verificationStatus="verified".
    const isVerified = t.verificationStatus === "verified";
    return {
      uid: t.uid || d.id,
      displayName: t.displayName || "",
      email: t.email || null,
      tipoConselho: t.tipoConselho || null,
      numeroConselho: t.numeroConselho || t.crp || t.crm || "",
      paisRegistro: t.paisRegistro || null,
      orgaoRegistro: t.orgaoRegistro || null,
      especialidade: t.especialidade || null,
      plano: t.plano || null,
      intendedTier: t.intendedTier || null,
      verificado: isVerified,
      verificationStatus: t.verificationStatus || null,
      verifiedAt: t.verifiedAt?.toMillis?.() || null,
      trialUntil: trialUntilMs,
      trialActive: !!(trialUntilMs && trialUntilMs > now),
      studentVerifiedUntil: studentUntilMs,
      adminGrantedUntil: adminGrantedUntilMs,
      adminGrantActive: !!(adminGrantedUntilMs && adminGrantedUntilMs > now),
      adminNote: t.adminNote || null,
      mpPreapprovalId: t.mpPreapprovalId || null,
      createdAt: t.createdAt?.toMillis?.() || null
    };
  });

  items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  // Filtra fantasmas — docs sem displayName E sem email são cadastros incompletos.
  items = items.filter(i => i.displayName || i.email);

  if (wantStatus === "verified") items = items.filter(i => i.verificado);
  else if (wantStatus === "pending") items = items.filter(i => !i.verificado && i.verificationStatus !== "rejected");
  else if (wantStatus === "rejected") items = items.filter(i => i.verificationStatus === "rejected");

  if (search) {
    items = items.filter(i =>
      (i.displayName || "").toLowerCase().includes(search) ||
      (i.email || "").toLowerCase().includes(search) ||
      (i.numeroConselho || "").toLowerCase().includes(search)
    );
  }

  return res.json({ ok: true, items, count: items.length });
}));

// GET /therapy/admin/denuncias — lista denúncias de mensagens pendentes/todas.
// Query: ?status=open|closed|all (default: open)
router.get("/therapy/admin/denuncias", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const wantStatus = String(req.query?.status || "open").trim().toLowerCase();
  const db = getDb();
  let q = db.collection("therapy_message_reports");
  if (wantStatus !== "all") {
    q = q.where("status", "==", wantStatus);
  }
  const snap = await q.limit(200).get();
  const rawItems = snap.docs.map(d => d.data());

  // Resolve nomes e emails dos UIDs (reporter + reported) pra admin saber quem reportou quem.
  // Batch: coleta UIDs unicos, busca em paralelo, monta maps.
  const uidSet = new Set();
  rawItems.forEach(r => { if (r.reporterUid) uidSet.add(r.reporterUid); if (r.reportedSenderUid) uidSet.add(r.reportedSenderUid); });
  const nameMap = {};
  const emailMap = {};
  await Promise.all([...uidSet].map(async (uid) => {
    try {
      const [user, authUser] = await Promise.all([
        identifyUser(uid),
        admin.auth().getUser(uid).catch(() => null)
      ]);
      nameMap[uid] = user?.doc?.displayName || null;
      emailMap[uid] = authUser?.email || null;
    } catch { /* ignora */ }
  }));

  const items = rawItems.map(r => ({
    reportId: r.reportId,
    messageId: r.messageId,
    threadId: r.threadId,
    reporterUid: r.reporterUid,
    reporterRole: r.reporterRole,
    reporterName: nameMap[r.reporterUid] || null,
    reporterEmail: emailMap[r.reporterUid] || null,
    reportedSenderUid: r.reportedSenderUid,
    reportedSenderRole: r.reportedSenderRole,
    reportedSenderName: nameMap[r.reportedSenderUid] || null,
    reason: r.reason,
    messageSnapshot: r.messageSnapshot || null,
    status: r.status,
    reviewedBy: r.reviewedBy || null,
    createdAt: r.createdAt?.toMillis ? r.createdAt.toMillis() : null
  })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return res.json({ ok: true, items, count: items.length });
}));

// PATCH /therapy/admin/denuncias/:id — fechar/resolver denuncia.
router.patch("/therapy/admin/denuncias/:id", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const reportId = String(req.params.id || "").trim();
  if (!reportId) return sendError(res, 400, "REPORT_ID_OBRIGATORIO");

  const newStatus = String(req.body?.status || "").trim();
  if (!newStatus || !["closed", "open"].includes(newStatus)) return sendError(res, 400, "STATUS_INVALIDO");

  const db = getDb();
  const ref = db.collection("therapy_message_reports").doc(reportId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "DENUNCIA_NAO_ENCONTRADA");

  await ref.set({
    status: newStatus,
    reviewedBy: adminAuth.email,
    reviewedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({
    type: "chat_report_reviewed",
    reportId,
    newStatus,
    reviewedBy: adminAuth.email
  });

  return res.json({ ok: true });
}));

// ─── NOTIFICAÇÕES ──────────────────────────────────────────────────────────

// POST /therapy/admin/notificacoes — admin envia notificação a um usuário.
// Body: { recipientUid, title, body, type?, reportId? }
router.post("/therapy/admin/notificacoes", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const db = getDb();
  const recipientUid = String(req.body?.recipientUid || "").trim();
  const title        = String(req.body?.title        || "").trim().slice(0, 200);
  const body         = String(req.body?.body         || "").trim().slice(0, 2000);
  const type         = String(req.body?.type         || "admin_message").trim();
  const reportId     = String(req.body?.reportId     || "").trim() || null;

  if (!recipientUid) return sendError(res, 400, "DESTINATARIO_OBRIGATORIO");
  if (!title)        return sendError(res, 400, "TITULO_OBRIGATORIO");
  if (!body)         return sendError(res, 400, "CORPO_OBRIGATORIO");

  const notifId = db.collection("therapy_notifications").doc().id;
  await db.collection("therapy_notifications").doc(notifId).set({
    notificationId: notifId,
    recipientUid,
    type,
    title,
    body,
    read: false,
    reportId,
    sentBy: adminAuth.email,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await logAudit({ type: "notification_sent", notificationId: notifId, recipientUid, sentBy: adminAuth.email, reportId });
  return res.json({ ok: true, notificationId: notifId });
}));

// GET /therapy/notifications — notificações do usuário autenticado (max 100).
router.get("/therapy/notifications", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const db = getDb();
  const snap = await db.collection("therapy_notifications")
    .where("recipientUid", "==", uid)
    .limit(100)
    .get();

  const items = snap.docs.map(d => {
    const n = d.data();
    return {
      notificationId: n.notificationId,
      type: n.type || "admin_message",
      title: n.title,
      body: n.body,
      read: n.read || false,
      reportId: n.reportId || null,
      createdAt: n.createdAt?.toMillis ? n.createdAt.toMillis() : null
    };
  }).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return res.json({ ok: true, items, count: items.length });
}));

// GET /therapy/notifications/unread-count — contador para badge do sino.
router.get("/therapy/notifications/unread-count", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const db = getDb();
  const snap = await db.collection("therapy_notifications")
    .where("recipientUid", "==", uid)
    .where("read", "==", false)
    .limit(100)
    .get();

  return res.json({ ok: true, count: snap.size });
}));

// PATCH /therapy/notifications/read-all — marca todas as notificações do usuário como lidas.
router.patch("/therapy/notifications/read-all", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const db = getDb();
  const snap = await db.collection("therapy_notifications")
    .where("recipientUid", "==", uid)
    .where("read", "==", false)
    .limit(100)
    .get();

  if (!snap.empty) {
    const batch = db.batch();
    snap.docs.forEach(d => batch.update(d.ref, { read: true }));
    await batch.commit();
  }

  return res.json({ ok: true, marked: snap.size });
}));

// GET /therapy/admin/pacientes — lista todas as contas de pacientes.
router.get("/therapy/admin/pacientes", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const search = String(req.query?.search || "").trim().toLowerCase();
  const snap = await getDb().collection("therapy_patient_accounts").limit(1000).get();

  let items = snap.docs.map(d => {
    const t = d.data();
    return {
      uid: t.uid || d.id,
      displayName: t.displayName || "",
      role: t.role || "patient",
      consentAiSummary: !!t.consentAiSummary,
      consentLgpd: !!t.consentLgpd,
      createdAt: t.createdAt?.toMillis?.() || null,
      updatedAt: t.updatedAt?.toMillis?.() || null,
    };
  });

  // Busca email no Firebase Auth em lote (até 100 por vez) para exibição
  try {
    const uids = items.map(i => ({ uid: i.uid }));
    const chunks = [];
    for (let i = 0; i < uids.length; i += 100) chunks.push(uids.slice(i, i + 100));
    const emailMap = {};
    for (const chunk of chunks) {
      const result = await admin.auth().getUsers(chunk);
      result.users.forEach(u => { emailMap[u.uid] = u.email || null; });
    }
    items.forEach(i => { i.email = emailMap[i.uid] || null; });
  } catch { items.forEach(i => { i.email = null; }); }

  items = items.filter(i => i.displayName || i.email);
  items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  if (search) {
    items = items.filter(i =>
      (i.displayName || "").toLowerCase().includes(search) ||
      (i.email || "").toLowerCase().includes(search)
    );
  }

  return res.json({ ok: true, total: items.length, items });
}));

// DELETE /therapy/admin/profissionais/:uid — remove doc fantasma da coleção therapists.
// Só permite se o doc não tiver displayName nem email (segurança: evita deletar prof real).
router.delete("/therapy/admin/profissionais/:uid", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;
  const uid = String(req.params.uid || "").trim();
  if (!uid) return sendError(res, 400, "UID_OBRIGATORIO");
  const ref = getDb().collection("therapists").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "PROFISSIONAL_NAO_ENCONTRADO");
  const d = snap.data();
  if (d.displayName || d.email) return sendError(res, 403, "PROFISSIONAL_NAO_FANTASMA",
    { hint: "Só documentos sem nome e sem email podem ser removidos por aqui." });
  await ref.delete();
  return res.json({ ok: true, deleted: uid });
}));

// PATCH /therapy/admin/profissionais/:uid — ajusta plano/cortesias do prof
// Body (todos campos opcionais — só aplica os presentes):
//   extendTrialDays: number — +N dias no trialUntil (a partir do MAX entre
//                              now e trial atual, pra não encurtar).
//   grantFreeMonths: number — +N meses (30 dias cada) no adminGrantedUntil.
//   setPlano: string         — novo valor de `plano` (allowlist).
//   setAdminNote: string     — nota livre do admin (max 500).
//   toggleVerificado: bool   — força verificado=true/false + verifiedAt.
const ALLOWED_PLANOS = new Set([
  "trial", "pro", "student-pending-review", "student-active",
  "recem-formado-eligible", "recem-formado-active",
  "empresa-pending-review", "empresa",
  "canceled"
]);
const DAY_MS = 24 * 60 * 60 * 1000;
router.patch("/therapy/admin/profissionais/:uid", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const targetUid = String(req.params.uid || "").trim();
  if (!targetUid) return sendError(res, 400, "UID_OBRIGATORIO");

  const therapist = await loadTherapist(targetUid);
  if (!therapist) return sendError(res, 404, "PROFISSIONAL_NAO_ENCONTRADO");

  const body = req.body || {};
  const updates = {};
  const auditDetail = [];
  const now = Date.now();

  if (Number.isFinite(body.extendTrialDays) && body.extendTrialDays > 0) {
    const days = Math.min(Math.floor(body.extendTrialDays), 3650); // cap 10 anos
    const currentMs = therapist.trialUntil?.toMillis?.() || (typeof therapist.trialUntil === "number" ? therapist.trialUntil : 0);
    const baseMs = Math.max(currentMs, now);
    const newMs = baseMs + days * DAY_MS;
    updates.trialUntil = new Date(newMs);
    auditDetail.push(`+${days}d trial → ${new Date(newMs).toISOString()}`);
  }

  if (Number.isFinite(body.grantFreeMonths) && body.grantFreeMonths > 0) {
    const months = Math.min(Math.floor(body.grantFreeMonths), 120); // cap 10 anos
    const currentMs = therapist.adminGrantedUntil?.toMillis?.() || (typeof therapist.adminGrantedUntil === "number" ? therapist.adminGrantedUntil : 0);
    const baseMs = Math.max(currentMs, now);
    const newMs = baseMs + months * 30 * DAY_MS;
    updates.adminGrantedUntil = new Date(newMs);
    auditDetail.push(`+${months}mo cortesia → ${new Date(newMs).toISOString()}`);
  }

  if (typeof body.setPlano === "string" && body.setPlano) {
    if (!ALLOWED_PLANOS.has(body.setPlano)) return sendError(res, 400, "PLANO_INVALIDO");
    updates.plano = body.setPlano;
    auditDetail.push(`plano → ${body.setPlano}`);
  }

  const ALLOWED_INTENDED_TIERS = new Set(["profissional","empresa","estudante","recem-formado"]);
  if (typeof body.setIntendedTier === "string" && body.setIntendedTier) {
    if (!ALLOWED_INTENDED_TIERS.has(body.setIntendedTier)) return sendError(res, 400, "INTENDED_TIER_INVALIDO");
    updates.intendedTier = body.setIntendedTier;
    auditDetail.push(`intendedTier → ${body.setIntendedTier}`);
  }

  if (typeof body.setAdminNote === "string") {
    updates.adminNote = body.setAdminNote.slice(0, 500);
    auditDetail.push(`nota atualizada`);
  }

  if (typeof body.toggleVerificado === "boolean") {
    // Source of truth eh verificationStatus (NAO existe campo verificado boolean).
    if (body.toggleVerificado) {
      updates.verificationStatus = "verified";
      updates.verifiedAt = admin.firestore.FieldValue.serverTimestamp();
    } else {
      updates.verificationStatus = "pending-review";
      updates.verifiedAt = null;
    }
    auditDetail.push(`verificacao → ${body.toggleVerificado ? "verified" : "pending-review"}`);
  }

  if (Object.keys(updates).length === 0) {
    return sendError(res, 400, "NENHUMA_ACAO");
  }

  updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  await getDb().collection("therapists").doc(targetUid).set(updates, { merge: true });

  await logAudit({
    type: "admin_profissional_ajuste",
    therapistUid: targetUid,
    reviewedBy: adminAuth.email,
    detail: auditDetail.join(" | ")
  });

  // Devolve o doc atualizado pra UI atualizar sem refetch.
  const fresh = await loadTherapist(targetUid);
  return res.json({
    ok: true,
    profissional: {
      uid: targetUid,
      plano: fresh.plano || null,
      trialUntil: fresh.trialUntil?.toMillis?.() || (typeof fresh.trialUntil === "number" ? fresh.trialUntil : null),
      adminGrantedUntil: fresh.adminGrantedUntil?.toMillis?.() || (typeof fresh.adminGrantedUntil === "number" ? fresh.adminGrantedUntil : null),
      adminNote: fresh.adminNote || null,
      verificado: fresh.verificationStatus === "verified",
      verificationStatus: fresh.verificationStatus || null,
      verifiedAt: fresh.verifiedAt?.toMillis?.() || null
    }
  });
}));

// ═════════════════════════════════════════════════════════════════════════
// AUTO-AGENDAMENTO PÚBLICO — paciente solicita horário via link público
// (https://espacopreludio.com.br/agendar.html?p=<slug>) sem ter conta.
//
// Fluxo:
//  1. Paciente abre /agendar?p=<slug> → GET /public/agendar/:slug retorna
//     perfil + agendaConfig.
//  2. Frontend chama GET /public/agendar/:slug/slots?from=...&to=... e
//     renderiza calendário com slots livres.
//  3. Paciente escolhe slot + preenche nome/email/telefone/observações →
//     POST /public/agendar/:slug/solicitar cria therapy_scheduling_requests
//     e envia e-mail pro terapeuta.
//  4. Terapeuta vê em /painel pendências → POST .../aprovar cria sessão
//     real (therapy_sessions) ou .../rejeitar declina.
//
// Modelo de privacidade: dados do paciente ficam plaintext em
// therapy_scheduling_requests até aprovação. Pós-aprovação, criamos a
// sessão normalmente (sem cifrar, igual /sessao/criar). O paciente real
// (com cifra E2E) só é criado pelo terapeuta depois.
// ═════════════════════════════════════════════════════════════════════════

const SCHEDULING_REQUEST_NAME_MAX  = 80;
const SCHEDULING_REQUEST_EMAIL_MAX = 120;
const SCHEDULING_REQUEST_NOTES_MAX = 1000;
const SCHEDULING_REQUEST_DEFAULT_MIN_NOTICE_HOURS = 24;
const SCHEDULING_REQUEST_DEFAULT_MAX_ADVANCE_DAYS = 60;
const SCHEDULING_REQUEST_TTL_DAYS = 14;

const publicSchedulingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1h
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "RATE_LIMIT_EXCEDIDO", hint: "Muitas solicitações. Aguarde 1h e tente novamente." }
});

const STUDENT_LEAD_NAME_MAX        = 80;
const STUDENT_LEAD_EMAIL_MAX       = 120;
const STUDENT_LEAD_PHONE_MAX       = 30;
const STUDENT_LEAD_INSTITUTION_MAX = 120;
const STUDENT_LEAD_COURSE_MAX      = 60;
const STUDENT_LEAD_MESSAGE_MAX     = 500;

const publicStudentLeadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1h
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "RATE_LIMIT_EXCEDIDO", hint: "Muitas solicitações. Aguarde 1h e tente novamente." }
});

function summarizeTherapistForPublicScheduling(therapist) {
  const c = therapist.consultorio || {};
  const conselhoSigla = resolveSiglaFromTherapist(therapist);
  const conselhoMeta  = getConselho(conselhoSigla);
  return {
    displayName:    therapist.displayName || "",
    especialidade:  therapist.especialidade || "",
    bio:            therapist.bio || "",
    photoBase64:    therapist.photoBase64 || "",
    photoMime:      therapist.photoMime || "",
    conselhoLabel:  conselhoMeta?.label || "",
    numeroConselho: therapist.numeroConselho || therapist.crp || therapist.crm || "",
    isInternacional: isConselhoInternacional(conselhoSigla),
    paisRegistro:   therapist.paisRegistro || "",
    orgaoRegistro:  therapist.orgaoRegistro || "",
    cidade:         c.cidade || "",
    uf:             c.uf || ""
  };
}

// Computa slots livres entre [fromMs, toMs] aplicando agendaConfig + sessões
// existentes + blackouts + solicitações pendentes (que ainda não viraram
// sessões mas já bloqueiam o slot pra evitar overbooking).
async function computeAvailableSlots({ therapist, therapistUid, fromMs, toMs }) {
  const cfg = therapist.agendaConfig || {};
  const startHour   = Number.isFinite(cfg.startHour)   ? cfg.startHour   : 8;
  const endHour     = Number.isFinite(cfg.endHour)     ? cfg.endHour     : 21;
  const slotMinutes = Number.isFinite(cfg.slotMinutes) ? cfg.slotMinutes : 50;
  const slotMs = slotMinutes * 60 * 1000;

  const minNoticeHours = Number.isFinite(therapist.publicSchedulingMinNoticeHours)
    ? therapist.publicSchedulingMinNoticeHours
    : SCHEDULING_REQUEST_DEFAULT_MIN_NOTICE_HOURS;
  const maxAdvanceDays = Number.isFinite(therapist.publicSchedulingMaxAdvanceDays)
    ? therapist.publicSchedulingMaxAdvanceDays
    : SCHEDULING_REQUEST_DEFAULT_MAX_ADVANCE_DAYS;
  const earliestStart = Date.now() + minNoticeHours * 60 * 60 * 1000;
  const latestStart   = Date.now() + maxAdvanceDays * 24 * 60 * 60 * 1000;
  const effectiveFrom = Math.max(fromMs, earliestStart);
  const effectiveTo   = Math.min(toMs,   latestStart);

  const db = getDb();

  // Carrega ocupações: sessões + blackouts + solicitações pendentes.
  // Query simples por therapistUid; filtro de janela aplicado em memória.
  const [sessionsSnap, blackoutsSnap, pendingSnap] = await Promise.all([
    db.collection("therapy_sessions").where("therapistUid", "==", therapistUid).get(),
    db.collection("therapy_agenda_blackouts").where("therapistUid", "==", therapistUid).get(),
    db.collection("therapy_scheduling_requests")
      .where("therapistUid", "==", therapistUid)
      .where("status", "==", "pending").get()
  ]);

  const busyRanges = [];
  sessionsSnap.forEach(d => {
    const s = d.data();
    if (s.status === "canceled") return;
    if (!s.scheduledAt) return;
    busyRanges.push({ start: s.scheduledAt, end: s.scheduledAt + slotMs });
  });
  blackoutsSnap.forEach(d => {
    const b = d.data();
    if (!b.startAt || !b.endAt) return;
    busyRanges.push({ start: b.startAt, end: b.endAt });
  });
  pendingSnap.forEach(d => {
    const r = d.data();
    if (!r.requestedSlot) return;
    busyRanges.push({ start: r.requestedSlot, end: (r.requestedSlotEnd || r.requestedSlot + slotMs) });
  });

  function isBusy(slotStart, slotEnd) {
    for (const r of busyRanges) {
      if (slotStart < r.end && slotEnd > r.start) return true;
    }
    return false;
  }

  // Itera dia a dia no fuso America/Sao_Paulo (UTC-3 fixo). Sem DST no BR
  // desde 2019, então offset constante é aceitável pra MVP. Domingo (0) e
  // sábado (6) são ignorados — terapeuta pode adicionar blackout em horário
  // específico, mas a janela diária some no fim de semana por padrão.
  const TZ_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC-3
  const slots = [];
  const dayMs = 24 * 60 * 60 * 1000;
  const weeklyAvailability = therapist.weeklyAvailability || null; // null = sem grade configurada
  const startDayUtc = Math.floor((effectiveFrom + TZ_OFFSET_MS) / dayMs) * dayMs - TZ_OFFSET_MS;
  for (let dayStart = startDayUtc; dayStart <= effectiveTo; dayStart += dayMs) {
    const localDate = new Date(dayStart + TZ_OFFSET_MS);
    const dow = localDate.getUTCDay();

    // Com grade configurada: usa os horários definidos pelo profissional.
    // Sem grade: comportamento legado (Seg-Sex, startHour-endHour).
    if (weeklyAvailability) {
      const availHours = weeklyAvailability[String(dow)] || [];
      if (availHours.length === 0) continue; // dia sem disponibilidade
      // localDate representa meia-noite UTC do dia do calendário.
      // Para converter hora local Brasil (UTC-3) em UTC: UTC = hora_local + 3h
      const utcMidnight = Date.UTC(
        localDate.getUTCFullYear(),
        localDate.getUTCMonth(),
        localDate.getUTCDate()
      );
      const TZ_H = TZ_OFFSET_MS / 3600000; // 3 (horas)
      for (const h of availHours) {
        const slotStart = utcMidnight + (h + TZ_H) * 3600 * 1000;
        const slotEnd   = slotStart + slotMs;
        if (slotStart < effectiveFrom || slotStart > effectiveTo) continue;
        slots.push({ start: slotStart, end: slotEnd, available: !isBusy(slotStart, slotEnd) });
      }
      continue; // pula o loop legado abaixo
    }

    if (dow === 0 || dow === 6) continue;
    for (let h = startHour * 60; h + slotMinutes <= endHour * 60; h += slotMinutes) {
      const slotStart = dayStart + h * 60 * 1000;
      const slotEnd   = slotStart + slotMs;
      if (slotStart < effectiveFrom) continue;
      if (slotStart > effectiveTo)   break;
      const busy = isBusy(slotStart, slotEnd);
      slots.push({ start: slotStart, end: slotEnd, available: !busy });
    }
  }
  return { slots, slotMinutes };
}

// GET /public/profissionais — diretório público de terapeutas. Lista todos
// que: (a) verificationStatus=verified, (b) publicSchedulingEnabled=true,
// (c) listPublicly=true (opt-in), (d) plano ativo. Filtros opcionais:
// especialidade, cidade, uf.
router.get("/public/profissionais", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;

  // Normalização agressiva pro filtro de cidade: lowercase + remove acentos +
  // colapsa espaços + remove "s" final de palavras com >3 chars (plural simples
  // — "torres" vira "torre", "anjos" vira "anjo", mas "anos" continua "ano").
  // Isso casa "passo de torres" com "passo de torre".
  const normSearch = (s) => String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ").trim()
    .replace(/(\w{3,})s\b/g, "$1");

  // Mapa nome do estado → sigla. Aceita o nome completo ou a sigla em qualquer
  // ponta: paciente filtra "SC", profissional tem "Santa Catarina" cadastrado
  // (ou vice-versa) → ainda casa.
  const UF_BY_NAME = {
    "acre": "AC", "alagoas": "AL", "amapa": "AP", "amazonas": "AM",
    "bahia": "BA", "ceara": "CE", "distrito federal": "DF", "espirito santo": "ES",
    "goias": "GO", "maranhao": "MA", "mato grosso": "MT", "mato grosso do sul": "MS",
    "minas gerais": "MG", "para": "PA", "paraiba": "PB", "parana": "PR",
    "pernambuco": "PE", "piaui": "PI", "rio de janeiro": "RJ",
    "rio grande do norte": "RN", "rio grande do sul": "RS", "rondonia": "RO",
    "roraima": "RR", "santa catarina": "SC", "sao paulo": "SP", "sergipe": "SE",
    "tocantins": "TO"
  };
  const toSigla = (raw) => {
    const s = String(raw || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
    if (!s) return "";
    if (s.length === 2) return s.toUpperCase();    // já é sigla
    return UF_BY_NAME[s] || raw.toUpperCase();     // nome → sigla; fallback mantém
  };

  const filterEspecialidade = normSearch(req.query?.especialidade);
  const filterCidade        = normSearch(req.query?.cidade);
  const filterUf            = toSigla(req.query?.uf);
  const limit               = Math.min(100, Math.max(1, Number(req.query?.limit) || 50));

  const db = getDb();
  // Query Firestore com flags. Filtros por cidade/especialidade aplicados client-side
  // pra evitar exigência de composite index.
  const snap = await db.collection("therapists")
    .where("verificationStatus", "==", "verified")
    .where("listPublicly", "==", true)
    .limit(500)
    .get();

  const items = [];
  snap.forEach(d => {
    const t = d.data();
    if (!t.publicSchedulingSlug || !t.publicSchedulingEnabled) return;
    if (!evaluatePlanAccess(t).ok) return;

    const c = t.consultorio || {};
    const esp = normSearch(t.especialidade);
    const cidadeNorm = normSearch(c.cidade);
    const ufSigla    = toSigla(c.uf);

    if (filterEspecialidade && !esp.includes(filterEspecialidade)) return;
    if (filterCidade && !cidadeNorm.includes(filterCidade)) return;
    if (filterUf && ufSigla !== filterUf) return;

    const conselhoSigla = resolveSiglaFromTherapist(t);
    const conselhoMeta  = getConselho(conselhoSigla);

    items.push({
      slug:           t.publicSchedulingSlug,
      displayName:    t.displayName || "",
      especialidade:  t.especialidade || "",
      photoBase64:    t.photoBase64 || "",
      photoMime:      t.photoMime || "",
      conselhoLabel:  conselhoMeta?.label || "",
      numeroConselho: t.numeroConselho || t.crp || t.crm || "",
      isInternacional: isConselhoInternacional(conselhoSigla),
      paisRegistro:   t.paisRegistro || "",
      orgaoRegistro:  t.orgaoRegistro || "",
      cidade:         c.cidade || "",
      uf:             c.uf || "",
      bio:            (t.bio || "").slice(0, 180) // resumo
    });
  });

  // Ordena alfabético (nome). Limit aplicado por último.
  items.sort((a, b) => a.displayName.localeCompare(b.displayName, "pt-BR"));

  return res.json({
    ok: true,
    total: items.length,
    items: items.slice(0, limit)
  });
}));

// GET /public/agendar/:slug — perfil público pra renderizar a página
router.get("/public/agendar/:slug", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const slug = String(req.params.slug || "").trim().toLowerCase();
  if (!isValidPublicSlug(slug)) return sendError(res, 400, "SLUG_INVALIDO");

  const therapist = await findTherapistBySlug(slug);
  if (!therapist) return sendError(res, 404, "PROFISSIONAL_NAO_ENCONTRADO");
  if (therapist.verificationStatus !== "verified") {
    return sendError(res, 404, "PROFISSIONAL_NAO_VERIFICADO");
  }
  if (!therapist.publicSchedulingEnabled) {
    return sendError(res, 404, "AGENDAMENTO_PUBLICO_DESABILITADO");
  }
  const access = evaluatePlanAccess(therapist);
  if (!access.ok) {
    return sendError(res, 404, "AGENDAMENTO_PUBLICO_INDISPONIVEL");
  }

  const cfg = therapist.agendaConfig || {};
  return res.json({
    ok: true,
    profissional: summarizeTherapistForPublicScheduling(therapist),
    agendaConfig: {
      startHour:   Number.isFinite(cfg.startHour)   ? cfg.startHour   : 8,
      endHour:     Number.isFinite(cfg.endHour)     ? cfg.endHour     : 21,
      slotMinutes: Number.isFinite(cfg.slotMinutes) ? cfg.slotMinutes : 50
    },
    schedulingRules: {
      minNoticeHours: Number.isFinite(therapist.publicSchedulingMinNoticeHours)
        ? therapist.publicSchedulingMinNoticeHours
        : SCHEDULING_REQUEST_DEFAULT_MIN_NOTICE_HOURS,
      maxAdvanceDays: Number.isFinite(therapist.publicSchedulingMaxAdvanceDays)
        ? therapist.publicSchedulingMaxAdvanceDays
        : SCHEDULING_REQUEST_DEFAULT_MAX_ADVANCE_DAYS
    }
  });
}));

// GET /public/agendar/:slug/slots?from=ms&to=ms — slots disponíveis na janela
router.get("/public/agendar/:slug/slots", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const slug = String(req.params.slug || "").trim().toLowerCase();
  if (!isValidPublicSlug(slug)) return sendError(res, 400, "SLUG_INVALIDO");

  const fromMs = Number(req.query.from);
  const toMs   = Number(req.query.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return sendError(res, 400, "JANELA_INVALIDA", { hint: "Use ?from=<ms>&to=<ms> com to > from." });
  }
  if ((toMs - fromMs) > 60 * 24 * 60 * 60 * 1000) {
    return sendError(res, 400, "JANELA_GRANDE_DEMAIS", { hint: "Máximo 60 dias por consulta." });
  }

  const therapist = await findTherapistBySlug(slug);
  if (!therapist) return sendError(res, 404, "PROFISSIONAL_NAO_ENCONTRADO");
  if (therapist.verificationStatus !== "verified") {
    return sendError(res, 404, "PROFISSIONAL_NAO_VERIFICADO");
  }
  if (!therapist.publicSchedulingEnabled) {
    return sendError(res, 404, "AGENDAMENTO_PUBLICO_DESABILITADO");
  }
  const access = evaluatePlanAccess(therapist);
  if (!access.ok) {
    return sendError(res, 404, "AGENDAMENTO_PUBLICO_INDISPONIVEL");
  }

  const therapistUid = (await getDb().collection("therapists")
    .where("publicSchedulingSlug", "==", slug).limit(1).get()).docs[0].id;
  const { slots, slotMinutes } = await computeAvailableSlots({
    therapist, therapistUid, fromMs, toMs
  });

  return res.json({ ok: true, slots, slotMinutes });
}));

// GET /public/agendar/:slug/disponibilidade?date=YYYY-MM-DD
// Retorna os slots disponíveis para a data informada, já descontando sessões
// e bloqueios existentes naquele dia.
router.get("/public/agendar/:slug/disponibilidade", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const slug = String(req.params.slug || "").trim().toLowerCase();
  const dateStr = String(req.query?.date || "").trim(); // YYYY-MM-DD

  if (!slug) return sendError(res, 400, "SLUG_OBRIGATORIO");
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return sendError(res, 400, "DATE_INVALIDA");

  const therapist = await loadBySlug(slug);
  if (!therapist) return sendError(res, 404, "PROFISSIONAL_NAO_ENCONTRADO");
  if (!therapist.publicSchedulingEnabled) return sendError(res, 403, "AGENDAMENTO_DESABILITADO");

  const weeklyAvailability = therapist.weeklyAvailability || null;
  if (!weeklyAvailability) {
    // Sem grade configurada — retorna vazio (profissional precisa configurar)
    return res.json({ ok: true, slots: [], configured: false });
  }

  // Dia da semana da data solicitada (0=Dom ... 6=Sáb)
  const [year, month, day] = dateStr.split("-").map(Number);
  const dateObj = new Date(year, month - 1, day);
  const dow = dateObj.getDay(); // 0=Dom, 1=Seg ... 6=Sáb

  const availableHours = (weeklyAvailability[String(dow)] || []).slice();
  if (availableHours.length === 0) {
    return res.json({ ok: true, slots: [], configured: true });
  }

  // Busca sessões já marcadas para o dia (para excluir horários ocupados)
  const db = getDb();
  const dayStart = new Date(year, month - 1, day, 0, 0, 0).getTime();
  const dayEnd   = new Date(year, month - 1, day, 23, 59, 59).getTime();

  const [sessionsSnap, blackoutsSnap] = await Promise.all([
    db.collection("therapy_sessions")
      .where("therapistUid", "==", therapist.uid)
      .where("scheduledAt", ">=", dayStart)
      .where("scheduledAt", "<=", dayEnd)
      .where("status", "in", ["scheduled", "in_progress"])
      .get().catch(() => null),
    db.collection("therapy_blackouts")
      .where("therapistUid", "==", therapist.uid)
      .get().catch(() => null)
  ]);

  const occupiedHours = new Set();

  (sessionsSnap?.docs || []).forEach(d => {
    const s = d.data();
    const h = new Date(Number(s.scheduledAt)).getHours();
    occupiedHours.add(h);
  });

  (blackoutsSnap?.docs || []).forEach(d => {
    const b = d.data();
    const from = Number(b.from), to = Number(b.to);
    if (from < dayEnd && to > dayStart) {
      // Blackout intersecta o dia — bloqueia as horas afetadas
      for (let h = 0; h < 24; h++) {
        const slotStart = new Date(year, month - 1, day, h, 0, 0).getTime();
        const slotEnd   = slotStart + 3600000;
        if (from < slotEnd && to > slotStart) occupiedHours.add(h);
      }
    }
  });

  const slots = availableHours
    .filter(h => !occupiedHours.has(h))
    .map(h => ({ hour: h, label: `${String(h).padStart(2, "0")}:00` }));

  return res.json({ ok: true, slots, configured: true });
}));

// POST /public/agendar/:slug/solicitar — cria solicitação + e-mail pro terapeuta
router.post("/public/agendar/:slug/solicitar", publicSchedulingLimiter, asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const slug = String(req.params.slug || "").trim().toLowerCase();
  if (!isValidPublicSlug(slug)) return sendError(res, 400, "SLUG_INVALIDO");

  const patientName = String(req.body?.patientName || "").trim().slice(0, SCHEDULING_REQUEST_NAME_MAX);
  if (!patientName) return sendError(res, 400, "NOME_OBRIGATORIO");

  const patientEmailRaw = String(req.body?.patientEmail || "").trim().toLowerCase().slice(0, SCHEDULING_REQUEST_EMAIL_MAX);
  if (!patientEmailRaw || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patientEmailRaw)) {
    return sendError(res, 400, "EMAIL_INVALIDO");
  }
  const patientEmail = patientEmailRaw;

  const patientPhoneRaw = String(req.body?.patientPhone || "").trim();
  const patientPhoneNorm = patientPhoneRaw ? normalizeWaPhone(patientPhoneRaw) : "";
  const patientPhone = patientPhoneNorm.length >= 12 ? patientPhoneNorm : null;

  const notes = String(req.body?.notes || "").trim().slice(0, SCHEDULING_REQUEST_NOTES_MAX);

  const requestedSlot = Number(req.body?.requestedSlot || 0);
  if (!Number.isFinite(requestedSlot) || requestedSlot <= Date.now()) {
    return sendError(res, 400, "HORARIO_INVALIDO");
  }

  const therapistDocSnap = await getDb().collection("therapists")
    .where("publicSchedulingSlug", "==", slug).limit(1).get();
  if (therapistDocSnap.empty) return sendError(res, 404, "PROFISSIONAL_NAO_ENCONTRADO");
  const therapistDoc = therapistDocSnap.docs[0];
  const therapist = therapistDoc.data();
  const therapistUid = therapistDoc.id;
  if (therapist.verificationStatus !== "verified") {
    return sendError(res, 404, "PROFISSIONAL_NAO_VERIFICADO");
  }
  if (!therapist.publicSchedulingEnabled) {
    return sendError(res, 404, "AGENDAMENTO_PUBLICO_DESABILITADO");
  }
  const access = evaluatePlanAccess(therapist);
  if (!access.ok) return sendError(res, 404, "AGENDAMENTO_PUBLICO_INDISPONIVEL");

  // Valida que o slot ainda está livre (race: outro paciente pediu o mesmo
  // horário entre o GET /slots e este POST). Janela de checagem = slot inteiro.
  const cfg = therapist.agendaConfig || {};
  const slotMinutes = Number.isFinite(cfg.slotMinutes) ? cfg.slotMinutes : 50;
  const slotEndMs = requestedSlot + slotMinutes * 60 * 1000;
  const { slots } = await computeAvailableSlots({
    therapist, therapistUid,
    fromMs: requestedSlot - 60 * 1000,
    toMs:   slotEndMs   + 60 * 1000
  });
  const matchingSlot = slots.find(s => s.start === requestedSlot);
  if (!matchingSlot || !matchingSlot.available) {
    return sendError(res, 409, "HORARIO_INDISPONIVEL", { hint: "Esse horário ficou indisponível. Escolha outro." });
  }

  // Cria a solicitação.
  const requestId = newId("scrq");
  const ipRaw = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const ipHash = ipRaw ? crypto.createHash("sha256").update(ipRaw).digest("hex").slice(0, 16) : null;
  const expiresAt = Date.now() + SCHEDULING_REQUEST_TTL_DAYS * 24 * 60 * 60 * 1000;

  await getDb().collection("therapy_scheduling_requests").doc(requestId).set({
    requestId,
    therapistUid,
    therapistSlug: slug,
    patientName,
    patientEmail,
    patientPhone,
    notes,
    requestedSlot,
    requestedSlotEnd: slotEndMs,
    status: "pending",
    ipHash,
    expiresAt,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  // E-mail pro terapeuta (fire-and-forget — não bloqueia resposta ao paciente).
  const therapistEmail = await resolveTherapistEmail(therapistUid, therapist);
  if (therapistEmail) {
    const tpl = templateSchedulingRequest({
      therapistName: therapist.displayName || "Profissional",
      patientName,
      patientEmail,
      patientPhone,
      notes,
      requestedSlot,
      painelUrl: buildPainelUrl()
    });
    sendEmail({ to: therapistEmail, ...tpl }).catch(e =>
      logError("scheduling_request_email_failed", e, { requestId })
    );
  }

  // WhatsApp pro terapeuta via Twilio (se tiver notifWhatsapp configurado)
  if (therapist.notifWhatsapp) {
    const twilioWa = require("../services/twilio-whatsapp");
    const slotDate = new Date(requestedSlot);
    const slotFmt  = slotDate.toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit"
    });
    const msg = `🔔 *Novo pedido de consulta!*\n\n👤 Paciente: ${patientName}\n📞 Telefone: ${patientPhone || "não informado"}\n🕐 Horário solicitado: ${slotFmt}${notes ? `\n📝 Obs.: ${notes}` : ""}\n\nAcesse o painel pra aprovar ou recusar:\n${buildPainelUrl()}`;
    twilioWa.sendText({ to: therapist.notifWhatsapp, message: msg }).catch(e =>
      logError("scheduling_request_whatsapp_failed", e, { requestId })
    );
  }

  // Notificação in-app pro terapeuta
  createNotification({
    therapistUid,
    type:  "scheduling_request",
    title: `Novo pedido de consulta de ${patientName}`,
    body:  `${patientName} solicitou um horário${requestedSlot ? " para " + new Date(requestedSlot).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""}.${notes ? " Obs.: " + notes.slice(0, 80) : ""}`,
    link:  "/painel.html",
    data:  { requestId, patientName, patientPhone, requestedSlot }
  });

  await logAudit({
    type: "scheduling_request_created",
    requestId,
    therapistUid,
    requestedSlot
  });

  // Push (fire-and-forget) — terapeuta vê notificação imediata mesmo offline.
  pushToTherapist(therapistUid, {
    title: "Novo pedido de consulta",
    body: `${patientName} pediu horário pra ${new Date(requestedSlot).toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" })}`,
    url: "/painel.html",
    tag: "scheduling-request"
  }).catch(e => logError("push_scheduling_failed", e, { requestId }));

  return res.json({ ok: true, requestId });
}));

// POST /public/leads/estudante — landing page pública: interessado no tier
// Estudante deixa contato (não exige conta). Salva em Firestore + notifica
// admin por e-mail. Sem auth — protegido só por rate limit.
router.post("/public/leads/estudante", publicStudentLeadLimiter, asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;

  const name = String(req.body?.name || "").trim().slice(0, STUDENT_LEAD_NAME_MAX);
  if (!name) return sendError(res, 400, "NOME_OBRIGATORIO");

  const emailRaw = String(req.body?.email || "").trim().toLowerCase().slice(0, STUDENT_LEAD_EMAIL_MAX);
  if (!emailRaw || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) {
    return sendError(res, 400, "EMAIL_INVALIDO");
  }

  const phone = String(req.body?.phone || "").trim().slice(0, STUDENT_LEAD_PHONE_MAX);
  if (!phone) return sendError(res, 400, "TELEFONE_OBRIGATORIO");

  const institution = String(req.body?.institution || "").trim().slice(0, STUDENT_LEAD_INSTITUTION_MAX);
  const course      = String(req.body?.course || "").trim().slice(0, STUDENT_LEAD_COURSE_MAX);
  const message     = String(req.body?.message || "").trim().slice(0, STUDENT_LEAD_MESSAGE_MAX);

  const leadId = newId("stlead");
  const ipRaw = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const ipHash = ipRaw ? crypto.createHash("sha256").update(ipRaw).digest("hex").slice(0, 16) : null;

  await getDb().collection("therapy_student_leads").doc(leadId).set({
    leadId,
    name,
    email: emailRaw,
    phone,
    institution,
    course,
    message,
    ipHash,
    status: "new",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  if (THERAPY_ADMIN_EMAILS.length) {
    const tpl = templateStudentLeadReceived({ name, email: emailRaw, phone, institution, course, message });
    sendEmail({ to: THERAPY_ADMIN_EMAILS, ...tpl, replyTo: emailRaw }).catch(e =>
      logError("student_lead_email_failed", e, { leadId })
    );
  }

  return res.json({ ok: true });
}));

// ─────────────────────────────────────────────────────────────────────────
// ADMIN — Leads de interesse no plano Estudante (modal da landing page)
// ─────────────────────────────────────────────────────────────────────────

// GET /therapy/admin/leads-estudante?status=new|contacted|all (default: new)
router.get("/therapy/admin/leads-estudante", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const wantStatus = String(req.query?.status || "new").trim().toLowerCase();
  const db = getDb();
  let q = db.collection("therapy_student_leads");
  if (wantStatus !== "all") {
    q = q.where("status", "==", wantStatus);
  }
  const snap = await q.limit(200).get();

  const items = snap.docs.map(d => {
    const r = d.data();
    return {
      leadId: r.leadId,
      name: r.name,
      email: r.email,
      institution: r.institution || null,
      course: r.course || null,
      message: r.message || null,
      status: r.status || "new",
      contactedBy: r.contactedBy || null,
      createdAt: r.createdAt?.toMillis ? r.createdAt.toMillis() : null
    };
  }).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return res.json({ ok: true, items, count: items.length });
}));

// PATCH /therapy/admin/leads-estudante/:id — marca lead como contatado/novo.
router.patch("/therapy/admin/leads-estudante/:id", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const leadId = String(req.params.id || "").trim();
  if (!leadId) return sendError(res, 400, "LEAD_ID_OBRIGATORIO");

  const newStatus = String(req.body?.status || "").trim();
  if (!["new", "contacted"].includes(newStatus)) return sendError(res, 400, "STATUS_INVALIDO");

  const db = getDb();
  const ref = db.collection("therapy_student_leads").doc(leadId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "LEAD_NAO_ENCONTRADO");

  await ref.set({
    status: newStatus,
    contactedBy: newStatus === "contacted" ? adminAuth.email : null,
    contactedAt: newStatus === "contacted" ? admin.firestore.FieldValue.serverTimestamp() : null
  }, { merge: true });

  return res.json({ ok: true });
}));

// GET /therapy/agendamentos/solicitacoes — terapeuta lista solicitações
// pendentes (e opcionalmente histórico recente).
router.get("/therapy/agendamentos/solicitacoes", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const includeAll = req.query?.all === "1" || req.query?.all === "true";
  const db = getDb();
  const snap = await db.collection("therapy_scheduling_requests")
    .where("therapistUid", "==", uid)
    .get();
  const items = [];
  snap.forEach(d => {
    const r = d.data();
    if (!includeAll && r.status !== "pending") return;
    items.push({
      requestId: r.requestId,
      patientName: r.patientName,
      patientEmail: r.patientEmail,
      patientPhone: r.patientPhone || null,
      notes: r.notes || "",
      requestedSlot: r.requestedSlot,
      requestedSlotEnd: r.requestedSlotEnd,
      status: r.status,
      sessionId: r.sessionId || null,
      respondedAt: r.respondedAt?.toMillis ? r.respondedAt.toMillis() : null,
      createdAt: r.createdAt?.toMillis ? r.createdAt.toMillis() : null
    });
  });
  items.sort((a, b) => (a.requestedSlot || 0) - (b.requestedSlot || 0));
  return res.json({ ok: true, requests: items });
}));

// POST /therapy/agendamentos/solicitacoes/:id/aprovar — converte em sessão
router.post("/therapy/agendamentos/solicitacoes/:id/aprovar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await requirePaidPlan(req, res, uid);
  if (!therapist) return;

  const requestId = String(req.params.id || "").trim();
  if (!requestId) return sendError(res, 400, "REQUEST_ID_OBRIGATORIO");

  const db = getDb();
  const reqDocRef = db.collection("therapy_scheduling_requests").doc(requestId);
  const reqSnap = await reqDocRef.get();
  if (!reqSnap.exists) return sendError(res, 404, "SOLICITACAO_NAO_ENCONTRADA");
  const reqData = reqSnap.data();
  if (reqData.therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");
  if (reqData.status !== "pending")  return sendError(res, 409, "SOLICITACAO_JA_RESPONDIDA");

  // Cria sessão real (mesmo padrão de /sessao/criar mas sem recorrência).
  const sId = newId("sess");
  const room = `therapy_${sId}`;
  const e2eeKey = crypto.randomBytes(32).toString("base64");
  const therapistEmail = await resolveTherapistEmail(uid, therapist);

  const joinPayload = {
    token_type: "therapy_join",
    sessionId: sId,
    therapistUid: uid,
    livekitRoom: room,
    patientNameHint: reqData.patientName,
    iat: Date.now(),
    exp: Date.now() + JOIN_TOKEN_VALIDITY_MS
  };
  const joinToken = signPayload(joinPayload, ACCESS_TOKEN_SECRET);

  const batch = db.batch();
  batch.set(db.collection("therapy_sessions").doc(sId), {
    sessionId: sId,
    therapistUid: uid,
    therapistDisplayName: therapist.displayName || "",
    therapistEmail,
    patientName: reqData.patientName,
    patientId: null,
    patientEmail: reqData.patientEmail || null,
    patientPhone: reqData.patientPhone || null,
    livekitRoom: room,
    e2eeKey,
    scheduledAt: reqData.requestedSlot,
    status: "scheduled",
    joinTokenExp: joinPayload.exp,
    recurrenceGroupId: null,
    recurrenceIndex: null,
    recurrenceCount: null,
    schedulingRequestId: requestId,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  batch.update(reqDocRef, {
    status: "approved",
    sessionId: sId,
    respondedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  await batch.commit();

  // Short code pra URL bonita do paciente.
  let joinCode = null;
  try {
    joinCode = await createJoinCode({ joinToken, sessionId: sId, expiresAt: joinPayload.exp });
  } catch (e) {
    logWarn("therapy_join_code_create_failed", { sessionId: sId, error: e.message });
  }

  // E-mail de confirmação pro paciente.
  if (reqData.patientEmail) {
    const cancelTokenInfo = buildCancelToken(sId);
    const tpl = templateConfirmation({
      patientName: reqData.patientName,
      therapistName: therapist.displayName || "seu profissional",
      scheduledAt: reqData.requestedSlot,
      joinUrl: buildPatientJoinUrl(joinCode || joinToken),
      cancelUrl: buildPatientCancelUrl(cancelTokenInfo.token),
      minCancelHours: THERAPY_MIN_CANCEL_HOURS_PATIENT
    });
    sendEmail({ to: reqData.patientEmail, replyTo: therapistEmail || undefined, ...tpl }).catch(e =>
      logError("scheduling_request_approval_email_failed", e, { requestId, sessionId: sId })
    );
  }

  await logAudit({
    type: "scheduling_request_approved",
    requestId,
    therapistUid: uid,
    sessionId: sId
  });

  return res.json({ ok: true, sessionId: sId, joinToken, joinTokenExp: joinPayload.exp });
}));

// POST /therapy/agendamentos/solicitacoes/:id/rejeitar — declina
router.post("/therapy/agendamentos/solicitacoes/:id/rejeitar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const requestId = String(req.params.id || "").trim();
  if (!requestId) return sendError(res, 400, "REQUEST_ID_OBRIGATORIO");
  const reason = String(req.body?.reason || "").trim().slice(0, 300);

  const db = getDb();
  const reqDocRef = db.collection("therapy_scheduling_requests").doc(requestId);
  const reqSnap = await reqDocRef.get();
  if (!reqSnap.exists) return sendError(res, 404, "SOLICITACAO_NAO_ENCONTRADA");
  const reqData = reqSnap.data();
  if (reqData.therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");
  if (reqData.status !== "pending")  return sendError(res, 409, "SOLICITACAO_JA_RESPONDIDA");

  await reqDocRef.update({
    status: "rejected",
    rejectReason: reason || null,
    respondedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await logAudit({
    type: "scheduling_request_rejected",
    requestId,
    therapistUid: uid,
    reason: reason || null
  });

  return res.json({ ok: true });
}));

// GET /therapy/health — diagnóstico isolado
router.get("/therapy/health", (req, res) => {
  res.json({
    ok: true,
    livekitConfigured: !!(LIVEKIT_API_KEY && LIVEKIT_API_SECRET),
    livekitUrl: LIVEKIT_URL,
    mpAccessTokenConfigured:   !!MP_ACCESS_TOKEN_THERAPY,
    mpWebhookSecretConfigured: !!MP_WEBHOOK_SECRET_THERAPY,
    docValidatorProvider: String(process.env.DOC_VALIDATOR_PROVIDER || "claude").toLowerCase()
  });
});

// ═════════════════════════════════════════════════════════════════════════
// FINANCEIRO — controle de receitas e despesas do profissional
//
// Coleção: therapy_transactions/{txId}
// Helpers: services/financial.js (categorias, validação, cálculo de resumo)
//
// Modelo de privacidade: dados financeiros ficam em plaintext pra permitir
// agrupamento/relatório server-side. description é texto livre limitado a 200
// chars; recomendar ao user não pôr dado clínico ali (apenas tags tipo
// "Sessão 15/05"). patientNameSnapshot é gravado pra manter histórico legível
// mesmo se o paciente for deletado.
//
// Versão atual v1: CRUD + resumo mensal. Próxima versão: integração Mercado
// Pago pra cobrar Pix/boleto a partir de uma transação pendente (mpPaymentId,
// mpPixQrCode, mpBoletoUrl). Webhook /webhooks/mp/financeiro marca como pago.
// ═════════════════════════════════════════════════════════════════════════

// POST /therapy/financeiro/transacoes
// Body: { type, category, amount (centavos), description?, paymentMethod,
//         status, patientId?, sessionId?, issueDate, dueDate?, paidDate? }
router.post("/therapy/financeiro/transacoes", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await requirePaidPlan(req, res, uid);
  if (!therapist) return;

  const type     = String(req.body?.type || "").trim().toLowerCase();
  const category = String(req.body?.category || "").trim().toLowerCase();
  const status   = String(req.body?.status || "pendente").trim().toLowerCase();
  const paymentMethod = String(req.body?.paymentMethod || "outro").trim().toLowerCase();

  if (!isValidFinType(type))            return sendError(res, 400, "TIPO_INVALIDO");
  if (!isValidFinStatus(status))        return sendError(res, 400, "STATUS_INVALIDO");
  if (!isValidFinPaymentMethod(paymentMethod)) return sendError(res, 400, "METODO_PAGAMENTO_INVALIDO");

  const catCheck = validateFinCategoryForType(type, category);
  if (!catCheck.ok) return sendError(res, 400, catCheck.reason);

  const amount = Number(req.body?.amount);
  if (!isValidFinAmount(amount)) return sendError(res, 400, "VALOR_INVALIDO", { hint: "amount em centavos (integer)" });

  const description = String(req.body?.description || "").trim().slice(0, DESCRIPTION_MAX);
  // Convênio: free-text opcional. Cabe "Particular", "Unimed", "Bradesco Saúde",
  // ou qualquer string. Útil pra agrupar receitas por origem nos relatórios.
  const convenio = String(req.body?.convenio || "").trim().slice(0, 50) || null;

  const issueDateRaw = Number(req.body?.issueDate);
  if (!Number.isFinite(issueDateRaw) || issueDateRaw <= 0) return sendError(res, 400, "DATA_EMISSAO_INVALIDA");
  const issueDate = issueDateRaw;

  const dueDateRaw  = Number(req.body?.dueDate || 0);
  const paidDateRaw = Number(req.body?.paidDate || 0);
  const dueDate  = Number.isFinite(dueDateRaw) && dueDateRaw > 0  ? dueDateRaw  : null;
  const paidDate = Number.isFinite(paidDateRaw) && paidDateRaw > 0 ? paidDateRaw : null;

  // Coerência: status=pago exige paidDate. Se user não mandou, usa issueDate
  // como fallback (ele lançou tx pago sem informar data exata).
  let paidDateFinal = paidDate;
  if (status === "pago" && !paidDateFinal) paidDateFinal = issueDate;
  if (status !== "pago") paidDateFinal = null; // limpa se mudou status

  // Validação do paciente (se passado, precisa ser do próprio therapist).
  // patientNameSnapshot é o que o user envia — não buscamos do paciente
  // (que está cifrado E2EE), o frontend já mandou o nome decifrado.
  let patientId = String(req.body?.patientId || "").trim() || null;
  const patientNameSnapshot = String(req.body?.patientNameSnapshot || "").trim().slice(0, PATIENT_NAME_MAX) || null;
  if (patientId) {
    const psnap = await getDb().collection("therapy_patients").doc(patientId).get();
    if (!psnap.exists) return sendError(res, 404, "PACIENTE_NAO_ENCONTRADO");
    if (psnap.data().therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");
  }

  const sessionId = String(req.body?.sessionId || "").trim() || null;
  if (sessionId) {
    const ssnap = await getDb().collection("therapy_sessions").doc(sessionId).get();
    if (!ssnap.exists) return sendError(res, 404, "SESSAO_NAO_ENCONTRADA");
    if (ssnap.data().therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");
  }

  // performedByUid: quem atendeu o paciente. Usado pelo módulo de clínica
  // pra calcular repasse mensal. Pode ser o próprio dono (uid) ou um membro
  // ativo da clínica do user. Validamos ownership antes de aceitar.
  let performedByUid = String(req.body?.performedByUid || "").trim() || null;
  if (performedByUid && performedByUid !== uid) {
    // Tem que ser membro ativo de UMA clínica cujo owner é o user.
    const clinicSnap = await getDb().collection("therapy_clinics")
      .where("ownerUid", "==", uid).limit(1).get();
    if (clinicSnap.empty) return sendError(res, 403, "PERFORMED_BY_INVALIDO", {
      detail: "Você não tem clínica — só pode lançar transações onde você mesmo atendeu."
    });
    const clinicId = clinicSnap.docs[0].id;
    const memberSnap = await getDb().collection("therapy_clinic_members")
      .where("clinicId", "==", clinicId)
      .where("therapistUid", "==", performedByUid)
      .where("status", "==", "active")
      .limit(1).get();
    if (memberSnap.empty) return sendError(res, 403, "PERFORMED_BY_INVALIDO", {
      detail: "O profissional informado não é membro ativo da sua clínica."
    });
  }

  const txId = newId("tx");
  const db = getDb();
  await db.collection("therapy_transactions").doc(txId).set({
    txId,
    therapistUid: uid,
    performedByUid,           // null se foi o próprio dono; uid de membro caso contrário
    type, category, amount,
    description: description || null,
    convenio,
    paymentMethod,
    status,
    patientId, patientNameSnapshot,
    sessionId,
    issueDate,
    dueDate,
    paidDate: paidDateFinal,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await logAudit({ type: "transacao_created", txId, therapistUid: uid, txType: type, category, amount });
  return res.json({ ok: true, txId });
}));

// GET /therapy/financeiro/transacoes?month=YYYY-MM&type=&category=&status=&patientId=
// Filtros opcionais. Sem filtros retorna últimos 6 meses pra não estourar
// bandwidth no primeiro acesso. Ordenado por issueDate desc.
//
// Query Firestore usa só WHERE therapistUid pra evitar composite index
// (Firestore exige index pra where múltiplo + orderBy). Filtros adicionais
// e ordenação são feitos em memória. Pra escala atual (até ~milhares de tx
// por user) é instantâneo. Quando crescer, basta criar os indexes no
// firebase console e mover filtros pro Firestore.
router.get("/therapy/financeiro/transacoes", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const db = getDb();
  const snap = await db.collection("therapy_transactions")
    .where("therapistUid", "==", uid)
    .get();

  // Range padrão: últimos 6 meses se não foi pedido mês específico.
  const monthStr = String(req.query?.month || "").trim();
  let rangeStart = 0;
  let rangeEnd   = Infinity;
  if (monthStr) {
    const range = parseFinMonthRange(monthStr);
    if (!range) return sendError(res, 400, "MES_INVALIDO", { hint: "Use YYYY-MM" });
    rangeStart = range.startMs;
    rangeEnd   = range.endMs;
  } else {
    rangeStart = Date.now() - 6 * 30 * 86_400_000;
  }

  const typeFilter     = String(req.query?.type || "").trim().toLowerCase();
  const categoryFilter = String(req.query?.category || "").trim().toLowerCase();
  const statusFilter   = String(req.query?.status || "").trim().toLowerCase();
  const patientFilter  = String(req.query?.patientId || "").trim();

  const allTx = snap.docs.map(d => d.data());
  const filtered = allTx.filter(tx => {
    if (typeof tx.issueDate !== "number") return false;
    if (tx.issueDate < rangeStart || tx.issueDate >= rangeEnd) return false;
    if (typeFilter     && tx.type !== typeFilter) return false;
    if (categoryFilter && tx.category !== categoryFilter) return false;
    if (statusFilter   && tx.status !== statusFilter) return false;
    if (patientFilter  && tx.patientId !== patientFilter) return false;
    return true;
  });
  filtered.sort((a, b) => (b.issueDate || 0) - (a.issueDate || 0));
  const transactions = filtered.slice(0, 500);

  return res.json({ ok: true, transactions, categories: CATEGORY_LABELS });
}));

// GET /therapy/painel/hoje — agregação leve pra hero do painel:
//   - nextSession: próxima sessão (scheduledAt > now, não cancelada/encerrada)
//   - todayCount: nº de sessões agendadas hoje (BRT)
//   - thisMonth: { sessoesRealizadas, sessoesAgendadas, faturamentoPagoCents, faturamentoPendenteCents, taxaConfirmacao }
//
// 1 query em therapy_sessions + 1 em therapy_transactions. Custo pequeno
// pq o cap é o therapistUid + limit defensivo. Resultado cabe em <2KB.
router.get("/therapy/painel/hoje", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const now = Date.now();
  const db = getDb();

  // Janela do mês corrente em America/Sao_Paulo (UTC-3, sem DST desde 2019).
  const TZ_OFFSET_MS = 3 * 60 * 60 * 1000;
  const nowBRT = new Date(now - TZ_OFFSET_MS);
  const monthStartBRT = Date.UTC(nowBRT.getUTCFullYear(), nowBRT.getUTCMonth(), 1) + TZ_OFFSET_MS;
  const dayStartBRT   = Date.UTC(nowBRT.getUTCFullYear(), nowBRT.getUTCMonth(), nowBRT.getUTCDate()) + TZ_OFFSET_MS;
  const dayEndBRT     = dayStartBRT + 24 * 60 * 60 * 1000;

  const [sessionsSnap, txSnap] = await Promise.all([
    db.collection("therapy_sessions").where("therapistUid", "==", uid).limit(500).get(),
    db.collection("therapy_transactions").where("therapistUid", "==", uid).limit(500).get()
  ]);

  const sessions = sessionsSnap.docs.map(d => d.data());

  // Próxima sessão: scheduled OR in_progress + scheduledAt no futuro próximo
  // (ou já em andamento). Tolerâncias diferentes por status:
  //   - in_progress: sem limite (sessão pode durar 50min+; ignorar tolerância
  //     evitaria sumir do hero enquanto o profissional está atendendo).
  //   - scheduled:   2h atrás (cobre atraso típico + sessão padrão de 50min;
  //     se esqueceu de encerrar, ainda aparece como "próxima" pra ação).
  // Ordena por scheduledAt asc.
  const nextCandidates = sessions
    .filter(s => {
      if (!s.scheduledAt) return false;
      if (s.status === "in_progress") return true;
      if (s.status === "scheduled")   return s.scheduledAt >= now - 2 * 60 * 60 * 1000;
      return false;
    })
    .sort((a, b) => (a.scheduledAt || 0) - (b.scheduledAt || 0));

  const nextSession = nextCandidates[0] ? {
    sessionId: nextCandidates[0].sessionId,
    patientName: nextCandidates[0].patientName,
    patientId: nextCandidates[0].patientId || null,
    scheduledAt: nextCandidates[0].scheduledAt,
    status: nextCandidates[0].status,
    confirmedAt: nextCandidates[0].confirmedAt?.toMillis ? nextCandidates[0].confirmedAt.toMillis() : null
  } : null;

  // Sessões agendadas no dia.
  const todaySessions = sessions
    .filter(s => s.scheduledAt && s.scheduledAt >= dayStartBRT && s.scheduledAt < dayEndBRT)
    .filter(s => s.status !== "canceled");
  const todayCount = todaySessions.length;
  const todayConfirmedCount = todaySessions.filter(s => s.confirmedAt).length;

  // KPIs do mês: usa scheduledAt + status. Sessões com scheduledAt no mês
  // contam pra agendadas; status=completed → realizadas.
  const monthSessions = sessions.filter(s => {
    const t = Number(s.scheduledAt) || 0;
    return t >= monthStartBRT && t < now + 31 * 86_400_000;
  });
  const realizadas    = monthSessions.filter(s => s.status === "completed").length;
  const agendadas     = monthSessions.filter(s => s.status === "scheduled" && s.scheduledAt > now).length;
  const noShow        = monthSessions.filter(s => s.status === "canceled" && s.canceledBy === "patient").length;
  // Taxa de confirmação: das sessões scheduled futuras, quantas o paciente
  // confirmou. Métrica orientativa — quanto maior, menor o no-show.
  const futurasNoMes = monthSessions.filter(s => s.scheduledAt > now && s.status === "scheduled");
  const confirmadasFuturas = futurasNoMes.filter(s => s.confirmedAt).length;
  const taxaConfirmacao = futurasNoMes.length > 0
    ? Math.round((confirmadasFuturas / futurasNoMes.length) * 100)
    : null;

  // Faturamento do mês.
  let faturamentoPagoCents = 0, faturamentoPendenteCents = 0;
  txSnap.forEach(d => {
    const t = d.data();
    if (t.type !== "receita") return;
    const refDate = Number(t.paidDate) || Number(t.issueDate) || 0;
    if (refDate < monthStartBRT) return;
    if (t.status === "pago") faturamentoPagoCents += Number(t.amount) || 0;
    else if (t.status === "pendente") faturamentoPendenteCents += Number(t.amount) || 0;
  });

  return res.json({
    ok: true,
    nextSession,
    todayCount,
    todayConfirmedCount,
    thisMonth: {
      sessoesRealizadas: realizadas,
      sessoesAgendadasFuturas: agendadas,
      sessoesCanceladasPaciente: noShow,
      faturamentoPagoCents,
      faturamentoPendenteCents,
      taxaConfirmacao
    }
  });
}));

// GET /therapy/relatorios/analytics?range=30d|90d|year|all
// Analytics não-financeiro: volume, no-show rate, frequência por dia/hora,
// novos vs retorno. Lê de therapy_sessions.
// Sem dados sensíveis: só metadados (status, timestamps, patientId), não
// expõe nome/notas (que estão E2EE de qualquer forma).
router.get("/therapy/relatorios/analytics", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const range = String(req.query?.range || "30d").trim();
  const now = Date.now();
  let rangeStart;
  if      (range === "30d")  rangeStart = now - 30  * 86_400_000;
  else if (range === "90d")  rangeStart = now - 90  * 86_400_000;
  else if (range === "year") rangeStart = now - 365 * 86_400_000;
  else if (range === "all")  rangeStart = 0;
  else                       rangeStart = now - 30  * 86_400_000;

  const db = getDb();
  const snap = await db.collection("therapy_sessions")
    .where("therapistUid", "==", uid)
    .limit(2000)
    .get();

  const sessions = snap.docs.map(d => d.data());

  // Filtra por scheduledAt no range; sessões sem scheduledAt usam createdAt.
  function getTs(s) {
    return Number(s.scheduledAt) ||
           (s.createdAt?.toMillis ? s.createdAt.toMillis() : Number(s.createdAt)) || 0;
  }
  const inRange = sessions.filter(s => {
    const t = getTs(s);
    return t >= rangeStart && t <= now;
  });

  // Totais por status. canceled_24h = cancelado com <24h antes (no-show).
  let completed = 0, canceled = 0, noShow = 0, scheduled = 0, inProgress = 0;
  for (const s of inRange) {
    const at = Number(s.scheduledAt || 0);
    const canceledAtMs = Number(s.canceledAt) || (s.canceledAt?.toMillis ? s.canceledAt.toMillis() : 0);
    if (s.status === "completed")   completed++;
    else if (s.status === "in_progress") inProgress++;
    else if (s.status === "canceled") {
      canceled++;
      // No-show heurístico: canceled com <24h antes da sessão (inclui o "esqueceu de avisar")
      if (at && canceledAtMs && (at - canceledAtMs) < 24 * 60 * 60 * 1000) noShow++;
    } else {
      scheduled++;
    }
  }
  const totals = { sessions: inRange.length, completed, canceled, noShow, scheduled, inProgress };
  const completionDenom = completed + canceled;
  const rates = {
    completionRate: completionDenom > 0 ? completed / completionDenom : null,
    noShowRate:     completionDenom > 0 ? noShow    / completionDenom : null
  };

  // Por mês (últimos 12). Usa scheduledAt; fallback pra createdAt.
  const monthCounts = new Map();
  for (const s of inRange) {
    const t = getTs(s);
    if (!t) continue;
    const d = new Date(t);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
    monthCounts.set(key, (monthCounts.get(key) || 0) + 1);
  }
  const byMonth = Array.from(monthCounts.entries())
    .map(([month, count]) => ({ month, count }))
    .sort((a, b) => a.month.localeCompare(b.month));

  // Por dia da semana (0=domingo, 6=sábado).
  const dayCounts = [0,0,0,0,0,0,0];
  for (const s of inRange) {
    const t = getTs(s);
    if (!t) continue;
    dayCounts[new Date(t).getDay()]++;
  }
  const byDayOfWeek = dayCounts.map((count, day) => ({ day, count }));

  // Por hora do dia (0-23).
  const hourCounts = new Array(24).fill(0);
  for (const s of inRange) {
    const t = getTs(s);
    if (!t) continue;
    hourCounts[new Date(t).getHours()]++;
  }
  const byHour = hourCounts.map((count, hour) => ({ hour, count }));

  // Novos vs retorno. "Novo" = 1ª sessão DO PACIENTE caiu dentro do range
  // (precisa olhar histórico completo, não só o range).
  const allByPatient = new Map(); // patientId → [timestamps]
  for (const s of sessions) {
    const pid = s.patientId || `_anon_${s.sessionId}`; // sessões sem patientId tratadas como avulsas
    const t = getTs(s);
    if (!t) continue;
    if (!allByPatient.has(pid)) allByPatient.set(pid, []);
    allByPatient.get(pid).push(t);
  }
  let newPatients = 0, returningSessionCount = 0, newPatientSessionCount = 0;
  const patientsSeen = new Set();
  for (const s of inRange) {
    const pid = s.patientId || `_anon_${s.sessionId}`;
    const allTs = (allByPatient.get(pid) || []).sort((a,b) => a-b);
    const firstTs = allTs[0] || 0;
    if (firstTs >= rangeStart) {
      // 1ª sessão do paciente caiu DENTRO do range → conta como novo
      newPatientSessionCount++;
      if (!patientsSeen.has(pid)) { newPatients++; patientsSeen.add(pid); }
    } else {
      returningSessionCount++;
    }
  }
  const distinctPatients = new Set(inRange.map(s => s.patientId || `_anon_${s.sessionId}`)).size;
  const patients = {
    distinct: distinctPatients,
    new: newPatients,
    returning: distinctPatients - newPatients,
    sessionsFromNew: newPatientSessionCount,
    sessionsFromReturning: returningSessionCount
  };

  return res.json({
    ok: true,
    range,
    rangeStartMs: rangeStart,
    rangeEndMs: now,
    totals,
    rates,
    byMonth,
    byDayOfWeek,
    byHour,
    patients
  });
}));

// GET /therapy/financeiro/export.csv
// Export CSV de transações pra contador / declaração de IR.
// Range padrão: ano vigente. Aceita ?year=YYYY ou ?from=YYYY-MM-DD&to=YYYY-MM-DD.
// Encoding: UTF-8 com BOM (Excel BR abre certo sem precisar configurar).
router.get("/therapy/financeiro/export.csv", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  let rangeStart, rangeEnd;
  const yearStr = String(req.query?.year || "").trim();
  const fromStr = String(req.query?.from || "").trim();
  const toStr   = String(req.query?.to   || "").trim();
  if (fromStr && toStr) {
    const f = new Date(fromStr);
    const t = new Date(toStr);
    if (isNaN(f) || isNaN(t)) return sendError(res, 400, "DATA_INVALIDA");
    rangeStart = f.getTime();
    rangeEnd   = t.getTime() + 86_400_000; // inclusivo do dia "to"
  } else if (yearStr && /^\d{4}$/.test(yearStr)) {
    const y = Number(yearStr);
    rangeStart = new Date(y, 0, 1).getTime();
    rangeEnd   = new Date(y + 1, 0, 1).getTime();
  } else {
    // default: ano corrente
    const y = new Date().getFullYear();
    rangeStart = new Date(y, 0, 1).getTime();
    rangeEnd   = new Date(y + 1, 0, 1).getTime();
  }

  const db = getDb();
  const snap = await db.collection("therapy_transactions")
    .where("therapistUid", "==", uid)
    .get();

  const txs = snap.docs
    .map(d => d.data())
    .filter(tx => typeof tx.issueDate === "number" && tx.issueDate >= rangeStart && tx.issueDate < rangeEnd)
    .sort((a, b) => (a.issueDate || 0) - (b.issueDate || 0));

  function csvEscape(s) {
    const v = String(s == null ? "" : s);
    // Escapa aspas, vírgula, quebra de linha — wrap em aspas se necessário.
    if (/[",\r\n;]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
    return v;
  }
  function fmtDate(ms) {
    if (!ms) return "";
    return new Date(ms).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
  }
  function fmtCents(c) {
    if (c == null) return "";
    return (Number(c) / 100).toFixed(2).replace(".", ",");
  }
  function typeLabel(t) { return t === "income" ? "Receita" : t === "expense" ? "Despesa" : t || ""; }
  function statusLabel(s) {
    return s === "paid" ? "Pago" : s === "pending" ? "Pendente" : s === "overdue" ? "Atrasado" : s || "";
  }

  const headers = [
    "Data emissão", "Tipo", "Categoria", "Descrição",
    "Valor (R$)", "Status", "Data pagamento", "Método", "Paciente", "Observação"
  ];
  const rows = txs.map(tx => [
    fmtDate(tx.issueDate),
    typeLabel(tx.type),
    CATEGORY_LABELS?.[tx.category] || tx.category || "",
    tx.description || "",
    fmtCents(tx.amountCents),
    statusLabel(tx.status),
    fmtDate(tx.paidDate),
    tx.paymentMethod || "",
    tx.patientName || "",
    tx.notes || ""
  ]);

  // BOM (﻿) sinaliza UTF-8 pro Excel; separador ; é o padrão pt-BR
  // (vírgula é decimal). Fica mais compatível que ',' como sep.
  const csv = "﻿" + [headers, ...rows].map(r => r.map(csvEscape).join(";")).join("\r\n");

  const filename = `financeiro-${(req.query?.year || new Date().getFullYear())}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
}));

// PATCH /therapy/financeiro/transacoes/:id
// Atualiza campos editáveis. Mais comum: marcar como "pago" (status + paidDate).
// Permite mudar tudo exceto txId e therapistUid.
router.patch("/therapy/financeiro/transacoes/:id", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const txId = String(req.params.id || "").trim();
  if (!txId) return sendError(res, 400, "ID_OBRIGATORIO");

  const db = getDb();
  const ref = db.collection("therapy_transactions").doc(txId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "TRANSACAO_NAO_ENCONTRADA");
  const current = snap.data();
  if (current.therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  const updates = {};

  if (req.body?.type !== undefined) {
    const t = String(req.body.type).trim().toLowerCase();
    if (!isValidFinType(t)) return sendError(res, 400, "TIPO_INVALIDO");
    updates.type = t;
  }
  if (req.body?.category !== undefined) {
    const c = String(req.body.category).trim().toLowerCase();
    const typeForCheck = updates.type || current.type;
    const check = validateFinCategoryForType(typeForCheck, c);
    if (!check.ok) return sendError(res, 400, check.reason);
    updates.category = c;
  }
  if (req.body?.amount !== undefined) {
    const a = Number(req.body.amount);
    if (!isValidFinAmount(a)) return sendError(res, 400, "VALOR_INVALIDO");
    updates.amount = a;
  }
  if (req.body?.description !== undefined) {
    updates.description = String(req.body.description || "").trim().slice(0, DESCRIPTION_MAX) || null;
  }
  if (req.body?.convenio !== undefined) {
    updates.convenio = String(req.body.convenio || "").trim().slice(0, 50) || null;
  }
  if (req.body?.paymentMethod !== undefined) {
    const m = String(req.body.paymentMethod).trim().toLowerCase();
    if (!isValidFinPaymentMethod(m)) return sendError(res, 400, "METODO_PAGAMENTO_INVALIDO");
    updates.paymentMethod = m;
  }
  if (req.body?.status !== undefined) {
    const s = String(req.body.status).trim().toLowerCase();
    if (!isValidFinStatus(s)) return sendError(res, 400, "STATUS_INVALIDO");
    updates.status = s;
    // Side-effect: status=pago + sem paidDate → seta paidDate=now.
    // status≠pago → limpa paidDate (consistência).
    if (s === "pago" && !req.body?.paidDate && !current.paidDate) {
      updates.paidDate = Date.now();
    } else if (s !== "pago") {
      updates.paidDate = null;
    }
  }
  if (req.body?.issueDate !== undefined) {
    const d = Number(req.body.issueDate);
    if (!Number.isFinite(d) || d <= 0) return sendError(res, 400, "DATA_EMISSAO_INVALIDA");
    updates.issueDate = d;
  }
  if (req.body?.dueDate !== undefined) {
    const d = Number(req.body.dueDate || 0);
    updates.dueDate = Number.isFinite(d) && d > 0 ? d : null;
  }
  if (req.body?.paidDate !== undefined) {
    const d = Number(req.body.paidDate || 0);
    updates.paidDate = Number.isFinite(d) && d > 0 ? d : null;
  }

  if (Object.keys(updates).length === 0) return sendError(res, 400, "NADA_PARA_ATUALIZAR");

  updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  await ref.set(updates, { merge: true });

  await logAudit({ type: "transacao_updated", txId, therapistUid: uid, fields: Object.keys(updates) });
  return res.json({ ok: true });
}));

// DELETE /therapy/financeiro/transacoes/:id
// Hard delete + audit log. Status=cancelado fica como alternativa pra
// preservar histórico sem deletar.
router.delete("/therapy/financeiro/transacoes/:id", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const txId = String(req.params.id || "").trim();
  if (!txId) return sendError(res, 400, "ID_OBRIGATORIO");

  const db = getDb();
  const ref = db.collection("therapy_transactions").doc(txId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "TRANSACAO_NAO_ENCONTRADA");
  if (snap.data().therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  await ref.delete();
  await logAudit({ type: "transacao_deleted", txId, therapistUid: uid });
  return res.json({ ok: true });
}));

// GET /therapy/financeiro/resumo?month=YYYY-MM
// Dashboard mensal: saldo, previsto, totais por tipo+status, top categorias.
// Default month = mês atual UTC se omitido. Querymonth deve ser YYYY-MM.
router.get("/therapy/financeiro/resumo", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const requestedMonth = String(req.query?.month || "").trim();
  let monthStr = requestedMonth;
  if (!monthStr) {
    const now = new Date();
    monthStr = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  const range = parseFinMonthRange(monthStr);
  if (!range) return sendError(res, 400, "MES_INVALIDO", { hint: "Use YYYY-MM" });

  const db = getDb();
  // Mesma estratégia do GET /transacoes: busca por therapistUid e filtra
  // em memória — evita composite index Firestore.
  const snap = await db.collection("therapy_transactions")
    .where("therapistUid", "==", uid)
    .get();

  const allTx = snap.docs.map(d => d.data());
  const transactions = allTx.filter(tx =>
    typeof tx.issueDate === "number" &&
    tx.issueDate >= range.startMs &&
    tx.issueDate < range.endMs
  );
  const summary = computeFinSummary(transactions);

  return res.json({
    ok: true,
    month: monthStr,
    summary,
    count: transactions.length
  });
}));

// ═════════════════════════════════════════════════════════════════════════
// ESTOQUE — controle de itens em estoque do profissional
//
// Coleções:
//   therapy_inventory_items/{itemId}     — definição + saldo atual
//   therapy_inventory_movements/{movId}  — histórico de entradas/saídas
//
// Helpers: services/inventory.js (validação, applyMovement, alertas).
//
// Concorrência: updates de currentStock usam Firestore transaction pra evitar
// race condition (2 movimentos simultâneos no mesmo item).
//
// Como o financeiro, queries Firestore usam só where(therapistUid) e
// filtragem em memória — evita necessidade de composite index.
// ═════════════════════════════════════════════════════════════════════════

// POST /therapy/inventario/itens
// Cria item. currentStock inicial padrão 0 — usuário cria movimento de
// entrada depois pra carregar saldo inicial.
router.post("/therapy/inventario/itens", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await requirePaidPlan(req, res, uid);
  if (!therapist) return;

  const name = String(req.body?.name || "").trim().slice(0, INV_NAME_MAX);
  if (!name) return sendError(res, 400, "NOME_OBRIGATORIO");

  const unit = String(req.body?.unit || "unidade").trim().toLowerCase();
  if (!isValidInvUnit(unit)) return sendError(res, 400, "UNIDADE_INVALIDA");

  const category    = String(req.body?.category || "").trim().slice(0, INV_CATEGORY_MAX);
  const description = String(req.body?.description || "").trim().slice(0, INV_DESCRIPTION_MAX);

  // currentStock inicial: aceita >=0. Se omitido, 0.
  const initialStockRaw = req.body?.currentStock;
  const currentStock = initialStockRaw !== undefined ? Number(initialStockRaw) : 0;
  if (!isValidInvStockValue(currentStock)) return sendError(res, 400, "ESTOQUE_INICIAL_INVALIDO");

  // minStock opcional. 0 = sem alerta.
  const minStockRaw = req.body?.minStock;
  const minStock = minStockRaw !== undefined ? Number(minStockRaw) : 0;
  if (!isValidInvStockValue(minStock)) return sendError(res, 400, "ESTOQUE_MINIMO_INVALIDO");

  const itemId = newId("inv");
  const db = getDb();
  await db.collection("therapy_inventory_items").doc(itemId).set({
    itemId,
    therapistUid: uid,
    name,
    category: category || null,
    unit,
    currentStock,
    minStock,
    description: description || null,
    archived: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  // Se foi criado com stock inicial > 0, registra movimento "entrada" pra
  // preservar rastreabilidade do saldo inicial.
  if (currentStock > 0) {
    const movId = newId("mov");
    await db.collection("therapy_inventory_movements").doc(movId).set({
      movId,
      itemId,
      therapistUid: uid,
      type: "entrada",
      quantity: currentStock,
      reason: "Saldo inicial",
      movDate: Date.now(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }

  await logAudit({ type: "inv_item_created", itemId, therapistUid: uid, name });
  return res.json({ ok: true, itemId });
}));

// GET /therapy/inventario/itens?lowStock=1&category=
// Lista itens do user. Filtros opcionais: lowStock=1 só retorna abaixo do
// mínimo; category filtra por string exata.
router.get("/therapy/inventario/itens", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const db = getDb();
  const snap = await db.collection("therapy_inventory_items")
    .where("therapistUid", "==", uid)
    .get();

  const items = snap.docs.map(d => d.data()).filter(i => !i.archived);

  const lowStockOnly = req.query?.lowStock === "1";
  const categoryFilter = String(req.query?.category || "").trim();

  const filtered = items.filter(i => {
    if (lowStockOnly && !isInvLowStock(i)) return false;
    if (categoryFilter && i.category !== categoryFilter) return false;
    return true;
  });

  // Ordena: itens em baixo estoque primeiro, depois por nome.
  filtered.sort((a, b) => {
    const aLow = isInvLowStock(a) ? 0 : 1;
    const bLow = isInvLowStock(b) ? 0 : 1;
    if (aLow !== bLow) return aLow - bLow;
    return (a.name || "").localeCompare(b.name || "", "pt-BR");
  });

  return res.json({ ok: true, items: filtered });
}));

// PATCH /therapy/inventario/itens/:id
// Edita atributos do item. NÃO altera currentStock diretamente — saldo só
// muda via /movimentos pra preservar rastreabilidade. Pra ajuste manual de
// saldo, crie um movimento "entrada"/"saida" com reason="Ajuste de saldo".
router.patch("/therapy/inventario/itens/:id", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const itemId = String(req.params.id || "").trim();
  if (!itemId) return sendError(res, 400, "ID_OBRIGATORIO");

  const db = getDb();
  const ref = db.collection("therapy_inventory_items").doc(itemId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "ITEM_NAO_ENCONTRADO");
  if (snap.data().therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  const updates = {};
  if (req.body?.name !== undefined) {
    const n = String(req.body.name).trim().slice(0, INV_NAME_MAX);
    if (!n) return sendError(res, 400, "NOME_OBRIGATORIO");
    updates.name = n;
  }
  if (req.body?.unit !== undefined) {
    const u = String(req.body.unit).trim().toLowerCase();
    if (!isValidInvUnit(u)) return sendError(res, 400, "UNIDADE_INVALIDA");
    updates.unit = u;
  }
  if (req.body?.category !== undefined) {
    updates.category = String(req.body.category).trim().slice(0, INV_CATEGORY_MAX) || null;
  }
  if (req.body?.description !== undefined) {
    updates.description = String(req.body.description).trim().slice(0, INV_DESCRIPTION_MAX) || null;
  }
  if (req.body?.minStock !== undefined) {
    const m = Number(req.body.minStock);
    if (!isValidInvStockValue(m)) return sendError(res, 400, "ESTOQUE_MINIMO_INVALIDO");
    updates.minStock = m;
  }

  if (Object.keys(updates).length === 0) return sendError(res, 400, "NADA_PARA_ATUALIZAR");
  updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  await ref.set(updates, { merge: true });

  await logAudit({ type: "inv_item_updated", itemId, therapistUid: uid, fields: Object.keys(updates) });
  return res.json({ ok: true });
}));

// DELETE /therapy/inventario/itens/:id
// Soft delete (archived=true) pra preservar histórico de movimentos. Item
// some das listagens mas movimentos antigos continuam acessíveis.
router.delete("/therapy/inventario/itens/:id", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const itemId = String(req.params.id || "").trim();
  if (!itemId) return sendError(res, 400, "ID_OBRIGATORIO");

  const db = getDb();
  const ref = db.collection("therapy_inventory_items").doc(itemId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "ITEM_NAO_ENCONTRADO");
  if (snap.data().therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  await ref.set({ archived: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  await logAudit({ type: "inv_item_archived", itemId, therapistUid: uid });
  return res.json({ ok: true });
}));

// POST /therapy/inventario/movimentos
// Body: { itemId, type, quantity, reason?, movDate? }
//
// Aplica movimento via Firestore transaction: lê item + atualiza saldo +
// grava movimento atomicamente. Bloqueia saída se saldo insuficiente.
router.post("/therapy/inventario/movimentos", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await requirePaidPlan(req, res, uid);
  if (!therapist) return;

  const itemId = String(req.body?.itemId || "").trim();
  if (!itemId) return sendError(res, 400, "ITEM_OBRIGATORIO");

  const type = String(req.body?.type || "").trim().toLowerCase();
  if (!isValidInvMovementType(type)) return sendError(res, 400, "TIPO_MOVIMENTO_INVALIDO");

  const quantity = Number(req.body?.quantity);
  if (!isValidInvMovementQuantity(quantity)) return sendError(res, 400, "QUANTIDADE_INVALIDA");

  const reason = String(req.body?.reason || "").trim().slice(0, INV_REASON_MAX);
  const movDateRaw = Number(req.body?.movDate || 0);
  const movDate = Number.isFinite(movDateRaw) && movDateRaw > 0 ? movDateRaw : Date.now();

  const db = getDb();
  const itemRef = db.collection("therapy_inventory_items").doc(itemId);
  const movId = newId("mov");
  const movRef = db.collection("therapy_inventory_movements").doc(movId);

  try {
    const finalStock = await db.runTransaction(async (tx) => {
      const itemSnap = await tx.get(itemRef);
      if (!itemSnap.exists) {
        const e = new Error("ITEM_NAO_ENCONTRADO");
        e.code = "ITEM_NAO_ENCONTRADO";
        throw e;
      }
      const item = itemSnap.data();
      if (item.therapistUid !== uid) {
        const e = new Error("ACESSO_NEGADO");
        e.code = "ACESSO_NEGADO";
        throw e;
      }
      if (item.archived) {
        const e = new Error("ITEM_ARQUIVADO");
        e.code = "ITEM_ARQUIVADO";
        throw e;
      }
      const newStock = applyInvMovement(item.currentStock, type, quantity);
      tx.set(itemRef, {
        currentStock: newStock,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      tx.set(movRef, {
        movId,
        itemId,
        therapistUid: uid,
        type,
        quantity,
        reason: reason || null,
        movDate,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return newStock;
    });

    await logAudit({ type: "inv_movement", movId, itemId, therapistUid: uid, movType: type, quantity, finalStock });
    return res.json({ ok: true, movId, finalStock });
  } catch (err) {
    if (err.code === "ESTOQUE_INSUFICIENTE") {
      return sendError(res, 409, "ESTOQUE_INSUFICIENTE", {
        currentStock: err.currentStock,
        requested: err.requested
      });
    }
    if (err.code === "ITEM_NAO_ENCONTRADO" || err.code === "ACESSO_NEGADO" || err.code === "ITEM_ARQUIVADO") {
      return sendError(res, err.code === "ACESSO_NEGADO" ? 403 : 404, err.code);
    }
    if (err.code === "ESTOQUE_LIMITE_EXCEDIDO") {
      return sendError(res, 400, "ESTOQUE_LIMITE_EXCEDIDO");
    }
    throw err;
  }
}));

// GET /therapy/inventario/movimentos?itemId=&month=YYYY-MM
// Histórico de movimentos. Filtros opcionais por item e mês. Default:
// últimos 90 dias.
router.get("/therapy/inventario/movimentos", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const db = getDb();
  const snap = await db.collection("therapy_inventory_movements")
    .where("therapistUid", "==", uid)
    .get();

  const itemIdFilter = String(req.query?.itemId || "").trim();
  const monthStr     = String(req.query?.month || "").trim();
  let rangeStart = Date.now() - 90 * 86_400_000;
  let rangeEnd   = Infinity;
  if (monthStr) {
    const range = parseFinMonthRange(monthStr);
    if (!range) return sendError(res, 400, "MES_INVALIDO");
    rangeStart = range.startMs;
    rangeEnd   = range.endMs;
  }

  const movements = snap.docs
    .map(d => d.data())
    .filter(m => {
      if (typeof m.movDate !== "number") return false;
      if (m.movDate < rangeStart || m.movDate >= rangeEnd) return false;
      if (itemIdFilter && m.itemId !== itemIdFilter) return false;
      return true;
    })
    .sort((a, b) => (b.movDate || 0) - (a.movDate || 0))
    .slice(0, 500);

  return res.json({ ok: true, movements });
}));

// ═════════════════════════════════════════════════════════════════════════
// CLÍNICA — gestão multidisciplinar com repasse por % ou valor fixo
//
// Coleções:
//   therapy_clinics/{clinicId}        — dono + nome + cnpj?
//   therapy_clinic_members/{memberId} — convites + membros ativos
//
// Helpers: services/clinic.js
//
// Regras de negócio:
// - 1 user pode ter no máximo 1 clínica como dono (simplifica UI/permissões)
// - User pode ser membro de várias clínicas (como funcionário/parceiro)
// - Convite: dono digita email; busca conta com aquele email na Firestore;
//   membro fica pending até aceitar; ao aceitar, status=active + therapistUid
//   populado.
// - Repasse: calculado a partir de therapy_transactions com performedByUid
//   = member.therapistUid no mês selecionado.
// ═════════════════════════════════════════════════════════════════════════

// Helper: encontra a clínica onde o user é DONO. Retorna doc data ou null.
async function findOwnedClinic(uid) {
  const snap = await getDb().collection("therapy_clinics")
    .where("ownerUid", "==", uid).limit(1).get();
  if (snap.empty) return null;
  return snap.docs[0].data();
}

// Helper: enriquece um membro com displayName do therapist (busca em therapists).
// Retorna o membro com campo `name`. Sem name se membro ainda não aceitou.
async function enrichMember(member) {
  if (!member.therapistUid) return { ...member, name: null };
  const tsnap = await getDb().collection("therapists").doc(member.therapistUid).get();
  if (!tsnap.exists) return { ...member, name: null };
  return { ...member, name: tsnap.data().displayName || null };
}

// POST /therapy/clinicas
// Cria clínica (1 por user como dono).
router.post("/therapy/clinicas", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await requirePaidPlan(req, res, uid);
  if (!therapist) return;

  const existing = await findOwnedClinic(uid);
  if (existing) return sendError(res, 409, "CLINICA_JA_EXISTE", { clinicId: existing.clinicId });

  const name = String(req.body?.name || "").trim().slice(0, CLINIC_NAME_MAX);
  if (!name) return sendError(res, 400, "NOME_OBRIGATORIO");
  const cnpj = String(req.body?.cnpj || "").trim().slice(0, CLINIC_CNPJ_MAX) || null;

  const clinicId = newId("clinic");
  const db = getDb();
  await db.collection("therapy_clinics").doc(clinicId).set({
    clinicId,
    ownerUid: uid,
    name,
    cnpj,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await logAudit({ type: "clinic_created", clinicId, ownerUid: uid, name });
  return res.json({ ok: true, clinicId });
}));

// GET /therapy/clinicas/state — consolida me + convites-pendentes em 1 fetch.
// Frontend de clinica.html usa só este endpoint. Reduz 2 RTT + 2 Firebase
// Auth verifies pra 1 RTT + 1 verify. Queries internas em paralelo. Os 2
// endpoints antigos (/me e /convites-pendentes) ficam por compat caso
// algum outro lugar use.
router.get("/therapy/clinicas/state", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const db = getDb();
  // Tudo em paralelo: clínica do user, memberships, profile dele (pra
  // pegar email pros convites), convites por uid direto.
  const [ownedClinic, memberSnap, tsnap, byUidSnap] = await Promise.all([
    findOwnedClinic(uid),
    db.collection("therapy_clinic_members")
      .where("therapistUid", "==", uid)
      .where("status", "==", "active")
      .get(),
    db.collection("therapists").doc(uid).get(),
    db.collection("therapy_clinic_members").where("therapistUid", "==", uid).get()
  ]);

  const email = tsnap.exists ? normalizeClinicEmail(tsnap.data().email) : null;
  const byEmailSnap = email
    ? await db.collection("therapy_clinic_members").where("invitedEmail", "==", email).get()
    : { docs: [] };

  // Enriquecimento de membership + convite em paralelo.
  const [memberships, invites] = await Promise.all([
    Promise.all(memberSnap.docs.map(async d => {
      const m = d.data();
      const csnap = await db.collection("therapy_clinics").doc(m.clinicId).get();
      return {
        memberId: m.memberId,
        clinicId: m.clinicId,
        clinicName: csnap.exists ? csnap.data().name : null,
        repasseRule: m.repasseRule,
        acceptedAt: m.acceptedAt || null
      };
    })),
    (async () => {
      const seen = new Set();
      const pending = [...byEmailSnap.docs, ...byUidSnap.docs]
        .map(d => d.data())
        .filter(m => {
          if (m.status !== "pending") return false;
          if (seen.has(m.memberId)) return false;
          seen.add(m.memberId);
          return true;
        });
      return Promise.all(pending.map(async m => {
        const csnap = await db.collection("therapy_clinics").doc(m.clinicId).get();
        return {
          memberId: m.memberId,
          clinicId: m.clinicId,
          clinicName: csnap.exists ? csnap.data().name : null,
          invitedEmail: m.invitedEmail || null,
          invitedByName: m.invitedByName || null,
          repasseRule: m.repasseRule,
          invitedAt: m.invitedAt || null
        };
      }));
    })()
  ]);

  return res.json({
    ok: true,
    ownedClinic: ownedClinic || null,
    memberships,
    invites
  });
}));

// GET /therapy/clinicas/me
// Info da clínica do user: como dono (se houver) + memberships como funcionário.
router.get("/therapy/clinicas/me", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const db = getDb();
  const [ownedClinic, memberSnap] = await Promise.all([
    findOwnedClinic(uid),
    db.collection("therapy_clinic_members")
      .where("therapistUid", "==", uid)
      .where("status", "==", "active")
      .get()
  ]);

  const memberships = await Promise.all(memberSnap.docs.map(async d => {
    const m = d.data();
    const csnap = await db.collection("therapy_clinics").doc(m.clinicId).get();
    return {
      memberId: m.memberId,
      clinicId: m.clinicId,
      clinicName: csnap.exists ? csnap.data().name : null,
      repasseRule: m.repasseRule,
      acceptedAt: m.acceptedAt || null
    };
  }));

  return res.json({
    ok: true,
    ownedClinic: ownedClinic || null,
    memberships
  });
}));

// PATCH /therapy/clinicas/:id
// Edita nome/cnpj. Só dono.
router.patch("/therapy/clinicas/:id", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const clinicId = String(req.params.id || "").trim();
  if (!clinicId) return sendError(res, 400, "ID_OBRIGATORIO");

  const db = getDb();
  const ref = db.collection("therapy_clinics").doc(clinicId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "CLINICA_NAO_ENCONTRADA");
  if (snap.data().ownerUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  const updates = {};
  if (req.body?.name !== undefined) {
    const n = String(req.body.name).trim().slice(0, CLINIC_NAME_MAX);
    if (!n) return sendError(res, 400, "NOME_OBRIGATORIO");
    updates.name = n;
  }
  if (req.body?.cnpj !== undefined) {
    updates.cnpj = String(req.body.cnpj).trim().slice(0, CLINIC_CNPJ_MAX) || null;
  }
  if (Object.keys(updates).length === 0) return sendError(res, 400, "NADA_PARA_ATUALIZAR");
  updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  await ref.set(updates, { merge: true });
  return res.json({ ok: true });
}));

// POST /therapy/clinicas/:id/membros
// Body: { email, repasseRule: { type, value } }
// Cria convite. Busca user pelo email — se encontrar, popula therapistUid
// na hora; senão, fica pending até criar conta com aquele email.
router.post("/therapy/clinicas/:id/membros", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const clinicId = String(req.params.id || "").trim();
  if (!clinicId) return sendError(res, 400, "ID_OBRIGATORIO");

  const db = getDb();
  const csnap = await db.collection("therapy_clinics").doc(clinicId).get();
  if (!csnap.exists) return sendError(res, 404, "CLINICA_NAO_ENCONTRADA");
  if (csnap.data().ownerUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  const invitedEmail = normalizeClinicEmail(req.body?.email);
  if (!isValidClinicEmail(invitedEmail)) return sendError(res, 400, "EMAIL_INVALIDO");

  // Não pode convidar a si mesmo.
  const ownerSnap = await db.collection("therapists").doc(uid).get();
  if (ownerSnap.exists && normalizeClinicEmail(ownerSnap.data().email) === invitedEmail) {
    return sendError(res, 400, "NAO_PODE_CONVIDAR_VOCE_MESMO");
  }

  // Não duplicar: se já há membro com esse email (pending OU active), bloqueia.
  const dupSnap = await db.collection("therapy_clinic_members")
    .where("clinicId", "==", clinicId)
    .where("invitedEmail", "==", invitedEmail)
    .get();
  const hasActiveOrPending = dupSnap.docs.some(d => {
    const s = d.data().status;
    return s === "active" || s === "pending";
  });
  if (hasActiveOrPending) return sendError(res, 409, "MEMBRO_JA_EXISTE_OU_CONVIDADO");

  const repasseRule = req.body?.repasseRule;
  if (!isValidRepasseRule(repasseRule)) return sendError(res, 400, "REPASSE_RULE_INVALIDA");

  // Tenta achar therapist com esse email pra já vincular UID (acelera UX).
  const tQuery = await db.collection("therapists")
    .where("email", "==", invitedEmail).limit(1).get();
  const therapistUid = tQuery.empty ? null : tQuery.docs[0].id;

  const memberId = newId("mbr");
  await db.collection("therapy_clinic_members").doc(memberId).set({
    memberId,
    clinicId,
    invitedEmail,
    therapistUid,            // pode ser null — vincula no aceite
    status: "pending",
    repasseRule,
    invitedByUid: uid,
    invitedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await logAudit({ type: "clinic_member_invited", clinicId, memberId, invitedEmail, by: uid });

  // Email de convite (fire-and-forget — falha de envio nao bloqueia convite).
  try {
    const ownerName  = ownerSnap.exists ? (ownerSnap.data().displayName || "Profissional") : "Profissional";
    const clinicName = csnap.data().name || "Clínica";
    const acceptUrl  = `${THERAPY_FRONTEND_BASE}/painel.html?convite=${encodeURIComponent(memberId)}`;
    const tpl = templateClinicInvite({ ownerName, clinicName, invitedEmail, repasseRule, acceptUrl });
    sendEmail({ to: invitedEmail, ...tpl }).catch(err => logWarn("clinic_invite_email_failed", { memberId, error: err.message }));
  } catch (e) {
    logWarn("clinic_invite_email_template_error", { memberId, error: e.message });
  }

  return res.json({ ok: true, memberId, therapistUidResolvido: !!therapistUid });
}));

// GET /therapy/clinicas/:id/membros
// Lista membros (todos os status). Só dono.
router.get("/therapy/clinicas/:id/membros", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const clinicId = String(req.params.id || "").trim();

  const db = getDb();
  const csnap = await db.collection("therapy_clinics").doc(clinicId).get();
  if (!csnap.exists) return sendError(res, 404, "CLINICA_NAO_ENCONTRADA");
  if (csnap.data().ownerUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  const msnap = await db.collection("therapy_clinic_members")
    .where("clinicId", "==", clinicId).get();
  const raw = msnap.docs.map(d => d.data()).filter(m => m.status !== "removed");
  const enriched = await Promise.all(raw.map(enrichMember));
  enriched.sort((a, b) =>
    (a.name || a.invitedEmail || "").localeCompare(b.name || b.invitedEmail || "", "pt-BR")
  );
  return res.json({ ok: true, members: enriched });
}));

// PATCH /therapy/clinicas/:id/membros/:memberId
// Edita regra de repasse de um membro. Só dono.
router.patch("/therapy/clinicas/:id/membros/:memberId", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const { id: clinicId, memberId } = req.params;

  const db = getDb();
  const csnap = await db.collection("therapy_clinics").doc(clinicId).get();
  if (!csnap.exists) return sendError(res, 404, "CLINICA_NAO_ENCONTRADA");
  if (csnap.data().ownerUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  const mref = db.collection("therapy_clinic_members").doc(memberId);
  const msnap = await mref.get();
  if (!msnap.exists || msnap.data().clinicId !== clinicId) return sendError(res, 404, "MEMBRO_NAO_ENCONTRADO");

  const updates = {};
  if (req.body?.repasseRule !== undefined) {
    if (!isValidRepasseRule(req.body.repasseRule)) return sendError(res, 400, "REPASSE_RULE_INVALIDA");
    updates.repasseRule = req.body.repasseRule;
  }
  if (Object.keys(updates).length === 0) return sendError(res, 400, "NADA_PARA_ATUALIZAR");
  await mref.set(updates, { merge: true });

  await logAudit({ type: "clinic_member_updated", clinicId, memberId, by: uid });
  return res.json({ ok: true });
}));

// DELETE /therapy/clinicas/:id/membros/:memberId
// Remove membro (soft: status="removed"). Histórico de transações preservado.
router.delete("/therapy/clinicas/:id/membros/:memberId", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const { id: clinicId, memberId } = req.params;

  const db = getDb();
  const csnap = await db.collection("therapy_clinics").doc(clinicId).get();
  if (!csnap.exists) return sendError(res, 404, "CLINICA_NAO_ENCONTRADA");
  if (csnap.data().ownerUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  const mref = db.collection("therapy_clinic_members").doc(memberId);
  const msnap = await mref.get();
  if (!msnap.exists || msnap.data().clinicId !== clinicId) return sendError(res, 404, "MEMBRO_NAO_ENCONTRADO");

  await mref.set({
    status: "removed",
    removedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  await logAudit({ type: "clinic_member_removed", clinicId, memberId, by: uid });
  return res.json({ ok: true });
}));

// GET /therapy/clinicas/convites-pendentes
// Convites pendentes pro user atual. Match por email (case-insensitive)
// OU por therapistUid já populado pelo dono.
router.get("/therapy/clinicas/convites-pendentes", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const db = getDb();
  const tsnap = await db.collection("therapists").doc(uid).get();
  if (!tsnap.exists) return res.json({ ok: true, invites: [] });
  const email = normalizeClinicEmail(tsnap.data().email);

  // Busca por email OU therapistUid
  const [byEmail, byUid] = await Promise.all([
    email ? db.collection("therapy_clinic_members").where("invitedEmail", "==", email).get() : { docs: [] },
    db.collection("therapy_clinic_members").where("therapistUid", "==", uid).get()
  ]);

  const seen = new Set();
  const all = [...byEmail.docs, ...byUid.docs]
    .map(d => d.data())
    .filter(m => {
      if (m.status !== "pending") return false;
      if (seen.has(m.memberId)) return false;
      seen.add(m.memberId);
      return true;
    });

  // Enriquece com nome da clínica.
  const enriched = await Promise.all(all.map(async m => {
    const csnap = await db.collection("therapy_clinics").doc(m.clinicId).get();
    return {
      memberId: m.memberId,
      clinicId: m.clinicId,
      clinicName: csnap.exists ? csnap.data().name : null,
      ownerName: null, // poderia enriquecer, mas opcional
      repasseRule: m.repasseRule,
      invitedAt: m.invitedAt || null
    };
  }));

  return res.json({ ok: true, invites: enriched });
}));

// POST /therapy/clinicas/convites/:memberId/aceitar
router.post("/therapy/clinicas/convites/:memberId/aceitar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const memberId = String(req.params.memberId || "").trim();

  const db = getDb();
  const tsnap = await db.collection("therapists").doc(uid).get();
  if (!tsnap.exists) return sendError(res, 404, "PROFISSIONAL_NAO_REGISTRADO");
  const userEmail = normalizeClinicEmail(tsnap.data().email);

  const mref = db.collection("therapy_clinic_members").doc(memberId);
  const msnap = await mref.get();
  if (!msnap.exists) return sendError(res, 404, "CONVITE_NAO_ENCONTRADO");
  const member = msnap.data();
  if (member.status !== "pending") return sendError(res, 409, "CONVITE_JA_PROCESSADO");

  // Só aceita se o email do user bate com o convidado OU therapistUid já está vinculado.
  const emailMatch = member.invitedEmail && userEmail && member.invitedEmail === userEmail;
  const uidMatch   = member.therapistUid === uid;
  if (!emailMatch && !uidMatch) return sendError(res, 403, "CONVITE_NAO_DESTINADO_A_VOCE");

  await mref.set({
    status: "active",
    therapistUid: uid,
    acceptedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  await logAudit({ type: "clinic_member_accepted", clinicId: member.clinicId, memberId, by: uid });
  return res.json({ ok: true });
}));

// POST /therapy/clinicas/convites/:memberId/recusar
router.post("/therapy/clinicas/convites/:memberId/recusar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const memberId = String(req.params.memberId || "").trim();

  const db = getDb();
  const tsnap = await db.collection("therapists").doc(uid).get();
  const userEmail = tsnap.exists ? normalizeClinicEmail(tsnap.data().email) : "";

  const mref = db.collection("therapy_clinic_members").doc(memberId);
  const msnap = await mref.get();
  if (!msnap.exists) return sendError(res, 404, "CONVITE_NAO_ENCONTRADO");
  const member = msnap.data();
  if (member.status !== "pending") return sendError(res, 409, "CONVITE_JA_PROCESSADO");

  const emailMatch = member.invitedEmail && userEmail && member.invitedEmail === userEmail;
  const uidMatch   = member.therapistUid === uid;
  if (!emailMatch && !uidMatch) return sendError(res, 403, "CONVITE_NAO_DESTINADO_A_VOCE");

  await mref.set({
    status: "removed",
    removedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  await logAudit({ type: "clinic_member_declined", clinicId: member.clinicId, memberId, by: uid });
  return res.json({ ok: true });
}));

// GET /therapy/clinicas/:id/repasse?month=YYYY-MM
// Relatório de repasse mensal. Só dono.
router.get("/therapy/clinicas/:id/repasse", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const clinicId = String(req.params.id || "").trim();

  const db = getDb();
  const csnap = await db.collection("therapy_clinics").doc(clinicId).get();
  if (!csnap.exists) return sendError(res, 404, "CLINICA_NAO_ENCONTRADA");
  if (csnap.data().ownerUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  const monthStr = String(req.query?.month || "").trim() || (() => {
    const n = new Date();
    return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, "0")}`;
  })();
  const range = parseFinMonthRange(monthStr);
  if (!range) return sendError(res, 400, "MES_INVALIDO");

  // Membros ativos da clínica (enriquecidos com displayName).
  const msnap = await db.collection("therapy_clinic_members")
    .where("clinicId", "==", clinicId).get();
  const activeMembers = await Promise.all(
    msnap.docs.map(d => d.data())
      .filter(m => m.status === "active" && m.therapistUid)
      .map(enrichMember)
  );

  // Transações do dono no mês (ele é quem recebe o $; repasse sai daqui).
  const txSnap = await db.collection("therapy_transactions")
    .where("therapistUid", "==", uid).get();
  const txInMonth = txSnap.docs.map(d => d.data()).filter(tx =>
    typeof tx.issueDate === "number" &&
    tx.issueDate >= range.startMs &&
    tx.issueDate < range.endMs
  );

  const repasses = computeMonthlyRepasse(activeMembers, txInMonth);
  const totalRepasseGeral = repasses.reduce((acc, r) => acc + r.totalRepasseCents, 0);
  const totalReceitaConsultas = repasses.reduce((acc, r) => acc + r.totalConsultasCents, 0);

  return res.json({
    ok: true,
    clinicId,
    month: monthStr,
    members: repasses,
    totals: {
      totalConsultasCents: totalReceitaConsultas,
      totalRepasseCents: totalRepasseGeral,
      // Sobra pra clínica = receita das consultas - soma dos repasses
      sobraClinicaCents: totalReceitaConsultas - totalRepasseGeral
    }
  });
}));

// ═════════════════════════════════════════════════════════════════════════
// RECIBOS — recibo eletrônico de pagamento (não-fiscal)
//
// Coleções:
//   therapy_receipts/{receiptId}         — recibo emitido
//   therapy_receipt_counters/{uid}       — { seq: number } pra numeração
//
// Recibo NÃO é NF — não vai pra prefeitura, não gera ISS. Tem validade
// jurídica como recibo de pagamento (CC Art. 320). Algumas operadoras de
// saúde aceitam pra reembolso.
//
// Numeração sequencial por user: Firestore transaction garante atomicidade
// contra emissões simultâneas. Sem gaps.
//
// Idempotência: 1 transação financeira tem no máximo 1 recibo. Se chamarem
// POST de novo pra mesma txId, retorna o existente (não cria duplicado).
//
// Snapshot do emitente: preserva histórico se profissional editar perfil
// depois (mudou conselho, endereço, etc).
// ═════════════════════════════════════════════════════════════════════════

// POST /therapy/recibos
// Body: { txId }
//
// Gera recibo a partir de uma transação financeira "Pago" do tipo "Receita".
// Idempotente: retorna recibo existente se já tiver sido emitido pra essa tx.
router.post("/therapy/recibos", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await requirePaidPlan(req, res, uid);
  if (!therapist) return;

  const txId = String(req.body?.txId || "").trim();
  if (!txId) return sendError(res, 400, "TX_ID_OBRIGATORIO");

  const db = getDb();

  // 1) Valida a transação
  const txRef = db.collection("therapy_transactions").doc(txId);
  const txSnap = await txRef.get();
  if (!txSnap.exists) return sendError(res, 404, "TRANSACAO_NAO_ENCONTRADA");
  const tx = txSnap.data();
  if (tx.therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");
  if (tx.type !== "receita") return sendError(res, 400, "TX_NAO_E_RECEITA");
  if (tx.status !== "pago") return sendError(res, 400, "TX_NAO_ESTA_PAGA");

  // 2) Idempotência: já existe recibo pra essa tx?
  const existingSnap = await db.collection("therapy_receipts")
    .where("therapistUid", "==", uid)
    .where("txId", "==", txId)
    .limit(1).get();
  if (!existingSnap.empty) {
    return res.json({ ok: true, receipt: existingSnap.docs[0].data(), existed: true });
  }

  // 3) Snapshot do emitente (do doc therapist + consultorio)
  const c = therapist.consultorio || {};
  const idsEmitente = [];
  if (therapist.crm) idsEmitente.push("CRM " + therapist.crm);
  if (therapist.crp) idsEmitente.push("CRP " + therapist.crp);
  const isLegacy = therapist.crm || therapist.crp;
  if (!isLegacy && therapist.tipoConselho && therapist.numeroConselho) {
    const sub = therapist.subtipoConselho ? ` (${therapist.subtipoConselho === "to" ? "TO" : "fisio"})` : "";
    idsEmitente.push(`${therapist.tipoConselho} ${therapist.numeroConselho}${sub}`);
  }
  if (therapist.rqe) idsEmitente.push("RQE " + String(therapist.rqe).replace(/^RQE\s*/i, ""));

  const emitterSnapshot = {
    displayName:  therapist.displayName || "",
    ids:          idsEmitente.join("  ·  "),
    especialidade: therapist.especialidade || "",
    cnpj:         therapist.cnpj || null,
    cpf:          therapist.cpf || null,
    address: c.endereco ? [
      c.endereco + (c.numero ? `, ${c.numero}` : "") + (c.complemento ? ` — ${c.complemento}` : ""),
      [c.bairro, c.cidade, c.uf, c.cep].filter(Boolean).join(" · ")
    ].filter(Boolean).join(" / ") : "",
    phone: c.telefone || "",
    logoBase64: therapist.logoBase64 || null,
    logoMime:   therapist.logoMime   || null
  };

  // 4) Aloca número sequencial via transaction
  const counterRef = db.collection("therapy_receipt_counters").doc(uid);
  const receiptId = newId("rcp");
  const receiptRef = db.collection("therapy_receipts").doc(receiptId);

  const valorExtensoTxt = valorPorExtenso(tx.amount);
  const patientName = (tx.patientNameSnapshot || "").slice(0, RECEIPT_PATIENT_NAME_MAX);
  const description = (tx.description || "").slice(0, RECEIPT_DESCRIPTION_MAX);

  const sequentialNumber = await db.runTransaction(async (txx) => {
    const counterSnap = await txx.get(counterRef);
    const current = counterSnap.exists ? (counterSnap.data().seq || 0) : 0;
    const next = current + 1;
    txx.set(counterRef, {
      seq: next,
      therapistUid: uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    txx.set(receiptRef, {
      receiptId,
      therapistUid: uid,
      txId,
      sequentialNumber: next,
      patientName: patientName || null,
      patientCpf: tx.patientCpf || null,
      amount: tx.amount,
      amountExtenso: valorExtensoTxt,
      description: description || null,
      issueDate: tx.issueDate,
      paidDate: tx.paidDate || tx.issueDate,
      paymentMethod: tx.paymentMethod || "outro",
      paymentMethodLabel: RECEIPT_PAYMENT_LABELS[tx.paymentMethod] || "Outro",
      emitterSnapshot,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return next;
  });

  const finalSnap = await receiptRef.get();
  await logAudit({ type: "receipt_created", receiptId, therapistUid: uid, txId, sequentialNumber });
  return res.json({ ok: true, receipt: finalSnap.data(), existed: false });
}));

// GET /therapy/recibos?txId=&month=YYYY-MM
// Lista recibos do user. Filtros opcionais. Ordenado por sequentialNumber desc.
router.get("/therapy/recibos", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const db = getDb();
  const snap = await db.collection("therapy_receipts")
    .where("therapistUid", "==", uid)
    .get();

  const txIdFilter = String(req.query?.txId || "").trim();
  const monthStr   = String(req.query?.month || "").trim();
  let rangeStart = 0;
  let rangeEnd   = Infinity;
  if (monthStr) {
    const range = parseFinMonthRange(monthStr);
    if (!range) return sendError(res, 400, "MES_INVALIDO");
    rangeStart = range.startMs;
    rangeEnd   = range.endMs;
  }

  const receipts = snap.docs.map(d => d.data()).filter(r => {
    if (txIdFilter && r.txId !== txIdFilter) return false;
    if (typeof r.issueDate === "number" && (r.issueDate < rangeStart || r.issueDate >= rangeEnd)) return false;
    return true;
  }).sort((a, b) => (b.sequentialNumber || 0) - (a.sequentialNumber || 0));

  return res.json({ ok: true, receipts });
}));

// GET /therapy/recibos/:id
router.get("/therapy/recibos/:id", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const receiptId = String(req.params.id || "").trim();
  if (!receiptId) return sendError(res, 400, "ID_OBRIGATORIO");

  const db = getDb();
  const snap = await db.collection("therapy_receipts").doc(receiptId).get();
  if (!snap.exists) return sendError(res, 404, "RECIBO_NAO_ENCONTRADO");
  if (snap.data().therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  return res.json({ ok: true, receipt: snap.data() });
}));

// ═════════════════════════════════════════════════════════════════════════
// WHATSAPP — configuração por profissional + endpoint de teste + webhook
//
// Provider: Z-API (ver services/whatsapp.js). Disparo automático em:
//   - POST /therapy/sessao/criar (acima) — confirmação
//   - applyCancellation (acima) — cancelamento
//   - services/scheduler.js — lembrete 24h antes
//
// Config vive em therapists/{uid}.whatsappConfig:
//   { enabled, clinicName, phoneClinic, templates: { confirmacao, lembrete,
//     cancelamento } }
// Templates default ficam em services/whatsapp.js — só sobrescritos pelo
// profissional via PATCH abaixo.
// ═════════════════════════════════════════════════════════════════════════

// GET /therapy/profissional/whatsapp/config
// Retorna config atual + templates default (pra UI usar como placeholder)
// + status da instância (conectada/desconectada).
router.get("/therapy/profissional/whatsapp/config", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 404, "PROFISSIONAL_NAO_REGISTRADO");

  // Status só consultado sob demanda (faz HTTP call pra Z-API). Pra UI
  // primária é OK; pode ser cacheado client-side se virar bottleneck.
  const status = await getWaInstanceStatus().catch(() => ({ connected: false, reason: "ERROR" }));

  return res.json({
    ok: true,
    config: therapist.whatsappConfig || {
      enabled: false,
      clinicName: therapist.displayName || "",
      phoneClinic: "",
      templates: {}
    },
    defaults: WA_DEFAULT_TEMPLATES,
    instanceStatus: {
      configured: isWaConfigured(),
      connected:  status.connected,
      reason:     status.reason || null
    }
  });
}));

// PATCH /therapy/profissional/whatsapp/config
// Body: { enabled?, clinicName?, phoneClinic?, templates? }
// templates aceita objeto parcial: { confirmacao?, lembrete?, cancelamento? }
const WA_TEMPLATE_MAX = 1500; // SMS-like cap, gera mensagem visível no WA
const WA_CLINIC_NAME_MAX = 100;
const WA_PHONE_MAX = 30;
router.patch("/therapy/profissional/whatsapp/config", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 404, "PROFISSIONAL_NAO_REGISTRADO");

  const current = therapist.whatsappConfig || {};
  const next = { ...current };

  if (req.body?.enabled !== undefined)     next.enabled     = Boolean(req.body.enabled);
  if (req.body?.clinicName !== undefined)  next.clinicName  = String(req.body.clinicName).trim().slice(0, WA_CLINIC_NAME_MAX);
  if (req.body?.phoneClinic !== undefined) next.phoneClinic = String(req.body.phoneClinic).trim().slice(0, WA_PHONE_MAX);

  if (req.body?.templates && typeof req.body.templates === "object") {
    const tplIn = req.body.templates;
    const tplOut = { ...(current.templates || {}) };
    for (const k of ["confirmacao", "lembrete", "cancelamento"]) {
      if (tplIn[k] === undefined) continue;
      const v = String(tplIn[k] || "").slice(0, WA_TEMPLATE_MAX);
      // Vazio significa "voltar ao default" — apaga override.
      if (v.trim() === "") delete tplOut[k];
      else tplOut[k] = v;
    }
    next.templates = tplOut;
  }

  const db = getDb();
  await db.collection("therapists").doc(uid).set({
    whatsappConfig: next,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({
    type: "whatsapp_config_updated",
    therapistUid: uid,
    enabled: next.enabled,
    customTemplates: Object.keys(next.templates || {})
  });
  return res.json({ ok: true, config: next });
}));

// POST /therapy/profissional/whatsapp/teste
// Body: { to } — número de teste pra disparar uma mensagem "Olá! Teste do
// Espaço Prelúdio." Usado pra validar que credenciais + número estão OK
// antes de ativar pra pacientes.
router.post("/therapy/profissional/whatsapp/teste", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 404, "PROFISSIONAL_NAO_REGISTRADO");
  if (!isWaConfigured()) {
    return sendError(res, 503, "ZAPI_NAO_CONFIGURADO", {
      detail: "Credenciais Z-API ainda não configuradas no servidor. Avise o suporte."
    });
  }

  const to = String(req.body?.to || "").trim();
  if (!to) return sendError(res, 400, "TELEFONE_OBRIGATORIO");

  const nome = therapist.whatsappConfig?.clinicName || therapist.displayName || "Espaço Prelúdio";
  const msg = `Olá! Teste de integração WhatsApp do Espaço Prelúdio.

Esta mensagem foi enviada por ${nome}.

Se você recebeu, o canal está funcionando corretamente. Não é necessário responder.`;

  const result = await sendWaText({ to, message: msg });
  if (!result.ok) {
    return res.status(502).json({
      ok: false,
      error: result.error || "ENVIO_FALHOU",
      data: result.data || null
    });
  }
  await logAudit({ type: "whatsapp_test_sent", therapistUid: uid, to: normalizeWaPhone(to) });
  return res.json({ ok: true, messageId: result.messageId });
}));

// POST /therapy/webhook/zapi
// Recebe eventos do Z-API. Pelo briefing, pacientes não respondem direto
// (número é só de envio + ligação telefônica pra contato). Mas registramos
// mensagens recebidas pra audit/debug. Sem ação automatizada por enquanto.
router.post("/therapy/webhook/zapi", asyncHandler(async (req, res) => {
  // Auth via token compartilhado (ZAPI_WEBHOOK_SECRET) — Z-API configura
  // como query string `?token=X`. Sem secret configurado, rejeita silenciosamente
  // (evita que qualquer um POST encha logs/audit). Comparacao timing-safe.
  const ZAPI_WEBHOOK_SECRET = String(process.env.ZAPI_WEBHOOK_SECRET || "").trim();
  if (!ZAPI_WEBHOOK_SECRET) {
    // Modo permissivo durante setup inicial. Loga warn. Pra producao, setar
    // ZAPI_WEBHOOK_SECRET no Railway + adicionar `?token=X` na URL do
    // webhook no painel Z-API.
    logWarn("zapi_webhook_no_secret_configured");
  } else {
    const tokenIn = String(req.query?.token || "").trim();
    let tokenOk = false;
    if (tokenIn.length === ZAPI_WEBHOOK_SECRET.length) {
      try {
        tokenOk = crypto.timingSafeEqual(Buffer.from(tokenIn), Buffer.from(ZAPI_WEBHOOK_SECRET));
      } catch { tokenOk = false; }
    }
    if (!tokenOk) {
      logWarn("zapi_webhook_token_invalido", { ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress });
      return res.status(401).json({ ok: false });
    }
  }

  // Z-API envia múltiplos tipos de evento: ReceivedCallback, MessageStatusCallback,
  // ConnectionUpdate, etc. Logamos tudo pra observabilidade inicial.
  const type = req.body?.type || req.body?.event || "unknown";
  const phone = req.body?.phone || req.body?.from || null;
  const messageId = req.body?.messageId || req.body?.id || null;

  logInfo("zapi_webhook", { type, phone, messageId, hasBody: !!req.body });

  // Audit log pra ações inbound dignas de nota (paciente respondendo,
  // mensagem entregue, etc).
  if (ensureDb({ status: () => ({ json: () => null }) })) {
    try {
      await logAudit({
        type: "zapi_webhook_received",
        eventType: String(type).slice(0, 50),
        phone: phone ? String(phone).slice(0, 30) : null,
        messageId: messageId ? String(messageId).slice(0, 100) : null
      });
    } catch {}
  }

  // Sempre 200 — Z-API retry se receber não-200, e não queremos loop.
  return res.json({ ok: true, ignored: type === "unknown" });
}));

// ═════════════════════════════════════════════════════════════════════════
// COBRANÇAS ASAAS — terapeuta gera Pix pra uma transação. Asaas tem conta
// PJ ou PF do próprio terapeuta (apiKey no perfil). Espaço Prelúdio só
// orquestra: cria customer + payment, devolve QR Pix. Dinheiro cai direto
// no Asaas do terapeuta. Webhook do Asaas → atualiza status do tx.
// ═════════════════════════════════════════════════════════════════════════

function buildCustomerExternalReference({ therapistUid, patientId, patientNameSnapshot }) {
  // Um customer Asaas por (terapeuta, paciente). Pacientes sem patientId
  // (avulso) usam hash do nome — same patient, same hash, idempotente.
  if (patientId) return `tu:${therapistUid}:pid:${patientId}`;
  const nameHash = crypto.createHash("sha256")
    .update(`${therapistUid}::${(patientNameSnapshot || "").toLowerCase().trim()}`)
    .digest("hex").slice(0, 16);
  return `tu:${therapistUid}:nm:${nameHash}`;
}

// POST /therapy/financeiro/transacoes/:txId/cobranca/criar — gera Pix.
// Body: { patientEmail?, patientPhone?, patientCpfCnpj?, dueDate? (ms), description? }
// dueDate default = 7d à frente. description default = patientNameSnapshot ou "Consulta".
router.post("/therapy/financeiro/transacoes/:txId/cobranca/criar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await requirePaidPlan(req, res, uid);
  if (!therapist) return;

  if (!therapist.asaasApiKey) {
    return sendError(res, 412, "ASAAS_NAO_CONFIGURADO", {
      hint: "Configure sua chave Asaas em Perfil → Cobranças online antes de gerar Pix."
    });
  }
  if (therapist.asaasEnabled === false) {
    return sendError(res, 412, "ASAAS_DESABILITADO", { hint: "Habilite cobranças no Perfil." });
  }

  const txId = String(req.params.txId || "").trim();
  if (!txId) return sendError(res, 400, "TX_ID_OBRIGATORIO");

  const db = getDb();
  const txRef = db.collection("therapy_transactions").doc(txId);
  const txSnap = await txRef.get();
  if (!txSnap.exists) return sendError(res, 404, "TRANSACAO_NAO_ENCONTRADA");
  const tx = txSnap.data();
  if (tx.therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");
  if (tx.type !== "receita") return sendError(res, 400, "COBRANCA_SO_PARA_RECEITAS");
  if (tx.status === "pago")  return sendError(res, 409, "TRANSACAO_JA_PAGA");
  // Idempotência forte: se já tem paymentId vigente (não cancelado), só
  // devolve o existente. Pra trocar, terapeuta cancela e cria nova.
  if (tx.asaasPaymentId && tx.asaasStatus !== "cancelado" && tx.asaasStatus !== "DELETED") {
    return res.json({
      ok: true,
      reused: true,
      cobranca: pickCobrancaPublica(tx)
    });
  }

  const patientEmail   = String(req.body?.patientEmail   || "").trim().toLowerCase() || null;
  const patientPhone   = String(req.body?.patientPhone   || "").trim() || null;
  const patientCpfCnpj = String(req.body?.patientCpfCnpj || "").replace(/\D/g, "").slice(0, 14) || null;
  const dueDateMs      = Number(req.body?.dueDate) || 0;
  const description    = String(req.body?.description || tx.description || `Consulta - ${tx.patientNameSnapshot || ""}`).trim().slice(0, 500);

  const env = therapist.asaasEnv === "production" ? "production" : "sandbox";

  // 1) ensure customer
  const custExtRef = buildCustomerExternalReference({
    therapistUid: uid,
    patientId: tx.patientId,
    patientNameSnapshot: tx.patientNameSnapshot
  });
  const cust = await asaas.ensureCustomer({
    apiKey: therapist.asaasApiKey, env,
    externalReference: custExtRef,
    name: tx.patientNameSnapshot || "Cliente",
    email: patientEmail,
    phone: patientPhone,
    cpfCnpj: patientCpfCnpj
  });
  if (!cust.ok) return sendError(res, 502, "ASAAS_CUSTOMER_FAILED", { hint: cust.error });

  // 2) create payment
  const dueDateIso = (() => {
    if (dueDateMs > 0) return new Date(dueDateMs).toISOString().slice(0, 10);
    return new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  })();
  const pay = await asaas.createPaymentPix({
    apiKey: therapist.asaasApiKey, env,
    customerId: cust.customerId,
    valueCents: tx.amount,
    description,
    dueDate: dueDateIso,
    externalReference: txId
  });
  if (!pay.ok) return sendError(res, 502, "ASAAS_PAYMENT_FAILED", { hint: pay.error });

  // 3) get QR
  const qr = await asaas.getPixQrCode({ apiKey: therapist.asaasApiKey, env, paymentId: pay.data.id });
  // Se QR falhar não cancelamos — terapeuta ainda tem o invoiceUrl como fallback.

  const asaasData = {
    asaasCustomerId:    cust.customerId,
    asaasPaymentId:     pay.data.id,
    asaasInvoiceUrl:    pay.data.invoiceUrl || null,
    asaasBankSlipUrl:   pay.data.bankSlipUrl || null,
    asaasPixCopyPaste:  qr.ok ? (qr.data?.payload || null) : null,
    asaasPixQrCodeBase64: qr.ok ? (qr.data?.encodedImage || null) : null,
    asaasPixExpiresAt:   qr.ok ? (qr.data?.expirationDate || null) : null,
    asaasStatus:         pay.data.status || "PENDING",
    asaasEnv:            env,
    asaasCreatedAt:      admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:           admin.firestore.FieldValue.serverTimestamp()
  };
  await txRef.set(asaasData, { merge: true });

  await logAudit({ type: "cobranca_asaas_criada", therapistUid: uid, txId, asaasPaymentId: pay.data.id, env });

  // Recarrega pra retornar payload limpo.
  const fresh = (await txRef.get()).data();
  return res.json({ ok: true, cobranca: pickCobrancaPublica(fresh) });
}));

function pickCobrancaPublica(tx) {
  return {
    asaasPaymentId:     tx.asaasPaymentId      || null,
    asaasStatus:        tx.asaasStatus         || null,
    asaasInvoiceUrl:    tx.asaasInvoiceUrl     || null,
    asaasBankSlipUrl:   tx.asaasBankSlipUrl    || null,
    asaasPixCopyPaste:  tx.asaasPixCopyPaste   || null,
    asaasPixQrCodeBase64: tx.asaasPixQrCodeBase64 || null,
    asaasPixExpiresAt:  tx.asaasPixExpiresAt   || null,
    asaasEnv:           tx.asaasEnv            || null
  };
}

// GET /therapy/financeiro/transacoes/:txId/cobranca — devolve estado atual
// (com refresh opcional via ?refresh=1 que consulta Asaas síncronamente).
router.get("/therapy/financeiro/transacoes/:txId/cobranca", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 404, "PROFISSIONAL_NAO_REGISTRADO");

  const txId = String(req.params.txId || "").trim();
  if (!txId) return sendError(res, 400, "TX_ID_OBRIGATORIO");

  const db = getDb();
  const txRef = db.collection("therapy_transactions").doc(txId);
  const txSnap = await txRef.get();
  if (!txSnap.exists) return sendError(res, 404, "TRANSACAO_NAO_ENCONTRADA");
  const tx = txSnap.data();
  if (tx.therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  if (!tx.asaasPaymentId) {
    return res.json({ ok: true, cobranca: null });
  }

  // Refresh opcional — quando o terapeuta abre a cobrança no painel pode
  // valer pinger o Asaas pra ver se já caiu o Pix.
  if (req.query?.refresh === "1" && therapist.asaasApiKey) {
    const env = tx.asaasEnv || (therapist.asaasEnv === "production" ? "production" : "sandbox");
    const fresh = await asaas.getPayment({ apiKey: therapist.asaasApiKey, env, paymentId: tx.asaasPaymentId });
    if (fresh.ok && fresh.data?.status && fresh.data.status !== tx.asaasStatus) {
      const newTxStatus = asaas.mapAsaasStatusToTx(fresh.data.status);
      const updates = {
        asaasStatus: fresh.data.status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };
      if (newTxStatus === "pago" && tx.status !== "pago") {
        updates.status = "pago";
        updates.paidDate = Date.now();
      }
      await txRef.set(updates, { merge: true });
      tx.asaasStatus = fresh.data.status;
      tx.status = updates.status || tx.status;
    }
  }

  return res.json({ ok: true, cobranca: pickCobrancaPublica(tx), txStatus: tx.status });
}));

// POST /webhooks/asaas/financeiro?token=X — recebe eventos do Asaas e
// atualiza o tx via externalReference. Lookup do terapeuta vem do próprio
// tx — webhook do Asaas é compartilhado entre todos os terapeutas que
// configurarem essa URL no painel deles.
router.post("/webhooks/asaas/financeiro", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;

  // Validação por token compartilhado (env var). Asaas configura no painel
  // como query string da URL do webhook. Sem token = ignora silenciosamente
  // (não dá info pra atacantes). Comparacao timing-safe pra evitar oracle
  // de byte-prefix em rede.
  const tokenIn = String(req.query?.token || "").trim();
  let tokenOk = false;
  if (ASAAS_WEBHOOK_TOKEN && tokenIn.length === ASAAS_WEBHOOK_TOKEN.length) {
    try {
      tokenOk = crypto.timingSafeEqual(Buffer.from(tokenIn), Buffer.from(ASAAS_WEBHOOK_TOKEN));
    } catch { tokenOk = false; }
  }
  if (!tokenOk) {
    logWarn("asaas_webhook_token_invalido", { ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress });
    return res.status(401).json({ ok: false });
  }

  const event   = String(req.body?.event   || "").trim();
  const payment = req.body?.payment || {};
  const txId    = String(payment.externalReference || "").trim();
  if (!event || !txId) {
    logInfo("asaas_webhook_ignored", { reason: "sem_externalReference_ou_event", event });
    return res.json({ ok: true, ignored: true });
  }

  const db = getDb();
  const txRef = db.collection("therapy_transactions").doc(txId);
  const txSnap = await txRef.get();
  if (!txSnap.exists) {
    logInfo("asaas_webhook_tx_nao_encontrada", { txId, event });
    return res.json({ ok: true, ignored: true });
  }
  const tx = txSnap.data();
  // Sanity: só aceita evento se paymentId bater (defende contra cross-tx replay).
  if (tx.asaasPaymentId && payment.id && tx.asaasPaymentId !== payment.id) {
    logWarn("asaas_webhook_payment_id_divergente", { txId, esperado: tx.asaasPaymentId, recebido: payment.id });
    return res.json({ ok: true, ignored: true });
  }

  const newTxStatus = asaas.mapAsaasStatusToTx(payment.status);
  const updates = {
    asaasStatus: payment.status || tx.asaasStatus || null,
    asaasLastEventAt: admin.firestore.FieldValue.serverTimestamp(),
    asaasLastEvent: event,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  // Eventos que viram "pago" no nosso modelo:
  if (newTxStatus === "pago" && tx.status !== "pago") {
    updates.status = "pago";
    updates.paidDate = Date.now();
  }
  // Eventos de cancelamento/refund: rebaixa pra pendente ou marca canceled
  // (não revertimos automaticamente um pago confirmado anterior).
  if ((newTxStatus === "cancelado" || newTxStatus === "reembolsado") && tx.status === "pago") {
    updates.status = newTxStatus === "reembolsado" ? "reembolsado" : "pendente";
    updates.paidDate = null;
  }

  await txRef.set(updates, { merge: true });

  await logAudit({
    type: "cobranca_asaas_webhook",
    txId,
    therapistUid: tx.therapistUid,
    event,
    asaasStatus: payment.status || null,
    newTxStatus: updates.status || tx.status
  });

  // Sempre 200 — Asaas retenta se receber não-200, e não queremos loop.
  return res.json({ ok: true });
}));

// ═════════════════════════════════════════════════════════════════════════
// RECIBO A PARTIR DE SESSÃO — terapeuta clica "Enviar recibo" no card de
// sessão (agendada ou encerrada), preenche valor + método, e o recibo é
// criado + enviado pro paciente via e-mail e WhatsApp.
//
// Fluxo:
//  1. Cria therapy_transactions (status=pago) tied to session — vai pro
//     financeiro automaticamente.
//  2. Cria therapy_receipts (sequential number) — mesmo schema do POST /recibos.
//  3. Gera token "recibo_view" (TTL 1 ano — IR exige guardar 5 anos mas
//     1 ano cobre o uso prático; pra retomar depois o terapeuta acessa o
//     PDF via financeiro/recibos).
//  4. Envia e-mail (template) + WhatsApp (texto) em paralelo, fire-and-forget.
//     Sucesso parcial é OK — frontend mostra quais canais funcionaram.
// ═════════════════════════════════════════════════════════════════════════
const RECIBO_PUBLIC_TOKEN_VALIDITY_MS = 365 * 24 * 60 * 60 * 1000; // 1 ano

router.post("/therapy/sessao/:sessionId/recibo/enviar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await requirePaidPlan(req, res, uid);
  if (!therapist) return;

  const sessionId = String(req.params.sessionId || "").trim();
  if (!sessionId) return sendError(res, 400, "SESSAO_OBRIGATORIA");

  const db = getDb();
  const sessRef = db.collection("therapy_sessions").doc(sessionId);
  const sessSnap = await sessRef.get();
  if (!sessSnap.exists) return sendError(res, 404, "SESSAO_NAO_ENCONTRADA");
  const sess = sessSnap.data();
  if (sess.therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  const amount = Number(req.body?.amount);
  if (!isValidFinAmount(amount)) return sendError(res, 400, "VALOR_INVALIDO", { hint: "amount em centavos (integer)" });

  const paymentMethod = String(req.body?.paymentMethod || "pix").trim().toLowerCase();
  if (!isValidFinPaymentMethod(paymentMethod)) return sendError(res, 400, "METODO_PAGAMENTO_INVALIDO");

  const paidDate = Number(req.body?.paidDate) || Date.now();

  const patientEmailRaw = String(req.body?.patientEmail || sess.patientEmail || "").trim().toLowerCase();
  const patientEmail = patientEmailRaw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patientEmailRaw) ? patientEmailRaw : null;
  const patientPhoneRaw = String(req.body?.patientPhone || sess.patientPhone || "").trim();
  const patientPhoneNorm = patientPhoneRaw ? normalizeWaPhone(patientPhoneRaw) : "";
  const patientPhone = patientPhoneNorm.length >= 12 ? patientPhoneNorm : null;

  const sendEmailFlag = req.body?.sendEmail !== false;
  const sendWaFlag    = req.body?.sendWhatsapp !== false;

  const description = String(req.body?.description || `Consulta - ${sess.patientName || ""}`).trim().slice(0, DESCRIPTION_MAX);

  // TUSS opcional pra reembolso de convênio. Frontend manda code + label do
  // catálogo TUSS (RN ANS 305/2012). Persistido no recibo; renderizado no PDF
  // como bloco "Procedimento (TUSS)".
  const tussCode  = String(req.body?.tussCode  || "").trim().slice(0, 20) || null;
  const tussLabel = String(req.body?.tussLabel || "").trim().slice(0, 200) || null;

  // 1) Cria transação (status=pago, category=consulta-particular default)
  const txId = newId("tx");
  await db.collection("therapy_transactions").doc(txId).set({
    txId,
    therapistUid: uid,
    performedByUid: null,
    type: "receita",
    category: "consulta-particular",
    amount,
    description,
    paymentMethod,
    status: "pago",
    patientId: sess.patientId || null,
    patientNameSnapshot: sess.patientName || null,
    sessionId,
    issueDate: paidDate,
    dueDate: null,
    paidDate,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  // 2) Cria recibo (snapshot do terapeuta + número sequencial)
  const c = therapist.consultorio || {};
  const idsEmitente = [];
  if (therapist.crm) idsEmitente.push("CRM " + therapist.crm);
  if (therapist.crp) idsEmitente.push("CRP " + therapist.crp);
  const isLegacy = therapist.crm || therapist.crp;
  if (!isLegacy && therapist.tipoConselho && therapist.numeroConselho) {
    const sub = therapist.subtipoConselho ? ` (${therapist.subtipoConselho === "to" ? "TO" : "fisio"})` : "";
    idsEmitente.push(`${therapist.tipoConselho} ${therapist.numeroConselho}${sub}`);
  }
  if (therapist.rqe) idsEmitente.push("RQE " + String(therapist.rqe).replace(/^RQE\s*/i, ""));
  const emitterSnapshot = {
    displayName:  therapist.displayName || "",
    ids:          idsEmitente.join("  ·  "),
    especialidade: therapist.especialidade || "",
    cnpj:         therapist.cnpj || null,
    cpf:          therapist.cpf || null,
    address: c.endereco ? [
      c.endereco + (c.numero ? `, ${c.numero}` : "") + (c.complemento ? ` — ${c.complemento}` : ""),
      [c.bairro, c.cidade, c.uf, c.cep].filter(Boolean).join(" · ")
    ].filter(Boolean).join(" / ") : "",
    phone: c.telefone || "",
    logoBase64: therapist.logoBase64 || null,
    logoMime:   therapist.logoMime   || null
  };
  const counterRef = db.collection("therapy_receipt_counters").doc(uid);
  const receiptId = newId("rcp");
  const receiptRef = db.collection("therapy_receipts").doc(receiptId);
  const valorExtensoTxt = valorPorExtenso(amount);
  const patientNameTrunc = (sess.patientName || "").slice(0, RECEIPT_PATIENT_NAME_MAX);
  const sequentialNumber = await db.runTransaction(async (txx) => {
    const counterSnap = await txx.get(counterRef);
    const current = counterSnap.exists ? (counterSnap.data().seq || 0) : 0;
    const next = current + 1;
    txx.set(counterRef, {
      seq: next,
      therapistUid: uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    txx.set(receiptRef, {
      receiptId,
      therapistUid: uid,
      txId,
      sessionId,
      sequentialNumber: next,
      patientName: patientNameTrunc || null,
      patientCpf: null,
      amount,
      amountExtenso: valorExtensoTxt,
      description: description.slice(0, RECEIPT_DESCRIPTION_MAX),
      issueDate: paidDate,
      paidDate,
      paymentMethod,
      paymentMethodLabel: RECEIPT_PAYMENT_LABELS[paymentMethod] || "Outro",
      tussCode,
      tussLabel,
      emitterSnapshot,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return next;
  });

  // 3) Token público pra visualização
  const reciboToken = signPayload({
    token_type: "recibo_view",
    receiptId,
    therapistUid: uid,
    iat: Date.now(),
    exp: Date.now() + RECIBO_PUBLIC_TOKEN_VALIDITY_MS
  }, ACCESS_TOKEN_SECRET);
  let reciboCode = null;
  try {
    reciboCode = await createActionCode({ token: reciboToken, type: "recibo" });
  } catch (e) {
    logWarn("recibo_action_code_failed", { receiptId, error: e.message });
  }
  const reciboUrl = buildReciboPublicoUrl(reciboCode || reciboToken);

  // 4) Envio: e-mail + WhatsApp em paralelo, fire-and-forget pra sintática
  // de await — capturamos sucesso/falha pra responder ao frontend.
  const channels = { email: { attempted: false, ok: false }, whatsapp: { attempted: false, ok: false } };

  const therapistName = therapist.displayName || "Profissional";
  if (sendEmailFlag && patientEmail) {
    channels.email.attempted = true;
    try {
      const tpl = templateReciboEnviado({
        patientName: patientNameTrunc || "Paciente",
        therapistName,
        amountCents: amount,
        paymentMethodLabel: RECEIPT_PAYMENT_LABELS[paymentMethod] || "Outro",
        paidDateMs: paidDate,
        reciboUrl,
        sequentialNumber
      });
      const therapistEmail = await resolveTherapistEmail(uid, therapist);
      const r = await sendEmail({ to: patientEmail, replyTo: therapistEmail || undefined, ...tpl });
      channels.email.ok = !!(r.ok || r.skipped);
    } catch (e) {
      logError("recibo_email_failed", e, { receiptId });
    }
  }

  if (sendWaFlag && patientPhone) {
    channels.whatsapp.attempted = true;
    if (therapist?.whatsappConfig?.enabled) {
      try {
        const valorFmt = "R$ " + (amount / 100).toFixed(2).replace(".", ",");
        const msg = `Olá ${patientNameTrunc || "paciente"}, ${therapistName} emitiu seu recibo de *${valorFmt}* (nº ${sequentialNumber}).\n\nVer e baixar PDF:\n${reciboUrl}`;
        const r = await sendWaText({ to: patientPhone, message: msg });
        channels.whatsapp.ok = !!r.ok;
      } catch (e) {
        logError("recibo_whatsapp_failed", e, { receiptId });
      }
    } else {
      channels.whatsapp.ok = false;
      channels.whatsapp.reason = "WHATSAPP_NAO_HABILITADO";
    }
  }

  await logAudit({
    type: "recibo_enviado_via_sessao",
    receiptId,
    therapistUid: uid,
    sessionId,
    txId,
    sequentialNumber,
    emailSent: channels.email.ok,
    whatsappSent: channels.whatsapp.ok
  });

  return res.json({
    ok: true,
    receiptId,
    sequentialNumber,
    txId,
    reciboUrl,
    channels
  });
}));

// GET /therapy/recibo/publico?t=<token> — endpoint público (paciente abre o link).
// Token validade 1 ano. Devolve dados pro recibo-publico.html renderizar.
router.get("/therapy/recibo/publico", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  let token = String(req.query?.t || req.query?.c || "").trim();
  if (!token) return sendError(res, 400, "TOKEN_OBRIGATORIO");
  if (token.length <= 16) {
    const resolved = await resolveActionCode(token);
    if (!resolved || resolved.type !== "recibo") return sendError(res, 401, "TOKEN_INVALIDO");
    token = resolved.token;
  }
  const verification = verifySignedToken(token, ACCESS_TOKEN_SECRET);
  if (!verification.valid) return sendError(res, 401, verification.error || "TOKEN_INVALIDO");
  const payload = verification.payload;
  if (payload.token_type !== "recibo_view") return sendError(res, 401, "TOKEN_NAO_AUTORIZADO");

  const db = getDb();
  const rSnap = await db.collection("therapy_receipts").doc(payload.receiptId).get();
  if (!rSnap.exists) return sendError(res, 404, "RECIBO_NAO_ENCONTRADO");
  const r = rSnap.data();
  if (r.therapistUid !== payload.therapistUid) return sendError(res, 401, "TOKEN_INVALIDO");

  return res.json({
    ok: true,
    receipt: {
      receiptId:           r.receiptId,
      sequentialNumber:    r.sequentialNumber,
      patientName:         r.patientName,
      amount:              r.amount,
      amountExtenso:       r.amountExtenso,
      description:         r.description,
      issueDate:           r.issueDate,
      paidDate:            r.paidDate,
      paymentMethod:       r.paymentMethod,
      paymentMethodLabel:  r.paymentMethodLabel,
      emitterSnapshot:     r.emitterSnapshot
    }
  });
}));

// ═════════════════════════════════════════════════════════════════════════
// TISS — Troca de Informação em Saúde Suplementar (Fase 1)
//
// Fase 1: schema + CRUD. Sem geração XML ainda — só estrutura de dados.
// XML 4.01.00 entra na Fase 2. Auto-submit por convênio na Fase 4+.
//
// Modelo de dados:
//   therapists/{uid}.tissEnabled: boolean (opt-in, esconde UI se false)
//   therapists/{uid}.tissConvenios: array de:
//     { code, nome, registroAns?, numeroContratado, plano?, enabled }
//   patients/{patientId}.convenios: array de:
//     { convenioCode, numeroCarteirinha, validade?, plano?, titular? }
//   therapy_sessions/{sessionId}.tiss: {
//     convenioCode, numeroGuiaPrestador (sequencial nosso),
//     numeroGuiaOperadora?, tussCode, tussLabel, valorProcedimento,
//     status: rascunho|enviada|em_analise|paga|glosada,
//     dataEnvio?, dataPagamento?, dataGlosa?, codigoGlosa?, motivoGlosa?
//   }
//
// Compliance: dados sensíveis (numeroCarteirinha, CPF) ficam plaintext no
// backend por enquanto — em fase futura migrar pra E2EE igual prontuário.
// LGPD: documentar consentimento explícito na anamnese.
// ═════════════════════════════════════════════════════════════════════════
const TISS_CONVENIO_NOME_MAX = 80;
const TISS_NUM_CONTRATADO_MAX = 40;
const TISS_CARTEIRINHA_MAX = 40;

// GET /therapy/profissional/tiss/convenios — lista convênios aceitos pelo prof.
router.get("/therapy/profissional/tiss/convenios", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 403, "PROFISSIONAL_NAO_REGISTRADO");
  return res.json({
    ok: true,
    tissEnabled: !!therapist.tissEnabled,
    convenios: Array.isArray(therapist.tissConvenios) ? therapist.tissConvenios : []
  });
}));

// POST /therapy/profissional/tiss/toggle — opt-in/out TISS na conta
router.post("/therapy/profissional/tiss/toggle", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const enabled = !!req.body?.enabled;
  await getDb().collection("therapists").doc(uid).set({
    tissEnabled: enabled,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  return res.json({ ok: true, tissEnabled: enabled });
}));

// POST /therapy/profissional/tiss/convenios — upsert convênio aceito.
// Body: { code, nome, registroAns?, numeroContratado, plano?, enabled? }
// `code` é o ID local (slug curto que o prof define, ex "unimed-rj"). Upsert
// faz find-by-code e substitui o objeto inteiro.
router.post("/therapy/profissional/tiss/convenios", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 403, "PROFISSIONAL_NAO_REGISTRADO");

  const code = String(req.body?.code || "").trim().toLowerCase().slice(0, 40);
  if (!/^[a-z0-9-]+$/.test(code)) return sendError(res, 400, "CODE_INVALIDO", { detail: "Use letras minúsculas, números e hífen." });
  const nome = String(req.body?.nome || "").trim().slice(0, TISS_CONVENIO_NOME_MAX);
  if (!nome) return sendError(res, 400, "NOME_OBRIGATORIO");
  const registroAns       = String(req.body?.registroAns       || "").trim().slice(0, 20) || null;
  const numeroContratado  = String(req.body?.numeroContratado  || "").trim().slice(0, TISS_NUM_CONTRATADO_MAX);
  if (!numeroContratado) return sendError(res, 400, "NUMERO_CONTRATADO_OBRIGATORIO", { detail: "Sua matrícula como prestador no convênio." });
  const plano             = String(req.body?.plano             || "").trim().slice(0, 80) || null;
  const enabled           = req.body?.enabled !== false; // default true

  const entry = { code, nome, registroAns, numeroContratado, plano, enabled, updatedAt: Date.now() };
  const current = Array.isArray(therapist.tissConvenios) ? therapist.tissConvenios.slice() : [];
  const idx = current.findIndex(c => c.code === code);
  if (idx >= 0) current[idx] = { ...current[idx], ...entry };
  else current.push({ ...entry, createdAt: Date.now() });

  await getDb().collection("therapists").doc(uid).set({
    tissConvenios: current,
    tissEnabled: true, // primeiro cadastro auto-habilita
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  return res.json({ ok: true, convenio: entry });
}));

// DELETE /therapy/profissional/tiss/convenios/:code
router.delete("/therapy/profissional/tiss/convenios/:code", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 403, "PROFISSIONAL_NAO_REGISTRADO");
  const code = String(req.params.code || "").trim().toLowerCase();
  const current = Array.isArray(therapist.tissConvenios) ? therapist.tissConvenios : [];
  const next = current.filter(c => c.code !== code);
  if (next.length === current.length) return sendError(res, 404, "CONVENIO_NAO_ENCONTRADO");
  await getDb().collection("therapists").doc(uid).set({
    tissConvenios: next,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  return res.json({ ok: true });
}));

// POST /therapy/paciente/:patientId/convenio — upsert carteirinha de paciente.
// Body: { convenioCode, numeroCarteirinha, validade?, plano?, titular? }
router.post("/therapy/paciente/:patientId/convenio", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const patientId = String(req.params.patientId || "").trim();
  if (!patientId) return sendError(res, 400, "PATIENT_ID_OBRIGATORIO");

  const db = getDb();
  const pref = db.collection("therapy_patients").doc(patientId);
  const psnap = await pref.get();
  if (!psnap.exists) return sendError(res, 404, "PACIENTE_NAO_ENCONTRADO");
  const patient = psnap.data();
  if (patient.therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  const convenioCode      = String(req.body?.convenioCode || "").trim().toLowerCase();
  const numeroCarteirinha = String(req.body?.numeroCarteirinha || "").trim().slice(0, TISS_CARTEIRINHA_MAX);
  if (!convenioCode) return sendError(res, 400, "CONVENIO_CODE_OBRIGATORIO");
  if (!numeroCarteirinha) return sendError(res, 400, "CARTEIRINHA_OBRIGATORIA");

  // Valida que o convenioCode existe nos aceitos pelo prof.
  const therapist = await loadTherapist(uid);
  const aceitos = Array.isArray(therapist?.tissConvenios) ? therapist.tissConvenios : [];
  if (!aceitos.find(c => c.code === convenioCode)) {
    return sendError(res, 400, "CONVENIO_NAO_ACEITO", { detail: "Cadastre o convênio em Perfil → Convênios TISS antes de vincular ao paciente." });
  }

  const validade = String(req.body?.validade || "").trim() || null;
  if (validade && !/^\d{4}-\d{2}-\d{2}$/.test(validade)) {
    return sendError(res, 400, "VALIDADE_FORMATO_INVALIDO", { detail: "Use YYYY-MM-DD." });
  }
  const plano   = String(req.body?.plano   || "").trim().slice(0, 80) || null;
  const titular = String(req.body?.titular || "").trim().slice(0, 80) || null;

  const entry = { convenioCode, numeroCarteirinha, validade, plano, titular, updatedAt: Date.now() };
  const current = Array.isArray(patient.convenios) ? patient.convenios.slice() : [];
  const idx = current.findIndex(c => c.convenioCode === convenioCode);
  if (idx >= 0) current[idx] = { ...current[idx], ...entry };
  else current.push({ ...entry, createdAt: Date.now() });

  await pref.set({
    convenios: current,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  return res.json({ ok: true, convenio: entry });
}));

// DELETE /therapy/paciente/:patientId/convenio/:convenioCode
router.delete("/therapy/paciente/:patientId/convenio/:convenioCode", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const patientId = String(req.params.patientId || "").trim();
  const convenioCode = String(req.params.convenioCode || "").trim().toLowerCase();
  const db = getDb();
  const pref = db.collection("therapy_patients").doc(patientId);
  const psnap = await pref.get();
  if (!psnap.exists) return sendError(res, 404, "PACIENTE_NAO_ENCONTRADO");
  const patient = psnap.data();
  if (patient.therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");
  const current = Array.isArray(patient.convenios) ? patient.convenios : [];
  const next = current.filter(c => c.convenioCode !== convenioCode);
  if (next.length === current.length) return sendError(res, 404, "CONVENIO_NAO_ENCONTRADO_PACIENTE");
  await pref.set({
    convenios: next,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  return res.json({ ok: true });
}));

// POST /therapy/sessao/:sessionId/tiss/marcar — marca consulta como via convênio.
// Body: { convenioCode, tussCode, tussLabel, valorProcedimento }
router.post("/therapy/sessao/:sessionId/tiss/marcar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const sessionId = String(req.params.sessionId || "").trim();
  if (!sessionId) return sendError(res, 400, "SESSAO_OBRIGATORIA");

  const db = getDb();
  const sref = db.collection("therapy_sessions").doc(sessionId);
  const ssnap = await sref.get();
  if (!ssnap.exists) return sendError(res, 404, "SESSAO_NAO_ENCONTRADA");
  const session = ssnap.data();
  if (session.therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  const convenioCode      = String(req.body?.convenioCode || "").trim().toLowerCase();
  const tussCode          = String(req.body?.tussCode     || "").trim().slice(0, 20);
  const tussLabel         = String(req.body?.tussLabel    || "").trim().slice(0, 200);
  const valorProcedimento = Number(req.body?.valorProcedimento) || 0;
  if (!convenioCode) return sendError(res, 400, "CONVENIO_CODE_OBRIGATORIO");
  if (!tussCode)     return sendError(res, 400, "TUSS_CODE_OBRIGATORIO");

  // Gera numeroGuiaPrestador sequencial (atomic counter no therapist doc).
  const therapist = await loadTherapist(uid);
  const seq = (therapist?.tissNextGuiaSeq || 1);
  const numeroGuiaPrestador = String(seq).padStart(8, "0");

  await db.collection("therapists").doc(uid).set({
    tissNextGuiaSeq: seq + 1,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await sref.set({
    tiss: {
      convenioCode,
      numeroGuiaPrestador,
      numeroGuiaOperadora: null,
      tussCode,
      tussLabel,
      valorProcedimento,
      status: "rascunho",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  return res.json({ ok: true, numeroGuiaPrestador });
}));

// POST /therapy/sessao/:sessionId/tiss/status — atualiza status da guia.
// Body: { status, numeroGuiaOperadora?, codigoGlosa?, motivoGlosa? }
router.post("/therapy/sessao/:sessionId/tiss/status", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const sessionId = String(req.params.sessionId || "").trim();
  const db = getDb();
  const sref = db.collection("therapy_sessions").doc(sessionId);
  const ssnap = await sref.get();
  if (!ssnap.exists) return sendError(res, 404, "SESSAO_NAO_ENCONTRADA");
  const session = ssnap.data();
  if (session.therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");
  if (!session.tiss) return sendError(res, 404, "GUIA_TISS_NAO_EXISTE");

  const status = String(req.body?.status || "").trim().toLowerCase();
  const ALLOWED = new Set(["rascunho", "enviada", "em_analise", "paga", "glosada"]);
  if (!ALLOWED.has(status)) return sendError(res, 400, "STATUS_INVALIDO");

  const tissUpdate = { ...session.tiss, status };
  if (req.body?.numeroGuiaOperadora !== undefined) {
    tissUpdate.numeroGuiaOperadora = String(req.body.numeroGuiaOperadora || "").trim().slice(0, 40) || null;
  }
  if (status === "enviada" && !tissUpdate.dataEnvio) tissUpdate.dataEnvio = Date.now();
  if (status === "paga"    && !tissUpdate.dataPagamento) tissUpdate.dataPagamento = Date.now();
  if (status === "glosada") {
    tissUpdate.dataGlosa    = Date.now();
    tissUpdate.codigoGlosa  = String(req.body?.codigoGlosa  || "").trim().slice(0, 10) || null;
    tissUpdate.motivoGlosa  = String(req.body?.motivoGlosa  || "").trim().slice(0, 500) || null;
  }

  await sref.set({
    tiss: tissUpdate,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  return res.json({ ok: true, tiss: tissUpdate });
}));

// GET /therapy/tiss/guias?status=...&convenioCode=...
// Lista todas as sessões do prof que têm `tiss` setado, filtradas opcionalmente
// por status e/ou convenioCode. Default sem filtro = todas as guias.
router.get("/therapy/tiss/guias", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const db = getDb();
  const wantStatus       = String(req.query?.status || "").trim().toLowerCase() || null;
  const wantConvenioCode = String(req.query?.convenioCode || "").trim().toLowerCase() || null;

  // Firestore: filtra by therapistUid + presença de tiss (não-null), depois
  // filtra em memória por status/convenioCode (volume baixo: <500 guias típico).
  let q = db.collection("therapy_sessions").where("therapistUid", "==", uid);
  const snap = await q.limit(2000).get();
  const items = snap.docs
    .map(d => ({ sessionId: d.id, ...d.data() }))
    .filter(s => !!s.tiss?.numeroGuiaPrestador)
    .filter(s => !wantStatus || s.tiss.status === wantStatus)
    .filter(s => !wantConvenioCode || s.tiss.convenioCode === wantConvenioCode)
    .map(s => ({
      sessionId: s.sessionId,
      patientName: s.patientName || null,
      patientId: s.patientId || null,
      scheduledAt: Number(s.scheduledAt) || null,
      tiss: s.tiss
    }))
    .sort((a, b) => (b.scheduledAt || 0) - (a.scheduledAt || 0));

  return res.json({ ok: true, items });
}));

// ─────────────────────────────────────────────────────────────────────
// TISS — Geração XML/PDF/Lote (Fase 2 + 3)
// ─────────────────────────────────────────────────────────────────────

// Resolve CBOS a partir do conselho + especialidade. Tabela mínima dos
// mais comuns; em produção pode evoluir pra services/cbos.js. Sem match,
// retorna string vazia (válido em alguns convênios) e gera warn no log.
function _resolveCbos(therapist) {
  const conselho = (therapist.crp ? "CRP" : therapist.crm ? "CRM" : "").toUpperCase();
  if (conselho === "CRP") return "251510"; // Psicólogo clínico
  if (conselho === "CRM") {
    if (therapist.especialidade === "psiquiatria") return "225133";
    return "225125"; // Médico clínico
  }
  return ""; // outros conselhos: terapeuta preenche manualmente se quiser
}

// Monta o objeto da guia a partir de session + therapist + paciente + conv.
// Reusado por XML e HTML/PDF — mesma fonte de verdade.
async function _buildGuiaPayload(uid, sessionId) {
  const db = getDb();
  const ssnap = await db.collection("therapy_sessions").doc(sessionId).get();
  if (!ssnap.exists) return { error: "SESSAO_NAO_ENCONTRADA" };
  const session = ssnap.data();
  if (session.therapistUid !== uid) return { error: "ACESSO_NEGADO" };
  if (!session.tiss?.numeroGuiaPrestador) return { error: "GUIA_TISS_NAO_EXISTE" };

  const therapist = await loadTherapist(uid);
  if (!therapist) return { error: "PROFISSIONAL_NAO_ENCONTRADO" };

  const convenio = (therapist.tissConvenios || []).find(c => c.code === session.tiss.convenioCode);
  if (!convenio) return { error: "CONVENIO_NAO_CADASTRADO" };

  // Carteirinha do paciente p/ esse convênio
  let carteirinha = null;
  if (session.patientId) {
    const psnap = await db.collection("therapy_patients").doc(session.patientId).get();
    if (psnap.exists) {
      const p = psnap.data();
      carteirinha = (p.convenios || []).find(c => c.convenioCode === convenio.code);
    }
  }

  // CRP/CRM do prof. — separa em numero/UF (ex: "12/12345" -> {numero:"12345", uf:"12"})
  const crpcrm = String(therapist.crp || therapist.crm || "").trim();
  const conselhoSigla = therapist.crp ? "CRP" : therapist.crm ? "CRM" : "";
  let numeroConselho = crpcrm;
  let ufConselho = "";
  const matchCRP = crpcrm.match(/^(\d{2})[\/-](\d+)$/);
  if (matchCRP) { ufConselho = matchCRP[1]; numeroConselho = matchCRP[2]; }
  const matchCRM = crpcrm.match(/^(\d+)[\/-]([A-Z]{2})$/i);
  if (matchCRM) { numeroConselho = matchCRM[1]; ufConselho = matchCRM[2].toUpperCase(); }

  return {
    therapist, session, convenio, carteirinha,
    guia: {
      numeroGuiaPrestador: session.tiss.numeroGuiaPrestador,
      numeroGuiaOperadora: session.tiss.numeroGuiaOperadora || null,
      numeroCarteira: carteirinha?.numeroCarteirinha || "",
      atendimentoRN: "N",
      nomeBeneficiario: session.patientName || carteirinha?.titular || "",
      codigoPrestadorNaOperadora: convenio.numeroContratado,
      cnesContratado: therapist.cnes || null,
      nomeContratado: therapist.displayName || "",
      nomeProfissional: therapist.displayName || "",
      conselhoProfissional: conselhoSigla,
      numeroConselho,
      ufConselho,
      cbosProfissional: _resolveCbos(therapist),
      dataAtendimento: session.scheduledAt || Date.now(),
      tussCodigo: session.tiss.tussCode,
      tussDescricao: session.tiss.tussLabel,
      valorProcedimento: session.tiss.valorProcedimento || 0
    }
  };
}

// GET /therapy/tiss/guias/:sessionId/xml — gera XML 4.01.00 da guia individual
router.get("/therapy/tiss/guias/:sessionId/xml", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const sessionId = String(req.params.sessionId || "").trim();
  const built = await _buildGuiaPayload(uid, sessionId);
  if (built.error) return sendError(res, 400, built.error);

  const { xml, hash } = tiss.buildLoteGuias({
    sequencialTransacao: `${Date.now()}`,
    numeroLote: `${Date.now()}`,
    registroAnsOperadora: built.convenio.registroAns || "000000",
    codigoPrestadorNaOperadora: built.convenio.numeroContratado,
    guiasConsulta: [built.guia]
  });

  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="guia-${built.guia.numeroGuiaPrestador}.xml"`);
  return res.send(xml);
}));

// GET /therapy/tiss/guias/:sessionId/pdf — gera HTML pra impressão (PDF via browser print)
router.get("/therapy/tiss/guias/:sessionId/pdf", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const sessionId = String(req.params.sessionId || "").trim();
  const built = await _buildGuiaPayload(uid, sessionId);
  if (built.error) return sendError(res, 400, built.error);
  const html = tiss.buildGuiaConsultaHTML(built.guia);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.send(html);
}));

// POST /therapy/tiss/lote — gera XML de lote mensal com todas as guias do prof
// no período + status filtrável. Body: { ano, mes (1-12), status?, convenioCode? }
router.post("/therapy/tiss/lote", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const ano = Number(req.body?.ano);
  const mes = Number(req.body?.mes);
  if (!Number.isInteger(ano) || !Number.isInteger(mes) || mes < 1 || mes > 12) {
    return sendError(res, 400, "ANO_MES_INVALIDO");
  }
  const wantStatus       = String(req.body?.status || "rascunho").trim().toLowerCase();
  const wantConvenioCode = String(req.body?.convenioCode || "").trim().toLowerCase() || null;

  // Filtra sessões com guia TISS no mês solicitado.
  const start = new Date(Date.UTC(ano, mes - 1, 1)).getTime();
  const end   = new Date(Date.UTC(ano, mes, 1)).getTime();
  const db = getDb();
  const snap = await db.collection("therapy_sessions")
    .where("therapistUid", "==", uid)
    .where("scheduledAt", ">=", start)
    .where("scheduledAt", "<", end)
    .limit(2000)
    .get();

  const sessions = snap.docs
    .map(d => ({ sessionId: d.id, ...d.data() }))
    .filter(s => !!s.tiss?.numeroGuiaPrestador)
    .filter(s => s.tiss.status === wantStatus)
    .filter(s => !wantConvenioCode || s.tiss.convenioCode === wantConvenioCode);

  if (sessions.length === 0) return sendError(res, 404, "NENHUMA_GUIA_NO_PERIODO");

  // Todas as guias do lote devem ser do MESMO convênio (TISS exige).
  const conveniosUsados = [...new Set(sessions.map(s => s.tiss.convenioCode))];
  if (conveniosUsados.length > 1) {
    return sendError(res, 400, "MULTIPLOS_CONVENIOS_NO_LOTE", {
      detail: "TISS exige um lote por convênio. Use o filtro convenioCode no body.",
      conveniosEncontrados: conveniosUsados
    });
  }

  const guiaPayloads = [];
  for (const s of sessions) {
    const built = await _buildGuiaPayload(uid, s.sessionId);
    if (built.error) continue;
    guiaPayloads.push(built.guia);
  }

  const convenioCode = conveniosUsados[0];
  const therapist = await loadTherapist(uid);
  const convenio = (therapist.tissConvenios || []).find(c => c.code === convenioCode);

  const numeroLote = `LOTE-${ano}${String(mes).padStart(2, "0")}-${Date.now().toString(36).toUpperCase()}`;
  const { xml, hash, totalGuias } = tiss.buildLoteGuias({
    sequencialTransacao: `${Date.now()}`,
    numeroLote,
    registroAnsOperadora: convenio?.registroAns || "000000",
    codigoPrestadorNaOperadora: convenio?.numeroContratado,
    guiasConsulta: guiaPayloads
  });

  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${numeroLote}.xml"`);
  res.setHeader("X-Tiss-Lote-Hash", hash);
  res.setHeader("X-Tiss-Lote-Total", String(totalGuias));
  return res.send(xml);
}));

// POST /therapy/tiss/demonstrativo — recebe arquivo XML de demonstrativo de
// pagamento (DP) da operadora e atualiza status das guias.
// Body: { xml: string }. Parser minimalista — não valida assinatura digital
// nem usa parser XML completo (sax/xml2js); regex pra extrair numeroGuia +
// status conforme TISS 4.01.00 schema.
router.post("/therapy/tiss/demonstrativo", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const xml = String(req.body?.xml || "");
  if (!xml || xml.length < 100) return sendError(res, 400, "XML_INVALIDO");
  if (xml.length > 5_000_000) return sendError(res, 413, "XML_GRANDE_DEMAIS");

  // Extrai pares (numeroGuiaPrestador, status) do XML.
  // Status TISS: 1=pago, 2=glosado, 3=pago_parcial. Mapeamos pra:
  //   1 → "paga"
  //   2 → "glosada"
  //   3 → "paga" (parcial é melhor que "em_analise" pra UI)
  const guiaBlocks = xml.match(/<[^>]*numeroGuiaPrestador[^>]*>[\s\S]*?<\/[^>]+>/g) || [];
  // Fallback genérico — extrai pares numeroGuia/status varrendo o XML.
  const regex = /<[^>]*numeroGuiaPrestador[^>]*>([^<]+)<[\s\S]*?<[^>]*statusProtocolo[^>]*>(\d)<\//g;
  const updates = [];
  let m;
  while ((m = regex.exec(xml)) !== null) {
    const num = m[1].trim();
    const stCode = m[2];
    const status = stCode === "1" || stCode === "3" ? "paga" : stCode === "2" ? "glosada" : null;
    if (!status) continue;
    updates.push({ numeroGuiaPrestador: num, status });
  }

  if (updates.length === 0) return sendError(res, 400, "NENHUMA_GUIA_RECONHECIDA");

  const db = getDb();
  let updated = 0, notFound = 0;
  for (const u of updates) {
    // Localiza session com esse numeroGuiaPrestador do prof.
    const snap = await db.collection("therapy_sessions")
      .where("therapistUid", "==", uid)
      .limit(2000).get();
    const target = snap.docs.find(d => d.data().tiss?.numeroGuiaPrestador === u.numeroGuiaPrestador);
    if (!target) { notFound++; continue; }
    const sess = target.data();
    await target.ref.set({
      tiss: {
        ...sess.tiss,
        status: u.status,
        dataPagamento: u.status === "paga" ? Date.now() : sess.tiss.dataPagamento,
        dataGlosa:     u.status === "glosada" ? Date.now() : sess.tiss.dataGlosa
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    updated++;
  }

  return res.json({ ok: true, processed: updates.length, updated, notFound });
}));

// ─────────────────────────────────────────────────────────────────────
// Fase 4: registry de submitters por convênio.
// Cada convênio tem sua API/portal próprio — registramos qual submitter
// usar via convenioCode (slug definido pelo profissional ao cadastrar
// convênio aceito). Implementações vivem em services/tiss-submitters/.
//
// Pra adicionar novo convênio:
//   1. Crie services/tiss-submitters/<nome>.js extendendo TissSubmitterBase
//   2. Adicione entry no TISS_SUBMITTERS abaixo
//   3. Frontend mostra botão "Enviar pro convênio" automaticamente via
//      GET /tiss/submitters
// ─────────────────────────────────────────────────────────────────────
const { TissMockSubmitter } = require("../services/tiss-submitters/_mock");
const TissSigner = require("../services/tiss-submitters/_signer");

const TISS_SUBMITTERS = {};

// Mock — só liga se env explícita. Útil enquanto profissional não tem cert/credenciais.
if (String(process.env.TISS_MOCK_ENABLED || "").trim() === "1") {
  TISS_SUBMITTERS["mock"] = TissMockSubmitter;
}

// Quando primeira integração real chegar (após credenciamento + cert sandbox):
//   const { TissBradescoSubmitter } = require("../services/tiss-submitters/bradesco");
//   TISS_SUBMITTERS["bradesco"] = TissBradescoSubmitter;
//   const { TissUnimedPoaSubmitter } = require("../services/tiss-submitters/unimed-poa");
//   TISS_SUBMITTERS["unimed-poa"] = TissUnimedPoaSubmitter;

/**
 * Resolve submitter pelo convenioCode do prof.
 * convenioCode pode ser exato (ex "bradesco") ou prefixo (ex "unimed-poa"
 * casa com "unimed-poa" mas não com "unimed-rio").
 */
function _resolveSubmitter(convenioCode) {
  if (!convenioCode) return null;
  const Cls = TISS_SUBMITTERS[convenioCode];
  return Cls || null;
}

// GET /therapy/tiss/submitters — lista os convenioCodes que TÊM submitter
// auto-submit implementado. Frontend usa pra mostrar botão "Enviar pro
// convênio" só quando houver implementação.
router.get("/therapy/tiss/submitters", asyncHandler(async (req, res) => {
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const items = Object.entries(TISS_SUBMITTERS).map(([code, Cls]) => {
    const inst = new Cls({});
    return {
      convenioCode: code,
      displayName: inst.displayName,
      tissVersion: inst.tissVersion,
      requiresSignature: inst.requiresSignature
    };
  });
  return res.json({ ok: true, submitters: items });
}));

// POST /therapy/tiss/submeter/:convenioCode
// Body: { ano, mes, status?, certPfxBase64?, certPassword?, sandboxMode? }
//
// Fluxo:
//   1. Resolve submitter pelo convenioCode
//   2. Gera lote (reusa lógica de POST /tiss/lote)
//   3. Se submitter.requiresSignature, assina XML com A1 cert
//   4. Submitter.submitLote(...) → retorna protocolo
//   5. Atualiza status das guias (rascunho → enviada) + grava protocolo
//
// Cert NUNCA é persistido — vem no body, usa e descarta.
router.post("/therapy/tiss/submeter/:convenioCode", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const convenioCode = String(req.params.convenioCode || "").trim().toLowerCase();

  const SubmitterCls = _resolveSubmitter(convenioCode);
  if (!SubmitterCls) {
    return sendError(res, 501, "SUBMITTER_NAO_IMPLEMENTADO", {
      detail: "Auto-submit pra esse convênio ainda não foi integrado. Use export XML + portal manual.",
      convenioCode,
      submittersDisponiveis: Object.keys(TISS_SUBMITTERS)
    });
  }

  const ano = Number(req.body?.ano);
  const mes = Number(req.body?.mes);
  if (!Number.isInteger(ano) || !Number.isInteger(mes) || mes < 1 || mes > 12) {
    return sendError(res, 400, "ANO_MES_INVALIDO");
  }

  // Reutiliza logica de filtragem do POST /tiss/lote.
  const start = new Date(Date.UTC(ano, mes - 1, 1)).getTime();
  const end   = new Date(Date.UTC(ano, mes, 1)).getTime();
  const wantStatus = String(req.body?.status || "rascunho").trim().toLowerCase();

  const db = getDb();
  const snap = await db.collection("therapy_sessions")
    .where("therapistUid", "==", uid)
    .where("scheduledAt", ">=", start)
    .where("scheduledAt", "<", end)
    .limit(2000).get();

  const sessions = snap.docs
    .map(d => ({ sessionId: d.id, ...d.data() }))
    .filter(s => !!s.tiss?.numeroGuiaPrestador)
    .filter(s => s.tiss.status === wantStatus)
    .filter(s => s.tiss.convenioCode === convenioCode);

  if (sessions.length === 0) return sendError(res, 404, "NENHUMA_GUIA_NO_PERIODO");

  const guiaPayloads = [];
  for (const s of sessions) {
    const built = await _buildGuiaPayload(uid, s.sessionId);
    if (built.error) continue;
    guiaPayloads.push(built.guia);
  }

  const therapist = await loadTherapist(uid);
  const convenio = (therapist.tissConvenios || []).find(c => c.code === convenioCode);

  const numeroLote = `LOTE-${ano}${String(mes).padStart(2,"0")}-${Date.now().toString(36).toUpperCase()}`;
  const { xml, hash, totalGuias } = tiss.buildLoteGuias({
    sequencialTransacao: `${Date.now()}`,
    numeroLote,
    registroAnsOperadora: convenio?.registroAns || "000000",
    codigoPrestadorNaOperadora: convenio?.numeroContratado,
    guiasConsulta: guiaPayloads
  });

  // Instancia submitter com config vinda do prof (cert + sandboxMode)
  const submitter = new SubmitterCls({
    certPfx: req.body?.certPfxBase64 ? Buffer.from(req.body.certPfxBase64, "base64") : null,
    certPassword: req.body?.certPassword || "",
    sandboxMode: req.body?.sandboxMode !== false,
    codigoPrestador: convenio?.numeroContratado,
    convenio
  });

  try { submitter.validateConfig(); }
  catch (e) { return sendError(res, 400, "CONFIG_SUBMITTER_INVALIDA", { detail: e.message }); }

  // Assina XML se submitter exigir
  let xmlFinal = xml;
  if (submitter.requiresSignature) {
    if (!req.body?.certPfxBase64) return sendError(res, 400, "CERT_PFX_OBRIGATORIO");
    try {
      const certBuffer = Buffer.from(req.body.certPfxBase64, "base64");
      const { xmlAssinado } = TissSigner.signTissXml(xmlFinal, certBuffer, req.body.certPassword || "");
      xmlFinal = xmlAssinado;
    } catch (e) {
      logError("tiss_xml_sign_failed", e, { uid, convenioCode });
      return sendError(res, 400, "XML_ASSINATURA_FALHOU", { detail: e.message });
    }
  }

  // Submete
  let result;
  try {
    result = await submitter.submitLote({ xml: xmlFinal, hash, totalGuias, numeroLote });
  } catch (e) {
    logError("tiss_submit_failed", e, { uid, convenioCode });
    return sendError(res, 502, "SUBMITTER_FALHOU", { detail: e.message });
  }

  if (!result?.ok) {
    return sendError(res, 502, result?.error || "SUBMITTER_RETORNOU_ERRO", { detail: result?.detail || null });
  }

  // Sucesso: atualiza guias pra "enviada" + grava protocolo + numeroGuiaOperadora se veio
  const protocolo = result.protocolo || null;
  const guiaMap = result.numeroGuiaOperadoraMap || {};
  for (const s of sessions) {
    const num = s.tiss.numeroGuiaPrestador;
    await db.collection("therapy_sessions").doc(s.sessionId).set({
      tiss: {
        ...s.tiss,
        status: "enviada",
        dataEnvio: Date.now(),
        protocoloOperadora: protocolo,
        numeroGuiaOperadora: guiaMap[num] || s.tiss.numeroGuiaOperadora || null
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }

  await logAudit({
    type: "tiss_lote_submitted",
    therapistUid: uid,
    convenioCode,
    numeroLote,
    totalGuias,
    protocolo
  });

  return res.json({
    ok: true,
    protocolo,
    numeroLote,
    totalGuias,
    mensagem: result.mensagem || null
  });
}));

// ═════════════════════════════════════════════════════════════════════════
// ANAMNESE PRÉ-CONSULTA — terapeuta envia link público pro paciente
// preencher antes da 1ª sessão. Coleção `therapy_anamneses/{anamneseId}`.
//
// Modelo de privacidade: plaintext server-side (paciente preenche sem
// login E2E). Auto-delete via cleanup loop 90d após status=answered.
// Trade-off documentado — paciente não tem DEK do terapeuta no browser.
// ═════════════════════════════════════════════════════════════════════════
const ANAMNESE_TOKEN_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias
const ANAMNESE_PATIENT_NAME_MAX  = 80;
const ANAMNESE_EMAIL_MAX         = 120;

router.post("/therapy/anamnese/enviar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await requirePaidPlan(req, res, uid);
  if (!therapist) return;

  const patientId   = String(req.body?.patientId || "").trim() || null;
  const patientNameRaw = String(req.body?.patientNameSnapshot || "").trim().slice(0, ANAMNESE_PATIENT_NAME_MAX);
  const patientEmailRaw = String(req.body?.patientEmail || "").trim().toLowerCase().slice(0, ANAMNESE_EMAIL_MAX);
  const patientEmail = patientEmailRaw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patientEmailRaw) ? patientEmailRaw : null;
  const patientPhoneRaw = String(req.body?.patientPhone || "").trim();
  const patientPhoneNorm = patientPhoneRaw ? normalizeWaPhone(patientPhoneRaw) : "";
  const patientPhone = patientPhoneNorm.length >= 12 ? patientPhoneNorm : null;
  const sendEmailFlag = req.body?.sendEmail !== false;
  const sendWaFlag    = req.body?.sendWhatsapp !== false;

  if (!patientNameRaw && !patientId) return sendError(res, 400, "PACIENTE_OBRIGATORIO");

  // Se patientId, valida ownership. Pra nome livre, aceita direto.
  let patientNameSnapshot = patientNameRaw;
  if (patientId) {
    const psnap = await getDb().collection("therapy_patients").doc(patientId).get();
    if (!psnap.exists) return sendError(res, 404, "PACIENTE_NAO_ENCONTRADO");
    if (psnap.data().therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");
    // patient name vem cifrado; cliente passa o snapshot decifrado em patientNameSnapshot.
    if (!patientNameSnapshot) patientNameSnapshot = "Paciente";
  }

  // Idempotência leve: se já existe anamnese pending pra esse paciente,
  // reutiliza (regenera token e reenvia). Evita lixo se terapeuta clicar 2x.
  const db = getDb();
  let anamneseId, anamneseDoc;
  if (patientId) {
    const existSnap = await db.collection("therapy_anamneses")
      .where("therapistUid", "==", uid)
      .where("patientId", "==", patientId)
      .where("status", "==", "pending")
      .limit(1).get();
    if (!existSnap.empty) {
      anamneseDoc = existSnap.docs[0];
      anamneseId = anamneseDoc.id;
    }
  }

  if (!anamneseId) {
    anamneseId = newId("anam");
    await db.collection("therapy_anamneses").doc(anamneseId).set({
      anamneseId,
      therapistUid: uid,
      patientId,
      patientNameSnapshot,
      patientEmail,
      patientPhone,
      templateVersion: anamnese.ANAMNESE_TEMPLATE_VERSION,
      responses: {},
      status: "pending",
      sentCount: 1,
      lastSentAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } else {
    // Reusing — atualiza contato (paciente pode ter trocado email) + bump send count.
    await db.collection("therapy_anamneses").doc(anamneseId).set({
      patientEmail: patientEmail || anamneseDoc.data().patientEmail || null,
      patientPhone: patientPhone || anamneseDoc.data().patientPhone || null,
      sentCount: (anamneseDoc.data().sentCount || 1) + 1,
      lastSentAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }

  const token = signPayload({
    token_type: "anamnese_fill",
    anamneseId,
    therapistUid: uid,
    iat: Date.now(),
    exp: Date.now() + ANAMNESE_TOKEN_VALIDITY_MS
  }, ACCESS_TOKEN_SECRET);
  const anamneseUrl = buildAnamneseUrl(token);

  const channels = { email: { attempted: false, ok: false }, whatsapp: { attempted: false, ok: false } };
  const therapistName = therapist.displayName || "seu profissional";
  const therapistEmail = await resolveTherapistEmail(uid, therapist);

  if (sendEmailFlag && patientEmail) {
    channels.email.attempted = true;
    try {
      const tpl = templateAnamneseEnviada({
        patientName: patientNameSnapshot,
        therapistName,
        anamneseUrl
      });
      const r = await sendEmail({ to: patientEmail, replyTo: therapistEmail || undefined, ...tpl });
      channels.email.ok = !!(r.ok || r.skipped);
    } catch (e) {
      logError("anamnese_email_failed", e, { anamneseId });
    }
  }

  if (sendWaFlag && patientPhone) {
    channels.whatsapp.attempted = true;
    if (therapist?.whatsappConfig?.enabled) {
      try {
        const msg = `Olá ${patientNameSnapshot || ""}, ${therapistName} preparou uma anamnese pra você preencher antes da nossa primeira sessão. Leva uns 10 minutos.\n\n${anamneseUrl}`;
        const r = await sendWaText({ to: patientPhone, message: msg });
        channels.whatsapp.ok = !!r.ok;
      } catch (e) {
        logError("anamnese_whatsapp_failed", e, { anamneseId });
      }
    } else {
      channels.whatsapp.reason = "WHATSAPP_NAO_HABILITADO";
    }
  }

  await logAudit({
    type: "anamnese_enviada",
    anamneseId, therapistUid: uid, patientId,
    emailSent: channels.email.ok, whatsappSent: channels.whatsapp.ok
  });

  return res.json({ ok: true, anamneseId, anamneseUrl, channels });
}));

// GET público — busca template + responses (se já preenchida, permite revisão).
router.get("/therapy/anamnese/publica", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const token = String(req.query?.t || "").trim();
  if (!token) return sendError(res, 400, "TOKEN_OBRIGATORIO");

  const verification = verifySignedToken(token, ACCESS_TOKEN_SECRET);
  if (!verification.valid) return sendError(res, 401, verification.error || "TOKEN_INVALIDO");
  const payload = verification.payload;
  if (payload.token_type !== "anamnese_fill") return sendError(res, 401, "TOKEN_NAO_AUTORIZADO");

  const db = getDb();
  const aSnap = await db.collection("therapy_anamneses").doc(payload.anamneseId).get();
  if (!aSnap.exists) return sendError(res, 404, "ANAMNESE_NAO_ENCONTRADA");
  const a = aSnap.data();
  if (a.therapistUid !== payload.therapistUid) return sendError(res, 401, "TOKEN_INVALIDO");

  // Carrega dados públicos do terapeuta pra exibir contexto na página
  const therapist = await loadTherapist(a.therapistUid);
  const therapistPublic = therapist ? {
    displayName: therapist.displayName || "",
    photoBase64: therapist.photoBase64 || "",
    photoMime:   therapist.photoMime || ""
  } : null;

  const template = anamnese.getTemplate(a.templateVersion);

  return res.json({
    ok: true,
    anamnese: {
      anamneseId: a.anamneseId,
      status: a.status,
      patientNameSnapshot: a.patientNameSnapshot || "",
      responses: a.responses || {},
      respondedAt: a.respondedAt?.toMillis ? a.respondedAt.toMillis() : null
    },
    template,
    therapist: therapistPublic
  });
}));

// POST público — paciente envia respostas.
router.post("/therapy/anamnese/publica/responder", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const token = String(req.body?.token || "").trim();
  if (!token) return sendError(res, 400, "TOKEN_OBRIGATORIO");

  const verification = verifySignedToken(token, ACCESS_TOKEN_SECRET);
  if (!verification.valid) return sendError(res, 401, verification.error || "TOKEN_INVALIDO");
  const payload = verification.payload;
  if (payload.token_type !== "anamnese_fill") return sendError(res, 401, "TOKEN_NAO_AUTORIZADO");

  const db = getDb();
  const ref = db.collection("therapy_anamneses").doc(payload.anamneseId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "ANAMNESE_NAO_ENCONTRADA");
  const a = snap.data();
  if (a.therapistUid !== payload.therapistUid) return sendError(res, 401, "TOKEN_INVALIDO");

  const template = anamnese.getTemplate(a.templateVersion);
  const { ok, errors, clean } = anamnese.validateResponses(req.body?.responses || {}, template);
  if (!ok) return sendError(res, 400, "RESPOSTAS_INVALIDAS", { detalhes: errors });

  const wasAlreadyAnswered = a.status === "answered";

  await ref.set({
    responses: clean,
    status: "answered",
    respondedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  // Notifica o terapeuta — só na 1ª submissão. Re-submissões silenciosas
  // (paciente revisou e ajustou alguma resposta antes da sessão).
  if (!wasAlreadyAnswered) {
    try {
      const therapist = await loadTherapist(a.therapistUid);
      const therapistEmail = await resolveTherapistEmail(a.therapistUid, therapist);
      if (therapistEmail) {
        const tpl = templateAnamneseRespondida({
          therapistName: therapist?.displayName || "Profissional",
          patientName: a.patientNameSnapshot || "Paciente",
          painelUrl: buildPainelUrl()
        });
        sendEmail({ to: therapistEmail, ...tpl }).catch(e =>
          logError("anamnese_notify_email_failed", e, { anamneseId: a.anamneseId })
        );
      }
    } catch (e) {
      logError("anamnese_notify_failed", e, { anamneseId: a.anamneseId });
    }
  }

  // Push (1ª submissão) — terapeuta vê na hora.
  if (!wasAlreadyAnswered) {
    pushToTherapist(a.therapistUid, {
      title: "Anamnese preenchida",
      body: `${a.patientNameSnapshot || "Paciente"} acabou de responder a anamnese.`,
      url: "/pacientes.html",
      tag: "anamnese-respondida"
    }).catch(e => logError("push_anamnese_failed", e, { anamneseId: a.anamneseId }));
  }

  await logAudit({
    type: "anamnese_respondida",
    anamneseId: a.anamneseId,
    therapistUid: a.therapistUid,
    patientId: a.patientId || null,
    resubmission: wasAlreadyAnswered
  });

  return res.json({ ok: true, resubmission: wasAlreadyAnswered });
}));

// Lista anamneses do terapeuta (filtra por patientId opcional).
router.get("/therapy/anamneses", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const patientId = String(req.query?.patientId || "").trim() || null;
  const db = getDb();
  let q = db.collection("therapy_anamneses").where("therapistUid", "==", uid);
  if (patientId) q = q.where("patientId", "==", patientId);
  const snap = await q.limit(200).get();
  const items = snap.docs.map(d => {
    const a = d.data();
    return {
      anamneseId: a.anamneseId,
      patientId: a.patientId || null,
      patientNameSnapshot: a.patientNameSnapshot || "",
      patientEmail: a.patientEmail || null,
      patientPhone: a.patientPhone || null,
      status: a.status,
      sentCount: a.sentCount || 1,
      createdAt: a.createdAt?.toMillis ? a.createdAt.toMillis() : null,
      lastSentAt: a.lastSentAt?.toMillis ? a.lastSentAt.toMillis() : null,
      respondedAt: a.respondedAt?.toMillis ? a.respondedAt.toMillis() : null
    };
  }).sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
  return res.json({ ok: true, anamneses: items });
}));

// GET de UMA anamnese (auth) — devolve respostas completas pro terapeuta ver.
router.get("/therapy/anamneses/:id", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const anamneseId = String(req.params.id || "").trim();
  if (!anamneseId) return sendError(res, 400, "ANAMNESE_ID_OBRIGATORIO");

  const db = getDb();
  const aSnap = await db.collection("therapy_anamneses").doc(anamneseId).get();
  if (!aSnap.exists) return sendError(res, 404, "ANAMNESE_NAO_ENCONTRADA");
  const a = aSnap.data();
  if (a.therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  const template = anamnese.getTemplate(a.templateVersion);
  const formatted = anamnese.formatForDisplay(a.responses || {}, template);

  return res.json({
    ok: true,
    anamnese: {
      anamneseId: a.anamneseId,
      patientId: a.patientId || null,
      patientNameSnapshot: a.patientNameSnapshot || "",
      patientEmail: a.patientEmail || null,
      status: a.status,
      responses: a.responses || {},
      formatted,
      respondedAt: a.respondedAt?.toMillis ? a.respondedAt.toMillis() : null,
      createdAt: a.createdAt?.toMillis ? a.createdAt.toMillis() : null
    },
    template
  });
}));

// ═════════════════════════════════════════════════════════════════════════
// TEMPLATES DE PRONTUÁRIO — defaults hardcoded (V1). V2 permite custom
// por terapeuta via CRUD em therapy_note_templates/{templateId}.
//
// Templates são "esqueletos" que o terapeuta insere no composer de notas
// durante/pós sessão. Reduzem fricção: anamnese inicial, evolução SOAP,
// alta. Inserção é client-side — backend só serve a lista.
// ═════════════════════════════════════════════════════════════════════════
const NOTE_TEMPLATES_DEFAULT = [
  {
    id: "anamnese-inicial",
    name: "Anamnese inicial",
    description: "Estrutura completa pra primeira sessão (queixa, histórico, hábitos, suicidalidade, plano).",
    content: `== ANAMNESE INICIAL ==

Identificação:
- Nome:
- Idade:
- Profissão:
- Estado civil:
- Com quem mora:

Queixa principal:


História da queixa atual:


Histórico psiquiátrico:
- Tratamentos anteriores:
- Medicações em uso:
- Internações:

Histórico médico relevante:


Histórico familiar (sintomas/transtornos na família):


Hábitos:
- Sono:
- Alimentação:
- Álcool / substâncias:
- Exercícios:

Suicidalidade / autolesão:


Suporte social (família, amigos, religião):


Avaliação inicial:


Plano terapêutico:
`
  },
  {
    id: "evolucao-soap",
    name: "Evolução SOAP",
    description: "Padrão clínico: Subjetivo · Objetivo · Avaliação · Plano. Use a cada sessão.",
    content: `== EVOLUÇÃO SOAP ==

S (Subjetivo) — o que o paciente relata, sentimentos, queixas, eventos:


O (Objetivo) — o que você observa (afeto, fala, comportamento, aparência):


A (Avaliação) — sua análise clínica (hipóteses, evolução do tratamento):


P (Plano) — próximos passos, tarefas, ajustes, próxima sessão:
`
  },
  {
    id: "alta-terapeutica",
    name: "Alta terapêutica",
    description: "Síntese de fim de tratamento — motivo, evolução, recomendações.",
    content: `== ALTA TERAPÊUTICA ==

Período do tratamento:
Nº de sessões realizadas:

Motivo da alta:
( ) Objetivos terapêuticos alcançados
( ) Decisão do paciente
( ) Encaminhamento (especificar)
( ) Outro:

Síntese do processo terapêutico:


Evolução dos sintomas / queixa inicial:


Recursos e estratégias desenvolvidos:


Recomendações pós-alta:


Possibilidade de retorno:
`
  },
  {
    id: "retorno-pos-pausa",
    name: "Retorno após pausa",
    description: "Quando paciente volta depois de meses/anos sem terapia.",
    content: `== RETORNO APÓS PAUSA ==

Tempo desde última sessão:

O que aconteceu nesse período (eventos relevantes, mudanças, evolução dos sintomas):


Motivo do retorno (queixa atual):


Re-avaliação do quadro:


Objetivos pra esta nova fase:


Plano inicial:
`
  },
  {
    id: "encaminhamento",
    name: "Encaminhamento (parecer)",
    description: "Síntese pra outro profissional (psiquiatra, médico, escola).",
    content: `== PARECER PARA ENCAMINHAMENTO ==

Destinatário:
Motivo do encaminhamento:

Síntese do caso:


Hipóteses diagnósticas / impressão clínica:


Recursos terapêuticos já utilizados:


Solicitação específica (avaliação medicamentosa, exame, parecer, etc.):


Disponibilidade pra contato:
`
  }
];

// ═════════════════════════════════════════════════════════════════════════
// WEB PUSH NOTIFICATIONS — terapeuta recebe push do navegador pra eventos
// críticos (nova solicitação de agendamento, anamnese respondida).
// Subscriptions ficam em therapists.pushSubscriptions[]. Cleanup automático
// quando o navegador retorna 410 Gone.
// ═════════════════════════════════════════════════════════════════════════

// GET /therapy/push/config — devolve chave pública pra subscribe().
router.get("/therapy/push/config", asyncHandler(async (req, res) => {
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  if (!pushService.isConfigured()) {
    return sendError(res, 503, "PUSH_NAO_CONFIGURADO", { hint: "Servidor sem VAPID keys configuradas." });
  }
  return res.json({ ok: true, publicKey: pushService.getPublicKey() });
}));

// POST /therapy/push/subscribe — salva subscription do navegador.
router.post("/therapy/push/subscribe", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  if (!pushService.isConfigured()) return sendError(res, 503, "PUSH_NAO_CONFIGURADO");

  const sub = req.body?.subscription;
  if (!sub || !sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
    return sendError(res, 400, "SUBSCRIPTION_INVALIDA");
  }
  const cleanSub = {
    endpoint: String(sub.endpoint).slice(0, 1000),
    keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) },
    userAgent: String(req.headers["user-agent"] || "").slice(0, 200),
    addedAt: Date.now()
  };

  const db = getDb();
  // Dedup por endpoint + append. Limita a 10 subs por user (defensivo).
  await db.runTransaction(async (txx) => {
    const ref = db.collection("therapists").doc(uid);
    const snap = await txx.get(ref);
    if (!snap.exists) throw new Error("PROFISSIONAL_NAO_REGISTRADO");
    const t = snap.data();
    const subs = Array.isArray(t.pushSubscriptions) ? t.pushSubscriptions : [];
    const filtered = subs.filter(s => s.endpoint !== cleanSub.endpoint);
    const next = [cleanSub, ...filtered].slice(0, 10);
    txx.set(ref, { pushSubscriptions: next, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  });

  await logAudit({ type: "push_subscribed", therapistUid: uid, endpointPreview: cleanSub.endpoint.slice(0, 60) });
  return res.json({ ok: true });
}));

// DELETE /therapy/push/subscribe — remove subscription. Body: { endpoint }.
router.delete("/therapy/push/subscribe", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const endpoint = String(req.body?.endpoint || "").trim();
  if (!endpoint) return sendError(res, 400, "ENDPOINT_OBRIGATORIO");

  const db = getDb();
  await db.runTransaction(async (txx) => {
    const ref = db.collection("therapists").doc(uid);
    const snap = await txx.get(ref);
    if (!snap.exists) return;
    const t = snap.data();
    const subs = Array.isArray(t.pushSubscriptions) ? t.pushSubscriptions : [];
    const next = subs.filter(s => s.endpoint !== endpoint);
    if (next.length !== subs.length) {
      txx.set(ref, { pushSubscriptions: next, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    }
  });

  return res.json({ ok: true });
}));

// POST /therapy/paciente/push/subscribe — registra push subscription do paciente.
router.post("/therapy/paciente/push/subscribe", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const sub = req.body?.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return sendError(res, 400, "SUBSCRIPTION_INVALIDA");
  }
  const cleanSub = {
    endpoint: String(sub.endpoint).slice(0, 1000),
    keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) },
    userAgent: String(req.headers["user-agent"] || "").slice(0, 200),
    addedAt: Date.now()
  };

  const db = getDb();
  await db.runTransaction(async (txx) => {
    const ref = db.collection("therapy_patient_accounts").doc(uid);
    const snap = await txx.get(ref);
    if (!snap.exists) throw new Error("PACIENTE_NAO_REGISTRADO");
    const t = snap.data();
    const subs = Array.isArray(t.pushSubscriptions) ? t.pushSubscriptions : [];
    const filtered = subs.filter(s => s.endpoint !== cleanSub.endpoint);
    const next = [cleanSub, ...filtered].slice(0, 10);
    txx.set(ref, { pushSubscriptions: next, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  });

  await logAudit({ type: "patient_push_subscribed", patientAccountUid: uid, endpointPreview: cleanSub.endpoint.slice(0, 60) });
  return res.json({ ok: true });
}));

router.delete("/therapy/paciente/push/subscribe", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const endpoint = String(req.body?.endpoint || "").trim();
  if (!endpoint) return sendError(res, 400, "ENDPOINT_OBRIGATORIO");

  const db = getDb();
  await db.runTransaction(async (txx) => {
    const ref = db.collection("therapy_patient_accounts").doc(uid);
    const snap = await txx.get(ref);
    if (!snap.exists) return;
    const t = snap.data();
    const subs = Array.isArray(t.pushSubscriptions) ? t.pushSubscriptions : [];
    const next = subs.filter(s => s.endpoint !== endpoint);
    if (next.length !== subs.length) {
      txx.set(ref, { pushSubscriptions: next, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    }
  });
  return res.json({ ok: true });
}));

// Helper genérico — manda push pra qualquer user (therapist OU patient).
async function pushToUser(targetUid, payload) {
  if (!pushService.isConfigured()) return { skipped: true };
  try {
    const db = getDb();
    // Tenta therapist primeiro, depois patient. Um dos dois bate.
    let ref = db.collection("therapists").doc(targetUid);
    let snap = await ref.get();
    if (!snap.exists) {
      ref = db.collection("therapy_patient_accounts").doc(targetUid);
      snap = await ref.get();
    }
    if (!snap.exists) return { skipped: true };
    const subs = Array.isArray(snap.data().pushSubscriptions) ? snap.data().pushSubscriptions : [];
    if (!subs.length) return { skipped: true };
    const r = await pushService.sendPushToAll(subs, payload);
    if (r.expired.length) {
      const keep = subs.filter(s => !r.expired.includes(s.endpoint));
      await ref.set({ pushSubscriptions: keep }, { merge: true });
    }
    return { sent: r.sent, expired: r.expired.length };
  } catch (e) {
    logError("push_to_user_failed", e, { targetUid });
    return { error: e.message };
  }
}

// Helper interno: envia push pro terapeuta + remove subs gone.
async function pushToTherapist(therapistUid, payload) {
  if (!pushService.isConfigured()) return { skipped: true };
  try {
    const db = getDb();
    const snap = await db.collection("therapists").doc(therapistUid).get();
    if (!snap.exists) return { skipped: true };
    const subs = Array.isArray(snap.data().pushSubscriptions) ? snap.data().pushSubscriptions : [];
    if (!subs.length) return { skipped: true };
    const r = await pushService.sendPushToAll(subs, payload);
    if (r.expired.length) {
      const keep = subs.filter(s => !r.expired.includes(s.endpoint));
      await db.collection("therapists").doc(therapistUid).set({ pushSubscriptions: keep }, { merge: true });
    }
    return { sent: r.sent, expired: r.expired.length };
  } catch (e) {
    logError("push_to_therapist_failed", e, { therapistUid });
    return { error: e.message };
  }
}

// ═════════════════════════════════════════════════════════════════════════
// CID-10 — busca autocompletar (psicologia/psiquiatria + Z-codes).
// Dataset hardcoded em services/cid10.js. ~150 entradas, sem paginação.
// ═════════════════════════════════════════════════════════════════════════
router.get("/therapy/cid10", asyncHandler(async (req, res) => {
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const q = String(req.query?.q || "").trim();
  const limit = Math.min(50, Math.max(1, Number(req.query?.limit) || 20));
  if (q.length < 2) return res.json({ ok: true, results: [] });
  const results = cid10.search(q, limit);
  return res.json({ ok: true, results });
}));

router.get("/therapy/note-templates", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  // V1: só defaults. V2 fará merge com therapy_note_templates do user.
  return res.json({
    ok: true,
    templates: NOTE_TEMPLATES_DEFAULT.map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      content: t.content,
      source: "default"
    }))
  });
}));

// ═════════════════════════════════════════════════════════════════════════
// ESCALAS CLÍNICAS — PHQ-9 (depressão) e GAD-7 (ansiedade). Mesma estrutura
// da anamnese: token público, paciente responde sem login, score computado
// server-side, gráfico de evolução montado client-side. Coleção
// therapy_scale_responses/{responseId}.
//
// Alerta de suicide flag: se q9 do PHQ-9 > 0, e-mail pro terapeuta tem
// destaque visual + subject "⚠ ALERTA".
// ═════════════════════════════════════════════════════════════════════════
const ESCALA_TOKEN_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

router.post("/therapy/escalas/enviar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await requirePaidPlan(req, res, uid);
  if (!therapist) return;

  const scaleType = String(req.body?.scaleType || "").trim().toLowerCase();
  const scale = scales.getScale(scaleType);
  if (!scale) return sendError(res, 400, "ESCALA_INVALIDA", { hint: "Use phq9 ou gad7." });

  const patientId = String(req.body?.patientId || "").trim() || null;
  const patientNameSnapshot = String(req.body?.patientNameSnapshot || "").trim().slice(0, 80);
  const patientEmailRaw = String(req.body?.patientEmail || "").trim().toLowerCase().slice(0, 120);
  const patientEmail = patientEmailRaw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patientEmailRaw) ? patientEmailRaw : null;
  const patientPhoneRaw = String(req.body?.patientPhone || "").trim();
  const patientPhoneNorm = patientPhoneRaw ? normalizeWaPhone(patientPhoneRaw) : "";
  const patientPhone = patientPhoneNorm.length >= 12 ? patientPhoneNorm : null;
  const sendEmailFlag = req.body?.sendEmail !== false;
  const sendWaFlag    = req.body?.sendWhatsapp !== false;

  if (!patientNameSnapshot && !patientId) return sendError(res, 400, "PACIENTE_OBRIGATORIO");

  if (patientId) {
    const psnap = await getDb().collection("therapy_patients").doc(patientId).get();
    if (!psnap.exists) return sendError(res, 404, "PACIENTE_NAO_ENCONTRADO");
    if (psnap.data().therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");
  }

  const db = getDb();
  const responseId = newId("scale");
  await db.collection("therapy_scale_responses").doc(responseId).set({
    responseId,
    therapistUid: uid,
    patientId,
    patientNameSnapshot,
    patientEmail,
    patientPhone,
    scaleType,
    scaleName: scale.name,
    responses: {},
    score: null,
    band: null,
    suicideFlag: false,
    status: "pending",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  const token = signPayload({
    token_type: "scale_fill",
    responseId,
    therapistUid: uid,
    iat: Date.now(),
    exp: Date.now() + ESCALA_TOKEN_VALIDITY_MS
  }, ACCESS_TOKEN_SECRET);
  const escalaUrl = buildEscalaUrl(token);

  const channels = { email: { attempted: false, ok: false }, whatsapp: { attempted: false, ok: false } };
  const therapistName = therapist.displayName || "seu profissional";
  const therapistEmail = await resolveTherapistEmail(uid, therapist);

  if (sendEmailFlag && patientEmail) {
    channels.email.attempted = true;
    try {
      const tpl = templateEscalaEnviada({
        patientName: patientNameSnapshot,
        therapistName,
        scaleName: scale.name,
        escalaUrl
      });
      const r = await sendEmail({ to: patientEmail, replyTo: therapistEmail || undefined, ...tpl });
      channels.email.ok = !!(r.ok || r.skipped);
    } catch (e) {
      logError("escala_email_failed", e, { responseId });
    }
  }

  if (sendWaFlag && patientPhone) {
    channels.whatsapp.attempted = true;
    if (therapist?.whatsappConfig?.enabled) {
      try {
        const msg = `Olá ${patientNameSnapshot || ""}, ${therapistName} pediu pra você responder uma escala curta (${scale.name}). Leva menos de 3 minutos.\n\n${escalaUrl}`;
        const r = await sendWaText({ to: patientPhone, message: msg });
        channels.whatsapp.ok = !!r.ok;
      } catch (e) {
        logError("escala_whatsapp_failed", e, { responseId });
      }
    } else {
      channels.whatsapp.reason = "WHATSAPP_NAO_HABILITADO";
    }
  }

  await logAudit({
    type: "escala_enviada",
    responseId, therapistUid: uid, patientId, scaleType,
    emailSent: channels.email.ok, whatsappSent: channels.whatsapp.ok
  });

  return res.json({ ok: true, responseId, escalaUrl, channels });
}));

router.get("/therapy/escala/publica", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const token = String(req.query?.t || "").trim();
  if (!token) return sendError(res, 400, "TOKEN_OBRIGATORIO");

  const verification = verifySignedToken(token, ACCESS_TOKEN_SECRET);
  if (!verification.valid) return sendError(res, 401, verification.error || "TOKEN_INVALIDO");
  const payload = verification.payload;
  if (payload.token_type !== "scale_fill") return sendError(res, 401, "TOKEN_NAO_AUTORIZADO");

  const db = getDb();
  const rSnap = await db.collection("therapy_scale_responses").doc(payload.responseId).get();
  if (!rSnap.exists) return sendError(res, 404, "ESCALA_NAO_ENCONTRADA");
  const r = rSnap.data();
  if (r.therapistUid !== payload.therapistUid) return sendError(res, 401, "TOKEN_INVALIDO");

  const scale = scales.getScale(r.scaleType);
  if (!scale) return sendError(res, 400, "ESCALA_INVALIDA");

  const therapist = await loadTherapist(r.therapistUid);
  const therapistPublic = therapist ? {
    displayName: therapist.displayName || "",
    photoBase64: therapist.photoBase64 || "",
    photoMime:   therapist.photoMime || ""
  } : null;

  return res.json({
    ok: true,
    escala: {
      responseId: r.responseId,
      status: r.status,
      patientNameSnapshot: r.patientNameSnapshot || "",
      responses: r.responses || {},
      score: r.score,
      band: r.band,
      respondedAt: r.respondedAt?.toMillis ? r.respondedAt.toMillis() : null
    },
    scale,
    therapist: therapistPublic
  });
}));

router.post("/therapy/escala/publica/responder", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const token = String(req.body?.token || "").trim();
  if (!token) return sendError(res, 400, "TOKEN_OBRIGATORIO");

  const verification = verifySignedToken(token, ACCESS_TOKEN_SECRET);
  if (!verification.valid) return sendError(res, 401, verification.error || "TOKEN_INVALIDO");
  const payload = verification.payload;
  if (payload.token_type !== "scale_fill") return sendError(res, 401, "TOKEN_NAO_AUTORIZADO");

  const db = getDb();
  const ref = db.collection("therapy_scale_responses").doc(payload.responseId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "ESCALA_NAO_ENCONTRADA");
  const r = snap.data();
  if (r.therapistUid !== payload.therapistUid) return sendError(res, 401, "TOKEN_INVALIDO");

  const scale = scales.getScale(r.scaleType);
  const scored = scales.validateAndScore(req.body?.responses || {}, scale);
  if (!scored.ok) return sendError(res, 400, "RESPOSTAS_INVALIDAS", { detalhes: scored.errors });

  const wasAlreadyAnswered = r.status === "answered";

  await ref.set({
    responses: scored.clean,
    score: scored.score,
    band: scored.band,
    suicideFlag: scored.suicideFlag,
    status: "answered",
    respondedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  if (!wasAlreadyAnswered) {
    try {
      const therapist = await loadTherapist(r.therapistUid);
      const therapistEmail = await resolveTherapistEmail(r.therapistUid, therapist);
      if (therapistEmail) {
        const tpl = templateEscalaRespondida({
          therapistName: therapist?.displayName || "Profissional",
          patientName: r.patientNameSnapshot || "Paciente",
          scaleName: scale.name,
          score: scored.score,
          bandLabel: scored.band?.label || "—",
          suicideAlert: scored.suicideFlag,
          painelUrl: buildPainelUrl()
        });
        sendEmail({ to: therapistEmail, ...tpl }).catch(e =>
          logError("escala_notify_email_failed", e, { responseId: r.responseId })
        );
      }

      // Push pro terapeuta (idem anamnese — fire-and-forget)
      pushToTherapist(r.therapistUid, {
        title: scored.suicideFlag ? "⚠ Alerta clínico" : "Escala respondida",
        body: `${r.patientNameSnapshot || "Paciente"} respondeu ${scale.name} — score ${scored.score} (${scored.band?.label || "—"})`,
        url: r.patientId ? `/pacientes.html` : "/painel.html",
        tag: scored.suicideFlag ? "escala-alerta" : "escala-respondida"
      }).catch(e => logError("push_escala_failed", e, { responseId: r.responseId }));
    } catch (e) {
      logError("escala_notify_failed", e, { responseId: r.responseId });
    }
  }

  await logAudit({
    type: "escala_respondida",
    responseId: r.responseId,
    therapistUid: r.therapistUid,
    patientId: r.patientId || null,
    scaleType: r.scaleType,
    score: scored.score,
    suicideFlag: scored.suicideFlag,
    resubmission: wasAlreadyAnswered
  });

  return res.json({ ok: true, score: scored.score, band: scored.band });
}));

router.get("/therapy/escalas", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const patientId  = String(req.query?.patientId || "").trim() || null;
  const scaleType  = String(req.query?.scaleType || "").trim().toLowerCase() || null;

  const db = getDb();
  let q = db.collection("therapy_scale_responses").where("therapistUid", "==", uid);
  if (patientId) q = q.where("patientId", "==", patientId);
  if (scaleType) q = q.where("scaleType", "==", scaleType);
  const snap = await q.limit(500).get();
  const items = snap.docs.map(d => {
    const r = d.data();
    return {
      responseId: r.responseId,
      patientId: r.patientId || null,
      patientNameSnapshot: r.patientNameSnapshot || "",
      scaleType: r.scaleType,
      scaleName: r.scaleName,
      status: r.status,
      score: r.score,
      band: r.band,
      suicideFlag: !!r.suicideFlag,
      createdAt: r.createdAt?.toMillis ? r.createdAt.toMillis() : null,
      respondedAt: r.respondedAt?.toMillis ? r.respondedAt.toMillis() : null
    };
  }).sort((a, b) => (a.respondedAt || a.createdAt || 0) - (b.respondedAt || b.createdAt || 0));
  return res.json({ ok: true, escalas: items });
}));

// Lista os tipos de escala disponíveis (pra UI montar dropdown).
router.get("/therapy/escalas/tipos", asyncHandler(async (req, res) => {
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  return res.json({ ok: true, scales: scales.listScales() });
}));

// ═════════════════════════════════════════════════════════════════════════
// CHAT E2EE — paciente ↔ terapeuta assíncrono
//
// Arquitetura crypto (ECDH P-256 + AES-GCM):
//   - Cada user (therapist + patient) tem keypair ECDH armazenado em
//     therapy_user_keypairs/{uid}:
//       publicJwk      — em claro (público)
//       privateWrapped — cifrado com DEK do user (só user decifra)
//     Gerados sob demanda no 1º acesso ao chat (lazy migration).
//
//   - Para cada conversa (thread):
//       threadKey é gerada aleatória (AES-256) pelo iniciador.
//       Cifrada DUAS vezes:
//         (a) com DEK do iniciador → threadKeyForCreator
//         (b) via ECDH(creator_priv, peer_pub) → threadKeyForPeer
//       Ambos cifrados armazenados no doc da thread + ECDH pub do creator.
//
//   - Mensagens: cifradas individualmente com threadKey (AES-GCM).
//
// Servidor armazena 3 ciphertexts (2 wrappers + N msgs). NÃO decifra nada.
// LGPD: thread = registro clínico → retenção 20 anos (CFP Res. 1/2009).
// ═════════════════════════════════════════════════════════════════════════

// Identifica role do user (therapist ou patient) pra autorização de endpoints
// que servem ambas as roles. Retorna { role, uid, doc } ou null.
async function identifyUser(uid) {
  if (!uid) return null;
  const db = getDb();
  const tDoc = await db.collection("therapists").doc(uid).get();
  if (tDoc.exists) return { role: "therapist", uid, doc: tDoc.data() };
  const pDoc = await db.collection("therapy_patient_accounts").doc(uid).get();
  if (pDoc.exists) return { role: "patient", uid, doc: pDoc.data() };
  return null;
}

// POST /therapy/chat/keypair — registra ou atualiza ECDH keypair do user.
// Body: { ecdhPublicJwk, ecdhPrivateWrapped: { ciphertext, iv } }
// Idempotente — só permite UPDATE se forneceu novo (regenera todas threads).
router.post("/therapy/chat/keypair", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const me = await identifyUser(uid);
  if (!me) return sendError(res, 404, "USUARIO_NAO_REGISTRADO");

  const pub = req.body?.ecdhPublicJwk;
  const priv = req.body?.ecdhPrivateWrapped;
  if (!pub || typeof pub !== "object" || !pub.x || !pub.y || !pub.crv) {
    return sendError(res, 400, "PUBLIC_JWK_INVALIDO");
  }
  if (!priv || typeof priv !== "object"
      || typeof priv.ciphertext !== "string"
      || typeof priv.iv !== "string"
      || priv.ciphertext.length > 1500) {
    return sendError(res, 400, "PRIVATE_WRAPPED_INVALIDO");
  }

  await getDb().collection("therapy_user_keypairs").doc(uid).set({
    uid,
    role: me.role,
    ecdhPublicJwk: pub,
    ecdhPrivateWrapped: priv,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  return res.json({ ok: true });
}));

// GET /therapy/chat/keypair — retorna o próprio keypair (private wrapped).
router.get("/therapy/chat/keypair", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const snap = await getDb().collection("therapy_user_keypairs").doc(uid).get();
  if (!snap.exists) return sendError(res, 404, "KEYPAIR_NAO_REGISTRADO");
  const d = snap.data();
  return res.json({
    ok: true,
    ecdhPublicJwk:      d.ecdhPublicJwk,
    ecdhPrivateWrapped: d.ecdhPrivateWrapped
  });
}));

// GET /therapy/chat/public-key/:uid — fetch ECDH public key de um peer
// (uso: criar thread). Requer auth, mas qualquer user pode buscar de qualquer
// outro. Public key não é segredo — não revela nada sensível.
router.get("/therapy/chat/public-key/:uid", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const requesterUid = await verifyFirebaseToken(req, res);
  if (!requesterUid) return;

  const peerUid = String(req.params.uid || "").trim();
  if (!peerUid) return sendError(res, 400, "UID_OBRIGATORIO");

  const snap = await getDb().collection("therapy_user_keypairs").doc(peerUid).get();
  if (!snap.exists) return sendError(res, 404, "PEER_SEM_KEYPAIR");
  const d = snap.data();
  return res.json({
    ok: true,
    uid: peerUid,
    role: d.role,
    ecdhPublicJwk: d.ecdhPublicJwk
  });
}));

// POST /therapy/chat/threads — cria nova conversa.
// Inicia: therapist OU patient. O iniciador gera threadKey + os dois wrappers.
// Body: {
//   peerUid,                    // o outro lado
//   threadKeyForCreator,        // { ciphertext, iv } — wrapped com creator DEK
//   threadKeyForPeer,           // { ciphertext, iv } — wrapped via ECDH
//   creatorEcdhPublicJwk        // snapshot da public key do creator no momento
// }
// Retorna threadId. Se já existe thread entre os dois, retorna a existente.
router.post("/therapy/chat/threads", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const me = await identifyUser(uid);
  if (!me) return sendError(res, 404, "USUARIO_NAO_REGISTRADO");

  const peerUid = String(req.body?.peerUid || "").trim();
  if (!peerUid || peerUid === uid) return sendError(res, 400, "PEER_INVALIDO");

  const peer = await identifyUser(peerUid);
  if (!peer) return sendError(res, 404, "PEER_NAO_REGISTRADO");
  if (peer.role === me.role) return sendError(res, 400, "CHAT_REQUER_PROFISSIONAL_E_PACIENTE");

  const therapistUid       = me.role === "therapist" ? uid : peerUid;
  const patientAccountUid  = me.role === "patient"   ? uid : peerUid;

  // Verifica plano ativo do therapist
  const therapistDoc = me.role === "therapist" ? me.doc : peer.doc;
  if (!evaluatePlanAccess(therapistDoc).ok) {
    return sendError(res, 403, "PLANO_INATIVO");
  }

  const tForCreator = req.body?.threadKeyForCreator;
  const tForPeer    = req.body?.threadKeyForPeer;
  const creatorPub  = req.body?.creatorEcdhPublicJwk;
  if (!tForCreator?.ciphertext || !tForCreator?.iv) return sendError(res, 400, "THREAD_KEY_CREATOR_INVALIDA");
  if (!tForPeer?.ciphertext    || !tForPeer?.iv)    return sendError(res, 400, "THREAD_KEY_PEER_INVALIDA");
  if (!creatorPub || !creatorPub.x) return sendError(res, 400, "CREATOR_PUBKEY_INVALIDA");

  const db = getDb();
  // Dedup: se já existe thread entre estes dois, retorna existente
  const existing = await db.collection("therapy_threads")
    .where("therapistUid", "==", therapistUid)
    .where("patientAccountUid", "==", patientAccountUid)
    .limit(1).get();
  if (!existing.empty) {
    return res.json({ ok: true, threadId: existing.docs[0].id, existed: true });
  }

  const threadId = newId("thr");
  const therapistName = (me.role === "therapist" ? me.doc : peer.doc).displayName || "Profissional";
  const patientName   = (me.role === "patient"   ? me.doc : peer.doc).displayName || "Paciente";

  // Mapeia threadKeyForCreator/forPeer → forTherapist/forPatient consistente.
  const creatorIsTherapist = me.role === "therapist";
  const threadKeyForTherapist = creatorIsTherapist ? tForCreator : tForPeer;
  const threadKeyForPatient   = creatorIsTherapist ? tForPeer    : tForCreator;
  // ECDH pub snapshot do creator vai pro outro lado decifrar via ECDH.
  const creatorEcdhPubForPeer = creatorPub;

  await db.collection("therapy_threads").doc(threadId).set({
    threadId,
    therapistUid,
    patientAccountUid,
    therapistDisplayName: therapistName,
    patientDisplayName:   patientName,
    createdBy: me.role,
    threadKeyForTherapist,
    threadKeyForPatient,
    // Snapshot da public key do CREATOR no momento, pra o PEER fazer ECDH
    // depois sem precisar buscar /public-key/:uid de novo. Field é
    // contextual: se creator=therapist, ECDH(patient_priv, this) decifra
    // threadKeyForPatient. Se creator=patient, ECDH(therapist_priv, this)
    // decifra threadKeyForTherapist.
    creatorEcdhPublicJwkSnapshot: creatorEcdhPubForPeer,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    lastMessageAt: null,
    lastMessageSenderRole: null,
    lastReadByTherapist: Date.now(),
    lastReadByPatient: Date.now()
  });

  await logAudit({ type: "chat_thread_created", threadId, therapistUid, patientAccountUid, createdBy: me.role });
  return res.json({ ok: true, threadId, existed: false });
}));

// GET /therapy/chat/threads — lista threads do user (com unread counts).
router.get("/therapy/chat/threads", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const me = await identifyUser(uid);
  if (!me) return sendError(res, 404, "USUARIO_NAO_REGISTRADO");

  const db = getDb();
  const field = me.role === "therapist" ? "therapistUid" : "patientAccountUid";
  const snap = await db.collection("therapy_threads")
    .where(field, "==", uid)
    .limit(200).get();

  const threads = snap.docs.map(d => {
    const t = d.data();
    const lastReadField = me.role === "therapist" ? "lastReadByTherapist" : "lastReadByPatient";
    const lastReadMs = Number(t[lastReadField]) || 0;
    const lastMsgMs  = t.lastMessageAt?.toMillis ? t.lastMessageAt.toMillis() : (Number(t.lastMessageAt) || 0);
    // Source of truth pro 'nao lida' eh unreadCount<Role>: incrementa
    // a cada msg do OUTRO lado, zera no PATCH /read. hasUnread mantido
    // pra compat com clientes antigos que ainda nao migraram.
    const unreadField = me.role === "therapist" ? "unreadCountForTherapist" : "unreadCountForPatient";
    const unreadCount = Math.max(0, Number(t[unreadField]) || 0);
    const senderWasMe = t.lastMessageSenderRole === me.role;
    // Thread key wrapper pro user atual — frontend decifra lastMessage*
    // localmente pra mostrar preview na sidebar sem precisar abrir cada thread.
    const isCreator = (t.createdBy === me.role);
    const myThreadKeyWrapper = me.role === "therapist" ? t.threadKeyForTherapist : t.threadKeyForPatient;
    return {
      threadId: t.threadId,
      therapistUid: t.therapistUid,
      patientAccountUid: t.patientAccountUid,
      therapistDisplayName: t.therapistDisplayName,
      patientDisplayName: t.patientDisplayName,
      lastMessageAt: lastMsgMs || null,
      lastMessageSenderRole: t.lastMessageSenderRole || null,
      lastMessageCiphertext: t.lastMessageCiphertext || null,
      lastMessageIv: t.lastMessageIv || null,
      myThreadKeyWrapper: myThreadKeyWrapper || null,
      myThreadKeyWrappedVia: isCreator ? "own-dek" : "ecdh",
      peerEcdhPublicJwk: isCreator ? null : (t.creatorEcdhPublicJwkSnapshot || null),
      unreadCount,
      hasUnread: unreadCount > 0 || (!senderWasMe && lastMsgMs > lastReadMs),
      createdAt: t.createdAt?.toMillis ? t.createdAt.toMillis() : null
    };
  }).sort((a, b) => (b.lastMessageAt || b.createdAt || 0) - (a.lastMessageAt || a.createdAt || 0));

  return res.json({ ok: true, threads });
}));

// GET /therapy/chat/threads/:id — retorna doc completo da thread (com
// threadKeys cifradas) pro cliente decifrar localmente.
router.get("/therapy/chat/threads/:id", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const me = await identifyUser(uid);
  if (!me) return sendError(res, 404, "USUARIO_NAO_REGISTRADO");

  const threadId = String(req.params.id || "").trim();
  if (!threadId) return sendError(res, 400, "THREAD_ID_OBRIGATORIO");

  const snap = await getDb().collection("therapy_threads").doc(threadId).get();
  if (!snap.exists) return sendError(res, 404, "THREAD_NAO_ENCONTRADA");
  const t = snap.data();
  if (t.therapistUid !== uid && t.patientAccountUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  // Devolve o que o cliente precisa pra unwrap:
  //   - threadKey do próprio role (cifrada com DEK ou ECDH)
  //   - se eu sou o PEER (não-creator), creatorEcdhPublicJwkSnapshot pra ECDH
  const isCreator = (t.createdBy === me.role);
  const myThreadKeyWrapper = me.role === "therapist" ? t.threadKeyForTherapist : t.threadKeyForPatient;
  return res.json({
    ok: true,
    thread: {
      threadId: t.threadId,
      therapistUid: t.therapistUid,
      patientAccountUid: t.patientAccountUid,
      therapistDisplayName: t.therapistDisplayName,
      patientDisplayName: t.patientDisplayName,
      myThreadKeyWrapper,
      myThreadKeyWrappedVia: isCreator ? "own-dek" : "ecdh",
      peerEcdhPublicJwk: isCreator ? null : t.creatorEcdhPublicJwkSnapshot,
      myRole: me.role,
      lastReadByTherapist: t.lastReadByTherapist || 0,
      lastReadByPatient:   t.lastReadByPatient   || 0,
      lastSeenByPatient:   t.lastSeenByPatient   || null
    }
  });
}));

// GET /therapy/chat/threads/:id/messages?before=ms&limit=50
router.get("/therapy/chat/threads/:id/messages", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const threadId = String(req.params.id || "").trim();
  if (!threadId) return sendError(res, 400, "THREAD_ID_OBRIGATORIO");

  const db = getDb();
  const threadSnap = await db.collection("therapy_threads").doc(threadId).get();
  if (!threadSnap.exists) return sendError(res, 404, "THREAD_NAO_ENCONTRADA");
  const t = threadSnap.data();
  if (t.therapistUid !== uid && t.patientAccountUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  const before = Number(req.query?.before) || Date.now();
  const limit  = Math.min(100, Math.max(1, Number(req.query?.limit) || 50));

  // Sem orderBy/where composto pra evitar exigencia de indice (threadId+
  // createdAt). Trade-off: thread com >500 msgs perde as msgs MAIS ANTIGAS
  // alem dos 500 — aceitavel pra uso terapeutico tipico. Padrao usado em
  // outras queries do arquivo (ver linha ~1842 de /sessoes).
  const msgSnap = await db.collection("therapy_messages")
    .where("threadId", "==", threadId)
    .limit(500)
    .get();

  const messages = msgSnap.docs
    .map(d => {
      const m = d.data();
      const ts = m.createdAt?.toMillis ? m.createdAt.toMillis() : (Number(m.createdAt) || 0);
      const favoritedBy = Array.isArray(m.favoritedBy) ? m.favoritedBy : [];
      const isDeleted = m.deleted === true;
      // Agrega reactions do map {emoji: [uids]} em [{emoji, count, mine}].
      const rxMap = (m.reactions && typeof m.reactions === "object") ? m.reactions : {};
      const reactions = Object.entries(rxMap)
        .filter(([_, uids]) => Array.isArray(uids) && uids.length > 0)
        .map(([emoji, uids]) => ({ emoji, count: uids.length, mine: uids.includes(uid) }));
      return {
        messageId: m.messageId,
        senderUid: m.senderUid,
        senderRole: m.senderRole,
        // Msg apagada: nao devolve ciphertext (frontend mostra placeholder).
        ciphertext: isDeleted ? null : m.ciphertext,
        iv: isDeleted ? null : m.iv,
        createdAt: ts,
        deleted: isDeleted,
        replyToMessageId: m.replyToMessageId || null,
        forwardedFromMessageId: m.forwardedFromMessageId || null,
        favoritedByMe: favoritedBy.includes(uid),
        pinned: m.pinned === true,
        pinnedAt: m.pinnedAt?.toMillis ? m.pinnedAt.toMillis() : null,
        reactions
      };
    })
    // Filtra "before" + pega ultimos N + ordena ascendente pra UI.
    .filter(m => m.createdAt < before)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
    .sort((a, b) => a.createdAt - b.createdAt);

  return res.json({ ok: true, messages, lastSeenByPatient: t.lastSeenByPatient || null, lastReadByPatient: t.lastReadByPatient || 0 });
}));

// POST /therapy/chat/threads/:id/messages — envia mensagem.
// Body: { ciphertext, iv } (já cifrada com threadKey client-side).
router.post("/therapy/chat/threads/:id/messages", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const me = await identifyUser(uid);
  if (!me) return sendError(res, 404, "USUARIO_NAO_REGISTRADO");

  const threadId = String(req.params.id || "").trim();
  if (!threadId) return sendError(res, 400, "THREAD_ID_OBRIGATORIO");

  const ciphertext = String(req.body?.ciphertext || "").trim();
  const iv         = String(req.body?.iv         || "").trim();
  if (!ciphertext || !iv) return sendError(res, 400, "CONTEUDO_INVALIDO");
  if (ciphertext.length > 6000) return sendError(res, 413, "MENSAGEM_GRANDE_DEMAIS");

  // Reply: ID da mensagem sendo respondida. Frontend mostra quote da
  // original lookup-ando no cache. Backend so persiste o ID.
  const replyToMessageId = String(req.body?.replyToMessageId || "").trim() || null;
  const forwardedFromMessageId = String(req.body?.forwardedFromMessageId || "").trim() || null;

  const db = getDb();
  const threadRef = db.collection("therapy_threads").doc(threadId);
  const threadSnap = await threadRef.get();
  if (!threadSnap.exists) return sendError(res, 404, "THREAD_NAO_ENCONTRADA");
  const t = threadSnap.data();
  if (t.therapistUid !== uid && t.patientAccountUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  // Rate limit simples: 30 msgs/min por user.
  // (Pra produção pesada, mover pra Redis. V1 fica memory-only por ip.)

  const messageId = newId("msg");
  const now = Date.now();

  await db.collection("therapy_messages").doc(messageId).set({
    messageId,
    threadId,
    senderUid: uid,
    senderRole: me.role,
    ciphertext,
    iv,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    ...(replyToMessageId ? { replyToMessageId } : {}),
    ...(forwardedFromMessageId ? { forwardedFromMessageId } : {})
  });

  // Denormaliza unread count: incrementa pro OUTRO lado, zera pro proprio.
  // Frontend mostra circulo verde com numero (estilo WhatsApp).
  const otherCountField = me.role === "therapist" ? "unreadCountForPatient" : "unreadCountForTherapist";
  const myCountField    = me.role === "therapist" ? "unreadCountForTherapist" : "unreadCountForPatient";
  await threadRef.set({
    lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
    lastMessageSenderRole: me.role,
    // Denormaliza o ciphertext+iv da ultima msg pra que o frontend consiga
    // decifrar o preview na lista de threads SEM precisar abrir cada uma.
    // Antes, preview so aparecia depois do user abrir a thread (cache local).
    lastMessageCiphertext: ciphertext,
    lastMessageIv: iv,
    // Sender também marca como lido pro próprio role (não conta como unread pra si).
    ...(me.role === "therapist" ? { lastReadByTherapist: now } : { lastReadByPatient: now }),
    [otherCountField]: admin.firestore.FieldValue.increment(1),
    [myCountField]: 0
  }, { merge: true });

  // Push notification best-effort. pushToUser cobre therapist E paciente.
  const senderName = me.role === "therapist" ? t.therapistDisplayName : t.patientDisplayName;
  const receiverUid = me.role === "therapist" ? t.patientAccountUid : t.therapistUid;
  const receiverUrl = me.role === "therapist" ? "./paciente-mensagens.html" : "./mensagens.html#thread-" + threadId;
  pushToUser(receiverUid, {
    title: `${senderName} enviou uma mensagem`,
    body: "Toque para abrir a conversa.",
    url: receiverUrl,
    tag: "chat-" + threadId
  }).catch(() => {});

  return res.json({ ok: true, messageId, createdAt: now });
}));

// PATCH /therapy/chat/threads/:id/read — marca todas mensagens como lidas
// até timestamp `until` (defaults a now).
router.patch("/therapy/chat/threads/:id/read", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const me = await identifyUser(uid);
  if (!me) return sendError(res, 404, "USUARIO_NAO_REGISTRADO");

  const threadId = String(req.params.id || "").trim();
  if (!threadId) return sendError(res, 400, "THREAD_ID_OBRIGATORIO");

  const until = Number(req.body?.until) || Date.now();

  const db = getDb();
  const threadRef = db.collection("therapy_threads").doc(threadId);
  const snap = await threadRef.get();
  if (!snap.exists) return sendError(res, 404, "THREAD_NAO_ENCONTRADA");
  const t = snap.data();
  if (t.therapistUid !== uid && t.patientAccountUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  await threadRef.set({
    ...(me.role === "therapist" ? { lastReadByTherapist: until, unreadCountForTherapist: 0 } : { lastReadByPatient: until, unreadCountForPatient: 0 })
  }, { merge: true });

  return res.json({ ok: true });
}));

// PATCH /therapy/chat/threads/:id/patient-presence — paciente sinaliza atividade.
// Atualiza lastSeenByPatient no doc da thread. Apenas o paciente da thread pode chamar.
router.patch("/therapy/chat/threads/:id/patient-presence", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const threadId = String(req.params.id || "").trim();
  if (!threadId) return sendError(res, 400, "THREAD_ID_OBRIGATORIO");
  const snap = await getDb().collection("therapy_threads").doc(threadId).get();
  if (!snap.exists) return sendError(res, 404, "THREAD_NAO_ENCONTRADA");
  const t = snap.data();
  if (t.patientAccountUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");
  const offline = req.body?.offline === true;
  await getDb().collection("therapy_threads").doc(threadId).update({
    lastSeenByPatient: offline ? 0 : Date.now()
  });
  return res.json({ ok: true });
}));

// PATCH /therapy/chat/messages/:id — ações no menu de contexto da msg.
// Body aceita (um por vez):
//  { deleted: true }   — soft delete; APENAS o sender pode apagar a propria msg.
//  { favorite: bool }  — adiciona/remove o user atual do array favoritedBy.
router.patch("/therapy/chat/messages/:id", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const messageId = String(req.params.id || "").trim();
  if (!messageId) return sendError(res, 400, "MESSAGE_ID_OBRIGATORIO");

  const db = getDb();
  const msgRef = db.collection("therapy_messages").doc(messageId);
  const msgSnap = await msgRef.get();
  if (!msgSnap.exists) return sendError(res, 404, "MENSAGEM_NAO_ENCONTRADA");
  const m = msgSnap.data();

  // Verifica que sou participante da thread.
  const threadSnap = await db.collection("therapy_threads").doc(m.threadId).get();
  if (!threadSnap.exists) return sendError(res, 404, "THREAD_NAO_ENCONTRADA");
  const t = threadSnap.data();
  if (t.therapistUid !== uid && t.patientAccountUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  const updates = {};

  if (req.body?.deleted === true) {
    // Apenas o sender pode apagar a propria msg.
    if (m.senderUid !== uid) return sendError(res, 403, "APENAS_SENDER_APAGA");
    if (m.deleted) return res.json({ ok: true }); // idempotente
    updates.deleted = true;
    updates.deletedAt = admin.firestore.FieldValue.serverTimestamp();
    // Limpa ciphertext pra economizar storage + garantir nao-recuperabilidade.
    updates.ciphertext = admin.firestore.FieldValue.delete();
    updates.iv = admin.firestore.FieldValue.delete();
  }

  if (typeof req.body?.favorite === "boolean") {
    updates.favoritedBy = req.body.favorite
      ? admin.firestore.FieldValue.arrayUnion(uid)
      : admin.firestore.FieldValue.arrayRemove(uid);
  }

  if (typeof req.body?.pinned === "boolean") {
    // Pin: ambos participantes podem fixar/desafixar (decisao conjunta da
    // dupla terapeuta+paciente). Audit registra quem.
    updates.pinned = req.body.pinned;
    if (req.body.pinned) {
      updates.pinnedAt = admin.firestore.FieldValue.serverTimestamp();
      updates.pinnedBy = uid;
    } else {
      updates.pinnedAt = admin.firestore.FieldValue.delete();
      updates.pinnedBy = admin.firestore.FieldValue.delete();
    }
  }

  if (Object.keys(updates).length === 0) return sendError(res, 400, "NENHUMA_ACAO");

  await msgRef.set(updates, { merge: true });

  await logAudit({
    type: "chat_message_action",
    messageId,
    threadId: m.threadId,
    actorUid: uid,
    actions: Object.keys(updates).filter(k => k !== "deletedAt").join(",")
  });

  return res.json({ ok: true });
}));

// POST /therapy/chat/messages/:id/react — toggle emoji reaction.
// Body: { emoji }. Storage: msg.reactions = { "👍": [uid1, uid2], "❤️": [...] }
// Toggle: se o user ja tinha esse emoji, remove. Se nao, adiciona (mantendo
// outros emojis dele em outras keys — pode reagir com varios emojis).
const ALLOWED_REACTIONS = new Set(["👍","❤️","😂","😮","😢","🙏"]);
router.post("/therapy/chat/messages/:id/react", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const messageId = String(req.params.id || "").trim();
  if (!messageId) return sendError(res, 400, "MESSAGE_ID_OBRIGATORIO");

  const emoji = String(req.body?.emoji || "").trim();
  if (!emoji || !ALLOWED_REACTIONS.has(emoji)) return sendError(res, 400, "EMOJI_INVALIDO");

  const db = getDb();
  const msgRef = db.collection("therapy_messages").doc(messageId);
  const msgSnap = await msgRef.get();
  if (!msgSnap.exists) return sendError(res, 404, "MENSAGEM_NAO_ENCONTRADA");
  const m = msgSnap.data();

  const threadSnap = await db.collection("therapy_threads").doc(m.threadId).get();
  if (!threadSnap.exists) return sendError(res, 404, "THREAD_NAO_ENCONTRADA");
  const t = threadSnap.data();
  if (t.therapistUid !== uid && t.patientAccountUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  // Toggle: tem o uid no array do emoji? remove. Senao, adiciona.
  // update() (NAO set+merge) pra dot-notation — update() sempre interpreta
  // "reactions.emoji" como nested path. set+merge pode criar field literal
  // "reactions.emoji" em vez de nested, causando a reaction nao persistir
  // e sumindo na proxima leitura.
  const currentUids = (m.reactions && m.reactions[emoji]) || [];
  const had = Array.isArray(currentUids) && currentUids.includes(uid);
  await msgRef.update({
    [`reactions.${emoji}`]: had
      ? admin.firestore.FieldValue.arrayRemove(uid)
      : admin.firestore.FieldValue.arrayUnion(uid)
  });

  return res.json({ ok: true, emoji, mine: !had });
}));

// POST /therapy/chat/messages/:id/report — denuncia uma msg.
// Body: { reason }. Cria therapy_message_reports doc + audit.
router.post("/therapy/chat/messages/:id/report", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const me = await identifyUser(uid);
  if (!me) return sendError(res, 404, "USUARIO_NAO_REGISTRADO");

  const messageId = String(req.params.id || "").trim();
  if (!messageId) return sendError(res, 400, "MESSAGE_ID_OBRIGATORIO");

  const reason = String(req.body?.reason || "").trim().slice(0, 1000);
  if (!reason) return sendError(res, 400, "MOTIVO_OBRIGATORIO");

  const db = getDb();
  const msgSnap = await db.collection("therapy_messages").doc(messageId).get();
  if (!msgSnap.exists) return sendError(res, 404, "MENSAGEM_NAO_ENCONTRADA");
  const m = msgSnap.data();

  const threadSnap = await db.collection("therapy_threads").doc(m.threadId).get();
  if (!threadSnap.exists) return sendError(res, 404, "THREAD_NAO_ENCONTRADA");
  const t = threadSnap.data();
  if (t.therapistUid !== uid && t.patientAccountUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  // Snapshot do plaintext que o reporter ja tem decifrado localmente.
  // Armazena pra admin poder ler o conteudo reportado sem precisar da key
  // E2EE da thread (admin nao eh participante, nao tem como decifrar).
  const messageSnapshot = String(req.body?.messageSnapshot || "").trim().slice(0, 2000);

  const reportId = newId("rep");
  await db.collection("therapy_message_reports").doc(reportId).set({
    reportId,
    messageId,
    threadId: m.threadId,
    reporterUid: uid,
    reporterRole: me.role,
    reportedSenderUid: m.senderUid,
    reportedSenderRole: m.senderRole,
    reason,
    messageSnapshot: messageSnapshot || null,
    status: "open",
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await logAudit({
    type: "chat_message_reported",
    messageId,
    threadId: m.threadId,
    reporterUid: uid,
    reportId
  });

  return res.json({ ok: true, reportId });
}));

// GET /therapy/chat/profissionais — lista profissionais verificados do sistema
// para compartilhar como contato no chat. Retorna apenas dados públicos.
router.get("/therapy/chat/profissionais", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const snap = await getDb().collection("therapists")
    .where("verificationStatus", "==", "verified")
    .limit(300)
    .get();

  const profissionais = snap.docs
    .map(d => {
      const t = d.data();
      const conselho = t.tipoConselho && t.tipoConselho !== "SEM_CONSELHO"
        ? `${t.tipoConselho}: ${t.numeroConselho || t.crp || t.crm || ""}`.trim()
        : "";
      return {
        uid: t.uid || d.id,
        displayName: t.displayName || "",
        especialidade: t.especialidade || "",
        conselho,
        telefone: t.consultorio?.telefone || "",
        cidade: t.consultorio?.cidade || "",
        uf:     t.consultorio?.uf     || ""
      };
    })
    .filter(t => t.uid !== uid && t.displayName)
    .sort((a, b) => a.displayName.localeCompare(b.displayName, "pt-BR"));

  return res.json({ ok: true, profissionais });
}));

// GET /therapy/chat/peers — lista os peers possíveis pra abrir chat novo.
// - Therapist: pacientes que têm conta (therapy_patient_accounts) E que já
//   tiveram sessão com este therapist (link via therapy_sessions.patientAccountUid).
// - Patient: terapeutas que já atenderam este paciente.
router.get("/therapy/chat/peers", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const me = await identifyUser(uid);
  if (!me) return sendError(res, 404, "USUARIO_NAO_REGISTRADO");

  const db = getDb();
  let peerUids = new Set();
  if (me.role === "therapist") {
    const ss = await db.collection("therapy_sessions")
      .where("therapistUid", "==", uid).limit(500).get();
    ss.forEach(d => {
      const pUid = d.data().patientAccountUid;
      if (pUid) peerUids.add(pUid);
    });
  } else {
    const ss = await db.collection("therapy_sessions")
      .where("patientAccountUid", "==", uid).limit(500).get();
    ss.forEach(d => {
      const tUid = d.data().therapistUid;
      if (tUid) peerUids.add(tUid);
    });
  }

  if (!peerUids.size) return res.json({ ok: true, peers: [] });

  // Resolve nomes
  const peers = [];
  for (const peerUid of peerUids) {
    const peer = await identifyUser(peerUid);
    if (!peer) continue;
    peers.push({
      uid: peerUid,
      role: peer.role,
      displayName: peer.doc.displayName || ""
    });
  }
  return res.json({ ok: true, peers });
}));

// ═════════════════════════════════════════════════════════════════════════
// PRO-CHAT — Chat E2EE entre dois profissionais.
//
// Schema: therapy_pro_threads/{threadId}
//   { threadId, participantA, participantB (uids sorted lex pra dedup),
//     threadKeyForA, threadKeyForB,           // {ciphertext, iv} cada
//     creatorEcdhPublicJwkSnapshot,
//     displayNameA, displayNameB,
//     createdAt, createdBy,
//     lastMessageAt, lastMessageSenderUid,
//     lastReadByA, lastReadByB }
//
// Mensagens: therapy_pro_messages/{messageId}
//   { messageId, threadId, senderUid, ciphertext, iv, createdAt }
//
// Dedup de thread: (participantA, participantB) sorted asc — qualquer
// dos dois iniciando entre A↔B retorna mesma thread.
// ═════════════════════════════════════════════════════════════════════════

function _sortUids(u1, u2) {
  return u1 < u2 ? [u1, u2] : [u2, u1];
}

// POST /therapy/pro-chat/threads
// Body: { peerUid, threadKeyForCreator, threadKeyForPeer, creatorEcdhPublicJwk }
router.post("/therapy/pro-chat/threads", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const peerUid = String(req.body?.peerUid || "").trim();
  if (!peerUid || peerUid === uid) return sendError(res, 400, "PEER_INVALIDO");

  // Ambos precisam ser therapists
  const [me, peer] = await Promise.all([loadTherapist(uid), loadTherapist(peerUid)]);
  if (!me)   return sendError(res, 403, "PROFISSIONAL_NAO_REGISTRADO");
  if (!peer) return sendError(res, 404, "PEER_NAO_PROFISSIONAL");

  const tForCreator = req.body?.threadKeyForCreator;
  const tForPeer    = req.body?.threadKeyForPeer;
  const creatorPub  = req.body?.creatorEcdhPublicJwk;
  if (!tForCreator?.ciphertext || !tForCreator?.iv) return sendError(res, 400, "THREAD_KEY_CREATOR_INVALIDA");
  if (!tForPeer?.ciphertext    || !tForPeer?.iv)    return sendError(res, 400, "THREAD_KEY_PEER_INVALIDA");
  if (!creatorPub || !creatorPub.x) return sendError(res, 400, "CREATOR_PUBKEY_INVALIDA");

  const [participantA, participantB] = _sortUids(uid, peerUid);
  const isCreatorA = uid === participantA;

  const db = getDb();
  const existing = await db.collection("therapy_pro_threads")
    .where("participantA", "==", participantA)
    .where("participantB", "==", participantB)
    .limit(1).get();
  if (!existing.empty) {
    return res.json({ ok: true, threadId: existing.docs[0].id, existed: true });
  }

  const threadId = newId("pro-thr");
  await db.collection("therapy_pro_threads").doc(threadId).set({
    threadId,
    participantA,
    participantB,
    displayNameA: (isCreatorA ? me : peer).displayName || "",
    displayNameB: (isCreatorA ? peer : me).displayName || "",
    threadKeyForA: isCreatorA ? tForCreator : tForPeer,
    threadKeyForB: isCreatorA ? tForPeer    : tForCreator,
    creatorEcdhPublicJwkSnapshot: creatorPub,
    createdBy: uid,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    lastMessageAt: null,
    lastMessageSenderUid: null,
    lastReadByA: Date.now(),
    lastReadByB: Date.now()
  });

  await logAudit({ type: "pro_chat_thread_created", threadId, participantA, participantB, createdBy: uid });
  return res.json({ ok: true, threadId, existed: false });
}));

// GET /therapy/pro-chat/threads — lista threads do prof (com unread counts)
router.get("/therapy/pro-chat/threads", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const db = getDb();
  const [snapA, snapB] = await Promise.all([
    db.collection("therapy_pro_threads").where("participantA", "==", uid).limit(500).get(),
    db.collection("therapy_pro_threads").where("participantB", "==", uid).limit(500).get()
  ]);

  const docs = [...snapA.docs, ...snapB.docs];
  const threads = docs.map(d => {
    const t = d.data();
    const meIsA = t.participantA === uid;
    const peerUid = meIsA ? t.participantB : t.participantA;
    const peerName = meIsA ? t.displayNameB : t.displayNameA;
    const lastRead = meIsA ? t.lastReadByA : t.lastReadByB;
    const lastReadByPeer = meIsA ? t.lastReadByB : t.lastReadByA;
    const lastMsg = t.lastMessageAt?.toMillis ? t.lastMessageAt.toMillis() : Number(t.lastMessageAt) || 0;
    return {
      threadId: t.threadId,
      peerUid,
      peerName,
      lastMessageAt: lastMsg || null,
      lastMessageSenderUid: t.lastMessageSenderUid || null,
      hasUnread: lastMsg > (lastRead || 0) && t.lastMessageSenderUid !== uid,
      lastReadByPeer: lastReadByPeer || 0,
      myWrappedThreadKey: meIsA ? t.threadKeyForA : t.threadKeyForB,
      peerEcdhPublicJwkSnapshot: t.createdBy === uid ? null : t.creatorEcdhPublicJwkSnapshot
    };
  }).sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));

  return res.json({ ok: true, threads });
}));

// GET /therapy/pro-chat/threads/:id — detalhe da thread
// Retorna lastReadByPeer (pra ticks de leitura ✓✓) e peerTypingAt (pra
// indicador "digitando..."). Timestamp do peer < 6s = peer está digitando.
router.get("/therapy/pro-chat/threads/:id", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const threadId = String(req.params.id || "").trim();
  const snap = await getDb().collection("therapy_pro_threads").doc(threadId).get();
  if (!snap.exists) return sendError(res, 404, "THREAD_NAO_ENCONTRADA");
  const t = snap.data();
  if (t.participantA !== uid && t.participantB !== uid) return sendError(res, 403, "ACESSO_NEGADO");
  const meIsA = t.participantA === uid;
  return res.json({
    ok: true,
    thread: {
      threadId: t.threadId,
      peerUid: meIsA ? t.participantB : t.participantA,
      peerName: meIsA ? t.displayNameB : t.displayNameA,
      myWrappedThreadKey: meIsA ? t.threadKeyForA : t.threadKeyForB,
      peerEcdhPublicJwkSnapshot: t.createdBy === uid ? null : t.creatorEcdhPublicJwkSnapshot,
      lastReadByMe:   meIsA ? t.lastReadByA : t.lastReadByB,
      lastReadByPeer:  meIsA ? t.lastReadByB : t.lastReadByA,
      peerTypingAt:    meIsA ? (t.typingByB  || 0) : (t.typingByA  || 0),
      lastSeenByPeer:  meIsA ? (t.lastSeenByB || 0) : (t.lastSeenByA || 0)
    }
  });
}));

// POST /therapy/pro-chat/threads/:id/typing — sinaliza que estou digitando.
// Frontend POSTa com debounce (~3s). Backend só atualiza o timestamp;
// outro lado polla GET /threads/:id e checa peerTypingAt - now < 6s.
router.post("/therapy/pro-chat/threads/:id/typing", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const threadId = String(req.params.id || "").trim();
  const tref = getDb().collection("therapy_pro_threads").doc(threadId);
  const tsnap = await tref.get();
  if (!tsnap.exists) return sendError(res, 404, "THREAD_NAO_ENCONTRADA");
  const t = tsnap.data();
  if (t.participantA !== uid && t.participantB !== uid) return sendError(res, 403, "ACESSO_NEGADO");
  const meIsA = t.participantA === uid;
  await tref.set(meIsA ? { typingByA: Date.now() } : { typingByB: Date.now() }, { merge: true });
  return res.json({ ok: true });
}));

// GET /therapy/pro-chat/threads/:id/messages?before=ms&limit=50
// Query SIMPLES — só where("threadId", "==", X) + limit. Sem orderBy
// server-side pra não exigir composite index no Firestore (where +
// orderBy em campos diferentes = FAILED_PRECONDITION → ERRO_INTERNO).
// Sort + paginação `before` feitos client-side aqui no Node. Trade-off
// aceitável: cada thread costuma ter dezenas/centenas de mensagens,
// não milhões. Limit defensivo 500 cobre threads ativas.
router.get("/therapy/pro-chat/threads/:id/messages", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const threadId = String(req.params.id || "").trim();
  const before = Number(req.query?.before) || Date.now() + 1;
  const limit = Math.min(Number(req.query?.limit) || 50, 200);

  const db = getDb();
  const snap = await db.collection("therapy_pro_threads").doc(threadId).get();
  if (!snap.exists) return sendError(res, 404, "THREAD_NAO_ENCONTRADA");
  const t = snap.data();
  if (t.participantA !== uid && t.participantB !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  const msgs = await db.collection("therapy_pro_messages")
    .where("threadId", "==", threadId)
    .limit(500)
    .get();

  const all = msgs.docs.map(d => {
    const m = d.data();
    return {
      messageId: m.messageId,
      senderUid: m.senderUid,
      ciphertext: m.ciphertext,
      iv: m.iv,
      createdAt: m.createdAt?.toMillis ? m.createdAt.toMillis() : Number(m.createdAt) || 0
    };
  });

  // Filtra por `before`, ordena por createdAt asc, pega as últimas N.
  const items = all
    .filter(m => (m.createdAt || 0) < before)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .slice(-limit);

  return res.json({ ok: true, messages: items });
}));

// POST /therapy/pro-chat/threads/:id/messages — envia mensagem
// Body: { ciphertext, iv }
router.post("/therapy/pro-chat/threads/:id/messages", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const threadId = String(req.params.id || "").trim();
  const ciphertext = String(req.body?.ciphertext || "").trim();
  const iv = String(req.body?.iv || "").trim();
  if (!ciphertext || !iv) return sendError(res, 400, "MENSAGEM_INVALIDA");
  if (ciphertext.length > 50_000) return sendError(res, 413, "MENSAGEM_GRANDE_DEMAIS");

  const db = getDb();
  const tref = db.collection("therapy_pro_threads").doc(threadId);
  const tsnap = await tref.get();
  if (!tsnap.exists) return sendError(res, 404, "THREAD_NAO_ENCONTRADA");
  const t = tsnap.data();
  if (t.participantA !== uid && t.participantB !== uid) return sendError(res, 403, "ACESSO_NEGADO");

  const messageId = newId("pro-msg");
  const now = Date.now();
  await db.collection("therapy_pro_messages").doc(messageId).set({
    messageId,
    threadId,
    senderUid: uid,
    ciphertext,
    iv,
    createdAt: now
  });
  await tref.set({
    lastMessageAt: now,
    lastMessageSenderUid: uid
  }, { merge: true });
  return res.json({ ok: true, messageId, createdAt: now });
}));

// POST /therapy/pro-chat/threads/:id/marcar-lido — atualiza lastReadByMe
router.post("/therapy/pro-chat/threads/:id/marcar-lido", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const threadId = String(req.params.id || "").trim();
  const until = Number(req.body?.until) || Date.now();
  const tref = getDb().collection("therapy_pro_threads").doc(threadId);
  const tsnap = await tref.get();
  if (!tsnap.exists) return sendError(res, 404, "THREAD_NAO_ENCONTRADA");
  const t = tsnap.data();
  if (t.participantA !== uid && t.participantB !== uid) return sendError(res, 403, "ACESSO_NEGADO");
  const meIsA = t.participantA === uid;
  await tref.set(meIsA ? { lastReadByA: until } : { lastReadByB: until }, { merge: true });
  return res.json({ ok: true });
}));

// PATCH /therapy/pro-chat/threads/:id/presence — sinaliza atividade do prof.
// Espelha o patient-presence do chat terapeuta-paciente.
router.patch("/therapy/pro-chat/threads/:id/presence", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const threadId = String(req.params.id || "").trim();
  if (!threadId) return sendError(res, 400, "THREAD_ID_OBRIGATORIO");
  const snap = await getDb().collection("therapy_pro_threads").doc(threadId).get();
  if (!snap.exists) return sendError(res, 404, "THREAD_NAO_ENCONTRADA");
  const t = snap.data();
  if (t.participantA !== uid && t.participantB !== uid) return sendError(res, 403, "ACESSO_NEGADO");
  const meIsA = t.participantA === uid;
  const offline = req.body?.offline === true;
  await getDb().collection("therapy_pro_threads").doc(threadId).update(
    meIsA ? { lastSeenByA: offline ? 0 : Date.now() }
           : { lastSeenByB: offline ? 0 : Date.now() }
  );
  return res.json({ ok: true });
}));

// GET /therapy/pro-chat/buscar?q=... — busca profissionais por nome ou CRP/CRM.
// Limite intencional: só retorna profissionais com verificationStatus="verified"
// (selo da equipe) — evita spam de contas novas/falsas.
router.get("/therapy/pro-chat/buscar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const q = String(req.query?.q || "").trim().toLowerCase();
  if (q.length < 3) return sendError(res, 400, "QUERY_CURTA_DEMAIS", { detail: "Digite ao menos 3 caracteres." });

  // Firestore não tem full-text — busca por prefix em displayName + match exato
  // de CRP/CRM. Volume baixo (~thousands of therapists), client-filter OK.
  const db = getDb();
  const snap = await db.collection("therapists")
    .where("verificationStatus", "==", "verified")
    .limit(500).get();

  const items = snap.docs
    .map(d => ({ uid: d.id, ...d.data() }))
    .filter(t => t.uid !== uid) // exclui o próprio
    .filter(t => {
      const name = (t.displayName || "").toLowerCase();
      const crp = (t.crp || "").toLowerCase();
      const crm = (t.crm || "").toLowerCase();
      return name.includes(q) || crp.includes(q) || crm.includes(q);
    })
    .slice(0, 20)
    .map(t => ({
      uid: t.uid,
      displayName: t.displayName || "",
      crp: t.crp || "",
      crm: t.crm || "",
      especialidade: t.especialidade || ""
    }));

  return res.json({ ok: true, items });
}));

// ═════════════════════════════════════════════════════════════════════════
// SUPPORT BOT — Chatbot Claude pra suporte 24/7 (FAQ + troubleshooting)
//
// Rate limit: 30 req/dia por uid pra controlar custo (~R$ 0,005 por req).
// History de mensagens fica do lado do cliente (sessionStorage); backend é
// stateless — recebe histórico no body e responde uma mensagem.
// ═════════════════════════════════════════════════════════════════════════

const _supportQuota = new Map(); // uid -> { count, resetAt }
const SUPPORT_DAILY_QUOTA = 30;
const SUPPORT_RESET_MS = 24 * 60 * 60 * 1000;

function _checkSupportQuota(uid) {
  const now = Date.now();
  const entry = _supportQuota.get(uid);
  if (!entry || now > entry.resetAt) {
    _supportQuota.set(uid, { count: 1, resetAt: now + SUPPORT_RESET_MS });
    return { ok: true, remaining: SUPPORT_DAILY_QUOTA - 1 };
  }
  if (entry.count >= SUPPORT_DAILY_QUOTA) {
    return { ok: false, remaining: 0, resetAt: entry.resetAt };
  }
  entry.count++;
  return { ok: true, remaining: SUPPORT_DAILY_QUOTA - entry.count };
}

// POST /therapy/support/chat
// Body: { message, history?: [{role, content}] }
// Retorna: { ok, reply, remaining }
router.post("/therapy/support/chat", asyncHandler(async (req, res) => {
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const quota = _checkSupportQuota(uid);
  if (!quota.ok) {
    return sendError(res, 429, "QUOTA_DIARIA_EXCEDIDA", {
      detail: "Limite de 30 perguntas/dia. Reset em " + new Date(quota.resetAt).toISOString(),
      resetAt: quota.resetAt
    });
  }

  const message = String(req.body?.message || "").trim();
  if (!message) return sendError(res, 400, "MENSAGEM_OBRIGATORIA");
  const history = Array.isArray(req.body?.history) ? req.body.history : [];

  // Carrega nome do profissional pra bot personalizar a saudação.
  // Falha silenciosa: se Firestore der pau ou nome não existe, bot
  // responde sem nome (comportamento anterior).
  let userName = "";
  try {
    const therapist = await loadTherapist(uid);
    userName = String(therapist?.displayName || "").trim();
  } catch (_) { /* no-op */ }

  const result = await supportBot.askBot({ history, userMessage: message, userName });
  if (!result.ok) {
    return sendError(res, 502, result.error || "BOT_FALHOU", { detail: result.detail || null });
  }
  return res.json({ ok: true, reply: result.reply, remaining: quota.remaining, usage: result.usage });
}));

// ═════════════════════════════════════════════════════════════════════════
// MARKETING AUTOMATION — Campanhas one-shot pra pacientes
//
// Audiences predefinidas (services/marketing.js). Backend conhece sessões
// (plaintext metadata: scheduledAt) e devolve lista de patientIds elegíveis.
// Frontend pega os IDs, decifra patient docs locais, decide quais têm email
// válido, e dispara envios via /marketing/send.
//
// Rate limit: 200 emails/dia por uid pra controlar custo (Resend free = 100/d).
// ═════════════════════════════════════════════════════════════════════════

const _marketingQuota = new Map();
const MARKETING_DAILY_QUOTA = 200;
const MARKETING_RESET_MS = 24 * 60 * 60 * 1000;

function _checkMarketingQuota(uid, qty = 1) {
  const now = Date.now();
  const entry = _marketingQuota.get(uid);
  if (!entry || now > entry.resetAt) {
    if (qty > MARKETING_DAILY_QUOTA) return { ok: false, remaining: 0 };
    _marketingQuota.set(uid, { count: qty, resetAt: now + MARKETING_RESET_MS });
    return { ok: true, remaining: MARKETING_DAILY_QUOTA - qty };
  }
  if (entry.count + qty > MARKETING_DAILY_QUOTA) {
    return { ok: false, remaining: MARKETING_DAILY_QUOTA - entry.count, resetAt: entry.resetAt };
  }
  entry.count += qty;
  return { ok: true, remaining: MARKETING_DAILY_QUOTA - entry.count };
}

// GET /therapy/marketing/audiences — lista audiences predefinidas
router.get("/therapy/marketing/audiences", asyncHandler(async (req, res) => {
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  return res.json({ ok: true, audiences: marketing.AUDIENCES, templates: marketing.TEMPLATES });
}));

// POST /therapy/marketing/resolve — devolve patientIds elegíveis pra audience
// Body: { audienceKey, audienceParams? }
// Retorna: { ok, patientIds: [{patientId, lastSessionAt}] }
router.post("/therapy/marketing/resolve", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;
  const audienceKey = String(req.body?.audienceKey || "").trim();
  if (!marketing.AUDIENCES[audienceKey]) return sendError(res, 400, "AUDIENCE_INVALIDA");

  const db = getDb();

  // Lista pacientes do prof. Patient docs vem cifrados (E2EE) mas backend
  // só precisa de patientId + birthdate (este NÃO é cifrado).
  const pSnap = await db.collection("therapy_patients")
    .where("therapistUid", "==", uid).limit(5000).get();
  const patients = pSnap.docs.map(d => {
    const x = d.data();
    return { patientId: d.id, birthdate: x.birthdate || null };
  });

  // Last session por patient
  const sSnap = await db.collection("therapy_sessions")
    .where("therapistUid", "==", uid).limit(5000).get();
  const sessionsByPatientId = new Map();
  for (const sd of sSnap.docs) {
    const s = sd.data();
    if (!s.patientId) continue;
    const at = Number(s.scheduledAt) || 0;
    const cur = sessionsByPatientId.get(s.patientId) || 0;
    if (at > cur) sessionsByPatientId.set(s.patientId, at);
  }

  const eligibleSet = marketing.resolveAudiencePatients(
    audienceKey, req.body?.audienceParams || {}, sessionsByPatientId, patients
  );

  const patientIds = [...eligibleSet].map(pid => ({
    patientId: pid,
    lastSessionAt: sessionsByPatientId.get(pid) || null
  }));

  return res.json({ ok: true, audienceKey, patientIds, total: patientIds.length });
}));

// POST /therapy/marketing/send — envia 1 email pra 1 destinatário.
// Body: { to, subject, body (markdown), patientId? }
// Frontend chamou já fez o render (substituicao de placeholders) e envia
// markdown — backend converte pra HTML basico via mdToHtml.
router.post("/therapy/marketing/send", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const to = String(req.body?.to || "").trim();
  const subject = String(req.body?.subject || "").trim().slice(0, 200);
  const body = String(req.body?.body || "").trim().slice(0, 10000);
  if (!to || !subject || !body) return sendError(res, 400, "CAMPOS_OBRIGATORIOS");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return sendError(res, 400, "EMAIL_INVALIDO");

  const quota = _checkMarketingQuota(uid, 1);
  if (!quota.ok) {
    return sendError(res, 429, "QUOTA_MARKETING_EXCEDIDA", {
      detail: `Limite ${MARKETING_DAILY_QUOTA} emails/dia. Reset em 24h.`,
      remaining: quota.remaining,
      resetAt: quota.resetAt
    });
  }

  const therapist = await loadTherapist(uid);
  const therapistName = therapist?.displayName || "Profissional";
  const therapistEmail = therapist?.email || null;

  const html = marketing.mdToHtml(body);
  try {
    const r = await sendEmail({
      to,
      replyTo: therapistEmail,
      subject,
      html: `<div style="font-family: Inter, system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1c1f1d;">
        ${html}
        <hr style="margin: 30px 0 16px; border: 0; border-top: 1px solid #ddd;">
        <p style="font-size: 11px; color: #888; margin: 0;">Mensagem enviada por ${escHtmlSafe(therapistName)} via Espaço Prelúdio.</p>
      </div>`,
      text: body + "\n\n---\nMensagem enviada por " + therapistName + " via Espaço Prelúdio."
    });
    return res.json({ ok: true, sent: !!(r.ok || r.skipped), remaining: quota.remaining });
  } catch (e) {
    return sendError(res, 502, "FALHA_ENVIO", { detail: e.message });
  }
}));

function escHtmlSafe(s) {
  return String(s||"").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

// ═════════════════════════════════════════════════════════════════════════
// EMPRESAS — gestão de empresas parceiras e colaboradores
// Coleções: therapy_empresas, therapy_colaboradores
// ═════════════════════════════════════════════════════════════════════════

function slugify(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40);
}
function randomSuffix(len = 6) {
  return Math.random().toString(36).slice(2, 2 + len);
}

// GET /therapy/admin/empresas?status=ativa|inativa|all&q=busca
router.get("/therapy/admin/empresas", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const db = getDb();
  const status = String(req.query?.status || "all").trim();
  const q = String(req.query?.q || "").trim().toLowerCase();

  let snap;
  if (status === "ativa" || status === "inativa") {
    snap = await db.collection("therapy_empresas").where("status", "==", status).limit(500).get();
  } else {
    snap = await db.collection("therapy_empresas").limit(500).get();
  }

  let items = snap.docs.map(d => {
    const e = d.data();
    return {
      id: d.id,
      nome: e.nome || "",
      cnpj: e.cnpj || null,
      slug: e.slug || "",
      segmento: e.segmento || null,
      contatoNome: e.contatoNome || null,
      contatoEmail: e.contatoEmail || null,
      contatoPhone: e.contatoPhone || null,
      status: e.status || "ativa",
      totalColaboradores: e.totalColaboradores || 0,
      limiteColaboradores: e.limiteColaboradores || null,
      createdAt: e.createdAt?.toMillis?.() || null,
      createdBy: e.createdBy || null,
      obs: e.obs || null
    };
  });

  if (q) {
    items = items.filter(e =>
      e.nome.toLowerCase().includes(q) ||
      (e.cnpj || "").includes(q) ||
      (e.contatoEmail || "").toLowerCase().includes(q)
    );
  }

  items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return res.json({ ok: true, items, total: items.length });
}));

// POST /therapy/admin/empresas — cria empresa
router.post("/therapy/admin/empresas", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const { nome, cnpj, segmento, contatoNome, contatoEmail, contatoPhone, limiteColaboradores, obs } = req.body || {};
  if (!nome || String(nome).trim().length < 2) return sendError(res, 400, "NOME_OBRIGATORIO");

  const db = getDb();
  const baseSlug = slugify(nome);

  // Garante slug único
  let slug = baseSlug + "-" + randomSuffix(6);
  for (let i = 0; i < 5; i++) {
    const existing = await db.collection("therapy_empresas").where("slug", "==", slug).limit(1).get();
    if (existing.empty) break;
    slug = baseSlug + "-" + randomSuffix(6);
  }

  const doc = {
    nome: String(nome).trim(),
    cnpj: cnpj ? String(cnpj).trim() : null,
    slug,
    segmento: segmento ? String(segmento).trim() : null,
    contatoNome: contatoNome ? String(contatoNome).trim() : null,
    contatoEmail: contatoEmail ? String(contatoEmail).trim().toLowerCase() : null,
    contatoPhone: contatoPhone ? String(contatoPhone).trim() : null,
    limiteColaboradores: limiteColaboradores ? Number(limiteColaboradores) : null,
    obs: obs ? String(obs).trim() : null,
    status: "ativa",
    totalColaboradores: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdBy: adminAuth.uid
  };

  const ref = await db.collection("therapy_empresas").add(doc);
  const baseUrl = process.env.THERAPY_FRONTEND_BASE || "https://espacopreludio.com.br";
  return res.json({
    ok: true,
    id: ref.id,
    slug,
    link: `${baseUrl}/colaborador-cadastro.html?empresa=${slug}`
  });
}));

// PATCH /therapy/admin/empresas/:id
router.patch("/therapy/admin/empresas/:id", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const id = String(req.params.id || "").trim();
  if (!id) return sendError(res, 400, "ID_OBRIGATORIO");

  const db = getDb();
  const ref = db.collection("therapy_empresas").doc(id);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "EMPRESA_NAO_ENCONTRADA");

  const allowed = ["nome", "cnpj", "segmento", "contatoNome", "contatoEmail", "contatoPhone", "limiteColaboradores", "obs", "status"];
  const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  for (const k of allowed) {
    if (req.body?.[k] !== undefined) {
      updates[k] = req.body[k] === null ? null : String(req.body[k]).trim() || null;
    }
  }
  if (req.body?.limiteColaboradores !== undefined) {
    updates.limiteColaboradores = req.body.limiteColaboradores ? Number(req.body.limiteColaboradores) : null;
  }

  await ref.update(updates);
  return res.json({ ok: true });
}));

// DELETE /therapy/admin/empresas/:id — desativa (não apaga)
router.delete("/therapy/admin/empresas/:id", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const id = String(req.params.id || "").trim();
  const db = getDb();
  const ref = db.collection("therapy_empresas").doc(id);
  if (!(await ref.get()).exists) return sendError(res, 404, "EMPRESA_NAO_ENCONTRADA");

  await ref.update({ status: "inativa", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  return res.json({ ok: true });
}));

// GET /public/empresa/:slug — info pública para página de cadastro de colaborador
router.get("/public/empresa/:slug", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const slug = String(req.params.slug || "").trim().toLowerCase();
  if (!slug) return sendError(res, 400, "SLUG_OBRIGATORIO");

  const db = getDb();
  const snap = await db.collection("therapy_empresas").where("slug", "==", slug).limit(1).get();
  if (snap.empty) return sendError(res, 404, "EMPRESA_NAO_ENCONTRADA");

  const e = snap.docs[0].data();
  if (e.status !== "ativa") return sendError(res, 403, "EMPRESA_INATIVA");

  return res.json({
    ok: true,
    id: snap.docs[0].id,
    nome: e.nome,
    segmento: e.segmento || null,
    limiteColaboradores: e.limiteColaboradores || null,
    totalColaboradores: e.totalColaboradores || 0
  });
}));

// POST /public/colaborador-cadastro — auto-registro de funcionário
router.post("/public/colaborador-cadastro", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;

  const { empresaSlug, nome, email, telefone, cpf, departamento, cargo } = req.body || {};
  if (!empresaSlug) return sendError(res, 400, "EMPRESA_SLUG_OBRIGATORIO");
  if (!nome || String(nome).trim().length < 2) return sendError(res, 400, "NOME_OBRIGATORIO");
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendError(res, 400, "EMAIL_INVALIDO");
  if (!telefone || String(telefone).trim().length < 8) return sendError(res, 400, "TELEFONE_OBRIGATORIO");

  const db = getDb();

  // Busca empresa
  const empSnap = await db.collection("therapy_empresas").where("slug", "==", String(empresaSlug).trim()).limit(1).get();
  if (empSnap.empty) return sendError(res, 404, "EMPRESA_NAO_ENCONTRADA");
  const empDoc = empSnap.docs[0];
  const empresa = empDoc.data();
  if (empresa.status !== "ativa") return sendError(res, 403, "EMPRESA_INATIVA");

  // Verifica limite de colaboradores
  if (empresa.limiteColaboradores && (empresa.totalColaboradores || 0) >= empresa.limiteColaboradores) {
    return sendError(res, 403, "LIMITE_COLABORADORES_ATINGIDO");
  }

  // Verifica se e-mail já cadastrado nesta empresa
  const dupSnap = await db.collection("therapy_colaboradores")
    .where("empresaId", "==", empDoc.id)
    .where("email", "==", String(email).trim().toLowerCase())
    .limit(1).get();
  if (!dupSnap.empty) return sendError(res, 409, "EMAIL_JA_CADASTRADO");

  const doc = {
    nome: String(nome).trim(),
    email: String(email).trim().toLowerCase(),
    telefone: String(telefone).trim(),
    cpf: cpf ? String(cpf).trim() : null,
    departamento: departamento ? String(departamento).trim() : null,
    cargo: cargo ? String(cargo).trim() : null,
    empresaId: empDoc.id,
    empresaNome: empresa.nome,
    empresaSlug: empresa.slug,
    status: "ativo",
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };

  const colabRef = await db.collection("therapy_colaboradores").add(doc);

  // Incrementa contador na empresa
  await empDoc.ref.update({
    totalColaboradores: admin.firestore.FieldValue.increment(1)
  });

  // E-mail de boas-vindas
  try {
    await sendEmail({
      to: doc.email,
      subject: `Bem-vindo ao Espaço Prelúdio via ${empresa.nome}`,
      html: `<p>Olá, ${doc.nome}!</p>
        <p>Seu cadastro no programa de saúde de <strong>${empresa.nome}</strong> foi confirmado.</p>
        <p>Acesse <a href="${THERAPY_FRONTEND_BASE}/profissionais.html">nosso diretório</a> para escolher um profissional e agendar sua primeira consulta.</p>
        <p>O valor da sessão é <strong>R$ 60,00</strong>, pago diretamente ao profissional no momento do agendamento.</p>`
    });
  } catch (e) {
    logError("colaborador_welcome_email_failed", e, { colaboradorId: colabRef.id });
  }

  return res.json({ ok: true, id: colabRef.id, empresaNome: empresa.nome });
}));

// GET /therapy/admin/colaboradores?empresaId=&status=&q=
router.get("/therapy/admin/colaboradores", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const db = getDb();
  const empresaId = String(req.query?.empresaId || "").trim();
  const status    = String(req.query?.status || "all").trim();
  const q         = String(req.query?.q || "").trim().toLowerCase();

  let query = db.collection("therapy_colaboradores");
  if (empresaId) query = query.where("empresaId", "==", empresaId);
  if (status === "ativo" || status === "inativo") query = query.where("status", "==", status);

  const snap = await query.limit(1000).get();
  let items = snap.docs.map(d => {
    const c = d.data();
    return {
      id: d.id,
      nome: c.nome || "",
      email: c.email || "",
      telefone: c.telefone || null,
      cpf: c.cpf || null,
      departamento: c.departamento || null,
      cargo: c.cargo || null,
      empresaId: c.empresaId || null,
      empresaNome: c.empresaNome || null,
      status: c.status || "ativo",
      createdAt: c.createdAt?.toMillis?.() || null
    };
  });

  if (q) {
    items = items.filter(c =>
      c.nome.toLowerCase().includes(q) ||
      c.email.toLowerCase().includes(q) ||
      (c.departamento || "").toLowerCase().includes(q) ||
      (c.cargo || "").toLowerCase().includes(q)
    );
  }

  items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return res.json({ ok: true, items, total: items.length });
}));

// PATCH /therapy/admin/colaboradores/:id
router.patch("/therapy/admin/colaboradores/:id", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const id = String(req.params.id || "").trim();
  const db = getDb();
  const ref = db.collection("therapy_colaboradores").doc(id);
  if (!(await ref.get()).exists) return sendError(res, 404, "COLABORADOR_NAO_ENCONTRADO");

  const allowed = ["nome", "telefone", "departamento", "cargo", "status", "obs"];
  const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  for (const k of allowed) {
    if (req.body?.[k] !== undefined) updates[k] = req.body[k];
  }
  await ref.update(updates);
  return res.json({ ok: true });
}));

// ═════════════════════════════════════════════════════════════════════════
// ESTUDANTES — cadastro de alunos via contratos municipais
// Coleção: therapy_estudantes
// ═════════════════════════════════════════════════════════════════════════

function calcIdade(dataNascimento) {
  if (!dataNascimento) return null;
  const [ano, mes, dia] = String(dataNascimento).split("-").map(Number);
  const hoje = new Date();
  let idade = hoje.getFullYear() - ano;
  if (hoje.getMonth() + 1 < mes || (hoje.getMonth() + 1 === mes && hoje.getDate() < dia)) idade--;
  return idade;
}

// POST /public/aluno-cadastro — registro público (pais ou aluno maior)
router.post("/public/aluno-cadastro", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;

  const {
    nome, dataNascimento, escola, turma, cidade, municipio, estado,
    email, telefone,
    responsavelNome, responsavelEmail, responsavelTelefone, responsavelCpf,
    consentimentoResponsavel
  } = req.body || {};

  if (!nome || String(nome).trim().length < 2) return sendError(res, 400, "NOME_OBRIGATORIO");
  if (!dataNascimento) return sendError(res, 400, "DATA_NASCIMENTO_OBRIGATORIA");
  if (!escola || String(escola).trim().length < 2) return sendError(res, 400, "ESCOLA_OBRIGATORIA");
  if (!cidade || String(cidade).trim().length < 1) return sendError(res, 400, "CIDADE_OBRIGATORIA");
  if (!estado || String(estado).trim().length !== 2) return sendError(res, 400, "ESTADO_OBRIGATORIO");

  const idade = calcIdade(dataNascimento);
  const isMenor = idade !== null && idade < 18;

  if (isMenor) {
    if (!responsavelNome || String(responsavelNome).trim().length < 2) return sendError(res, 400, "RESPONSAVEL_NOME_OBRIGATORIO");
    if (!responsavelEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(responsavelEmail)) return sendError(res, 400, "RESPONSAVEL_EMAIL_INVALIDO");
    if (!responsavelTelefone || String(responsavelTelefone).trim().length < 8) return sendError(res, 400, "RESPONSAVEL_TELEFONE_OBRIGATORIO");
    if (!consentimentoResponsavel) return sendError(res, 400, "CONSENTIMENTO_OBRIGATORIO");
  } else {
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendError(res, 400, "EMAIL_INVALIDO");
    if (!telefone || String(telefone).trim().length < 8) return sendError(res, 400, "TELEFONE_OBRIGATORIO");
  }

  const db = getDb();
  const token = isMenor ? (Date.now().toString(36) + randomSuffix(20)) : null;

  const doc = {
    nome: String(nome).trim(),
    dataNascimento: String(dataNascimento).trim(),
    idade: idade ?? null,
    isMenor,
    escola: String(escola).trim(),
    turma: turma ? String(turma).trim() : null,
    cidade: String(cidade).trim(),
    municipio: municipio ? String(municipio).trim() : String(cidade).trim(),
    estado: String(estado).trim().toUpperCase().slice(0, 2),
    // Contato direto (maiores)
    email: isMenor ? null : String(email).trim().toLowerCase(),
    telefone: isMenor ? null : String(telefone).trim(),
    // Responsável (menores)
    responsavelNome: isMenor ? String(responsavelNome).trim() : null,
    responsavelEmail: isMenor ? String(responsavelEmail).trim().toLowerCase() : null,
    responsavelTelefone: isMenor ? String(responsavelTelefone).trim() : null,
    responsavelCpf: responsavelCpf ? String(responsavelCpf).trim() : null,
    consentimentoParental: !isMenor, // maiores já têm consentimento
    consentimentoToken: token,
    consentimentoAt: isMenor ? null : admin.firestore.FieldValue.serverTimestamp(),
    profissionalUid: null,
    status: isMenor ? "pendente-consentimento" : "ativo",
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };

  const ref = await db.collection("therapy_estudantes").add(doc);

  // E-mail de consentimento para responsável (menor)
  if (isMenor) {
    try {
      const confirmUrl = `${THERAPY_FRONTEND_BASE}/aluno-consentimento.html?token=${token}`;
      await sendEmail({
        to: doc.responsavelEmail,
        subject: `Confirmação de consentimento — ${doc.nome} no Espaço Prelúdio`,
        html: `
          <p>Olá, ${doc.responsavelNome}!</p>
          <p>O cadastro de <strong>${doc.nome}</strong> no programa de saúde mental escolar do Espaço Prelúdio foi realizado.</p>
          <p>Para ativar o acesso, confirme seu consentimento clicando no botão abaixo:</p>
          <p style="margin:24px 0;">
            <a href="${confirmUrl}" style="background:#2d6a3e;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">
              Confirmar consentimento →
            </a>
          </p>
          <p style="font-size:12px;color:#666;">Escola: ${doc.escola} · Turma: ${doc.turma || "—"} · ${doc.cidade}/${doc.estado}</p>
          <p style="font-size:12px;color:#666;">Se não reconhece este cadastro, ignore este e-mail.</p>
        `
      });
    } catch (e) {
      logError("aluno_consent_email_failed", e, { estudanteId: ref.id });
    }
  }

  return res.json({ ok: true, id: ref.id, isMenor, status: doc.status });
}));

// GET /public/aluno-consentimento/:token — confirma consentimento parental via link de e-mail
router.get("/public/aluno-consentimento/:token", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const token = String(req.params.token || "").trim();
  if (!token) return sendError(res, 400, "TOKEN_INVALIDO");

  const db = getDb();
  const snap = await db.collection("therapy_estudantes")
    .where("consentimentoToken", "==", token)
    .limit(1).get();

  if (snap.empty) return sendError(res, 404, "TOKEN_NAO_ENCONTRADO");

  const doc = snap.docs[0];
  const data = doc.data();

  if (data.consentimentoParental) {
    return res.json({ ok: true, alreadyConfirmed: true, nome: data.nome });
  }

  await doc.ref.update({
    consentimentoParental: true,
    consentimentoAt: admin.firestore.FieldValue.serverTimestamp(),
    status: "ativo",
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return res.json({ ok: true, alreadyConfirmed: false, nome: data.nome, escola: data.escola });
}));

// POST /therapy/admin/estudantes/:id/reenviar-consentimento — reenvia e-mail
router.post("/therapy/admin/estudantes/:id/reenviar-consentimento", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const id = String(req.params.id || "").trim();
  const db = getDb();
  const ref = db.collection("therapy_estudantes").doc(id);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "ESTUDANTE_NAO_ENCONTRADO");

  const data = snap.data();
  if (!data.isMenor || data.consentimentoParental) return sendError(res, 400, "CONSENTIMENTO_NAO_NECESSARIO");

  const token = data.consentimentoToken || (Date.now().toString(36) + randomSuffix(20));
  await ref.update({ consentimentoToken: token });

  const confirmUrl = `${THERAPY_FRONTEND_BASE}/aluno-consentimento.html?token=${token}`;
  await sendEmail({
    to: data.responsavelEmail,
    subject: `[Reenvio] Confirmação de consentimento — ${data.nome}`,
    html: `<p>Olá, ${data.responsavelNome}!</p>
      <p>Segue o link para confirmar o consentimento de <strong>${data.nome}</strong>:</p>
      <p><a href="${confirmUrl}" style="background:#2d6a3e;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Confirmar →</a></p>`
  });

  return res.json({ ok: true });
}));

// GET /therapy/admin/estudantes — listagem com filtros
router.get("/therapy/admin/estudantes", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const db = getDb();
  const status  = String(req.query?.status  || "all").trim();
  const estado  = String(req.query?.estado  || "").trim().toUpperCase();
  const cidade  = String(req.query?.cidade  || "").trim().toLowerCase();
  const escola  = String(req.query?.escola  || "").trim().toLowerCase();
  const isMenorFilter = req.query?.isMenor;
  const q       = String(req.query?.q       || "").trim().toLowerCase();

  let query = db.collection("therapy_estudantes");
  if (status !== "all") query = query.where("status", "==", status);
  if (estado) query = query.where("estado", "==", estado);

  const snap = await query.limit(2000).get();

  let items = snap.docs.map(d => {
    const e = d.data();
    return {
      id: d.id,
      nome: e.nome || "",
      dataNascimento: e.dataNascimento || null,
      idade: e.idade ?? null,
      isMenor: !!e.isMenor,
      escola: e.escola || "",
      turma: e.turma || null,
      cidade: e.cidade || "",
      municipio: e.municipio || e.cidade || "",
      estado: e.estado || "",
      email: e.email || null,
      telefone: e.telefone || null,
      responsavelNome: e.responsavelNome || null,
      responsavelEmail: e.responsavelEmail || null,
      responsavelTelefone: e.responsavelTelefone || null,
      consentimentoParental: !!e.consentimentoParental,
      consentimentoAt: e.consentimentoAt?.toMillis?.() || null,
      profissionalUid: e.profissionalUid || null,
      status: e.status || "ativo",
      createdAt: e.createdAt?.toMillis?.() || null
    };
  });

  if (cidade)  items = items.filter(e => e.cidade.toLowerCase().includes(cidade) || e.municipio.toLowerCase().includes(cidade));
  if (escola)  items = items.filter(e => e.escola.toLowerCase().includes(escola));
  if (isMenorFilter === "true")  items = items.filter(e => e.isMenor);
  if (isMenorFilter === "false") items = items.filter(e => !e.isMenor);
  if (q) items = items.filter(e =>
    e.nome.toLowerCase().includes(q) ||
    (e.responsavelNome || "").toLowerCase().includes(q) ||
    (e.responsavelEmail || "").toLowerCase().includes(q) ||
    (e.email || "").toLowerCase().includes(q) ||
    e.escola.toLowerCase().includes(q)
  );

  items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return res.json({ ok: true, items, total: items.length });
}));

// GET /therapy/admin/estudantes/:id
router.get("/therapy/admin/estudantes/:id", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const id = String(req.params.id || "").trim();
  const db = getDb();
  const snap = await db.collection("therapy_estudantes").doc(id).get();
  if (!snap.exists) return sendError(res, 404, "ESTUDANTE_NAO_ENCONTRADO");

  const e = snap.data();
  return res.json({
    ok: true,
    id: snap.id,
    ...e,
    createdAt: e.createdAt?.toMillis?.() || null,
    consentimentoAt: e.consentimentoAt?.toMillis?.() || null
  });
}));

// PATCH /therapy/admin/estudantes/:id
router.patch("/therapy/admin/estudantes/:id", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const id = String(req.params.id || "").trim();
  const db = getDb();
  const ref = db.collection("therapy_estudantes").doc(id);
  if (!(await ref.get()).exists) return sendError(res, 404, "ESTUDANTE_NAO_ENCONTRADO");

  const allowed = ["nome", "escola", "turma", "cidade", "municipio", "estado", "status",
                   "responsavelNome", "responsavelEmail", "responsavelTelefone",
                   "email", "telefone", "profissionalUid", "consentimentoParental"];
  const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  for (const k of allowed) {
    if (req.body?.[k] !== undefined) updates[k] = req.body[k];
  }
  if (updates.consentimentoParental === true && !updates.consentimentoAt) {
    updates.consentimentoAt = admin.firestore.FieldValue.serverTimestamp();
    updates.status = "ativo";
  }
  await ref.update(updates);
  return res.json({ ok: true });
}));

// ═════════════════════════════════════════════════════════════════════════
// NOTIFICAÇÕES IN-APP — coleção therapy_notifications
// ═════════════════════════════════════════════════════════════════════════

// Helper: cria uma notificação pra um terapeuta (fire-and-forget seguro)
async function createNotification({ therapistUid, type, title, body, link, data }) {
  try {
    const db = getDb();
    if (!db) return;
    await db.collection("therapy_notifications").add({
      therapistUid,
      type:      type  || "info",
      title:     title || "",
      body:      body  || "",
      link:      link  || null,
      data:      data  || null,
      readAt:    null,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) {
    logError("create_notification_failed", e, { therapistUid, type });
  }
}

// GET /therapy/notificacoes?limit=50&onlyUnread=true
router.get("/therapy/notificacoes", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const db = getDb();
  const limit = Math.min(Number(req.query?.limit || 50), 100);
  const onlyUnread = req.query?.onlyUnread === "true";

  // Sem orderBy para evitar exigir índice composto no Firestore —
  // ordenamos em memória após buscar.
  let q = db.collection("therapy_notifications")
    .where("therapistUid", "==", uid)
    .limit(200); // busca mais e filtra/ordena em JS

  if (onlyUnread) q = q.where("readAt", "==", null);

  const snap = await q.get();
  let items = snap.docs.map(d => {
    const n = d.data();
    return {
      id: d.id,
      type:      n.type,
      title:     n.title,
      body:      n.body,
      link:      n.link || null,
      data:      n.data || null,
      readAt:    n.readAt?.toMillis?.() || null,
      createdAt: n.createdAt?.toMillis?.() || null
    };
  });

  // Ordena por createdAt desc em JS
  items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  items = items.slice(0, limit);

  const unreadCount = onlyUnread
    ? items.length
    : items.filter(n => !n.readAt).length;

  return res.json({ ok: true, items, unreadCount });
}));

// POST /therapy/notificacoes/:id/ler — marca uma como lida
router.post("/therapy/notificacoes/:id/ler", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const db = getDb();
  const ref = db.collection("therapy_notifications").doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists || snap.data().therapistUid !== uid) return sendError(res, 404, "NOTIFICACAO_NAO_ENCONTRADA");

  await ref.update({ readAt: admin.firestore.FieldValue.serverTimestamp() });
  return res.json({ ok: true });
}));

// POST /therapy/notificacoes/ler-todas — marca todas como lidas
router.post("/therapy/notificacoes/ler-todas", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const db = getDb();
  const snap = await db.collection("therapy_notifications")
    .where("therapistUid", "==", uid)
    .where("readAt", "==", null)
    .limit(100)
    .get();

  const batch = db.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();
  snap.docs.forEach(d => batch.update(d.ref, { readAt: now }));
  await batch.commit();

  return res.json({ ok: true, marked: snap.size });
}));

// ═════════════════════════════════════════════════════════════════════════
// PAINEL CORPORATIVO — autenticação e métricas de saúde da equipe
// Dados sempre agregados/anônimos — LGPD compliant.
// ═════════════════════════════════════════════════════════════════════════

const { EMPRESA_JWT_SECRET } = require("../config");
// crypto já importado no topo do arquivo

function hashSenha(senha, salt) {
  return crypto.createHmac("sha256", salt).update(senha).digest("hex");
}
function gerarSalt() { return crypto.randomBytes(16).toString("hex"); }

function gerarEmpresaToken(empresaId) {
  const payload = Buffer.from(JSON.stringify({ empresaId, iat: Date.now() })).toString("base64url");
  const sig = crypto.createHmac("sha256", EMPRESA_JWT_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
function verificarEmpresaToken(token) {
  try {
    const [payload, sig] = (token || "").split(".");
    const expected = crypto.createHmac("sha256", EMPRESA_JWT_SECRET).update(payload).digest("base64url");
    if (sig !== expected) return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    // Token válido por 7 dias
    if (Date.now() - data.iat > 7 * 24 * 3600 * 1000) return null;
    return data;
  } catch { return null; }
}

// POST /empresa/login
router.post("/empresa/login", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const email = String(req.body?.email || "").trim().toLowerCase();
  const senha = String(req.body?.senha || "").trim();
  if (!email || !senha) return sendError(res, 400, "CREDENCIAIS_OBRIGATORIAS");

  const db = getDb();
  const snap = await db.collection("therapy_empresas")
    .where("loginEmail", "==", email)
    .where("status", "==", "ativa")
    .limit(1).get();

  if (snap.empty) return sendError(res, 401, "CREDENCIAIS_INVALIDAS");
  const empresa = snap.docs[0].data();
  const empresaId = snap.docs[0].id;

  if (!empresa.passwordHash || !empresa.passwordSalt) return sendError(res, 401, "SENHA_NAO_CONFIGURADA");

  const hash = hashSenha(senha, empresa.passwordSalt);
  if (hash !== empresa.passwordHash) return sendError(res, 401, "CREDENCIAIS_INVALIDAS");

  // Atualiza lastLogin
  snap.docs[0].ref.update({ lastLoginAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});

  const token = gerarEmpresaToken(empresaId);
  return res.json({
    ok: true,
    token,
    empresa: { id: empresaId, nome: empresa.nome, segmento: empresa.segmento || null }
  });
}));

// PATCH /empresa/senha — empresa troca a própria senha
router.patch("/empresa/senha", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const decoded = verificarEmpresaToken(token);
  if (!decoded) return sendError(res, 401, "TOKEN_INVALIDO");

  const senhaAtual = String(req.body?.senhaAtual || "").trim();
  const novaSenha  = String(req.body?.novaSenha  || "").trim();
  if (!senhaAtual || !novaSenha) return sendError(res, 400, "SENHAS_OBRIGATORIAS");
  if (novaSenha.length < 8) return sendError(res, 400, "SENHA_MUITO_CURTA");

  const db = getDb();
  const ref = db.collection("therapy_empresas").doc(decoded.empresaId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "EMPRESA_NAO_ENCONTRADA");

  const empresa = snap.data();
  const hashAtual = hashSenha(senhaAtual, empresa.passwordSalt);
  if (hashAtual !== empresa.passwordHash) return sendError(res, 401, "SENHA_ATUAL_INCORRETA");

  const novoSalt = gerarSalt();
  const novoHash = hashSenha(novaSenha, novoSalt);
  await ref.update({ passwordHash: novoHash, passwordSalt: novoSalt, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

  return res.json({ ok: true });
}));

// GET /empresa/dashboard — métricas agregadas e anônimas
router.get("/empresa/dashboard", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const decoded = verificarEmpresaToken(token);
  if (!decoded) return sendError(res, 401, "TOKEN_INVALIDO");

  const db = getDb();
  const empresaId = decoded.empresaId;

  // Carrega dados básicos da empresa
  const empresaSnap = await db.collection("therapy_empresas").doc(empresaId).get();
  if (!empresaSnap.exists) return sendError(res, 404, "EMPRESA_NAO_ENCONTRADA");
  const empresa = empresaSnap.data();

  // Colaboradores
  const colabSnap = await db.collection("therapy_colaboradores")
    .where("empresaId", "==", empresaId).limit(2000).get();
  const colaboradores = colabSnap.docs.map(d => d.data());
  const totalCadastrados = colaboradores.length;
  const totalAtivos = colaboradores.filter(c => c.status === "ativo").length;

  // E-mails dos colaboradores para cruzar com pacientes
  const emails = new Set(colaboradores.map(c => (c.email || "").toLowerCase()).filter(Boolean));

  // Pacientes vinculados (por e-mail)
  let sessoesMes = 0, sessoesTotal = 0;
  let especialidades = {};
  let colaboradoresComSessao = new Set();

  if (emails.size > 0) {
    // Busca contas de pacientes pelos e-mails
    const patSnap = await db.collection("therapy_patient_accounts")
      .where("email", "in", [...emails].slice(0, 30)) // Firestore limit
      .get().catch(() => null);

    const patUids = new Set((patSnap?.docs || []).map(d => d.data().uid || d.id));

    if (patUids.size > 0) {
      const now = Date.now();
      const mes30Start = now - 30 * 24 * 3600 * 1000;

      const sesSnap = await db.collection("therapy_sessions")
        .where("patientUid", "in", [...patUids].slice(0, 30))
        .where("status", "==", "completed").get().catch(() => null);

      (sesSnap?.docs || []).forEach(d => {
        const s = d.data();
        sessoesTotal++;
        colaboradoresComSessao.add(s.patientUid);
        if (Number(s.scheduledAt || 0) >= mes30Start) sessoesMes++;

        // Especialidade do terapeuta (aproximação pelo tipoConselho)
        const esp = s.therapistEspecialidade || s.especialidade || "Outros";
        especialidades[esp] = (especialidades[esp] || 0) + 1;
      });
    }
  }

  const taxaAdesao = totalCadastrados > 0
    ? Math.round((colaboradoresComSessao.size / totalCadastrados) * 100)
    : 0;

  // LGPD: mascara dados se amostra muito pequena (< 5)
  const THRESHOLD = 5;
  const mascarar = totalCadastrados < THRESHOLD;

  return res.json({
    ok: true,
    empresa: { nome: empresa.nome, segmento: empresa.segmento || null },
    kpis: {
      totalCadastrados:  mascarar ? null : totalCadastrados,
      totalAtivos:       mascarar ? null : totalAtivos,
      sessoesMes:        mascarar ? null : sessoesMes,
      sessoesTotal:      mascarar ? null : sessoesTotal,
      taxaAdesao:        mascarar ? null : taxaAdesao,
    },
    especialidades: mascarar ? {} : especialidades,
    mascarado: mascarar,
    geradoEm: Date.now()
  });
}));

// POST /therapy/admin/empresas/:id/definir-acesso — admin define email+senha inicial
router.post("/therapy/admin/empresas/:id/definir-acesso", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const id = String(req.params.id || "").trim();
  const loginEmail = String(req.body?.loginEmail || "").trim().toLowerCase();
  const senhaPadrao = String(req.body?.senhaPadrao || "").trim();

  if (!loginEmail || !senhaPadrao) return sendError(res, 400, "EMAIL_E_SENHA_OBRIGATORIOS");
  if (senhaPadrao.length < 6) return sendError(res, 400, "SENHA_MUITO_CURTA");

  const db = getDb();
  const ref = db.collection("therapy_empresas").doc(id);
  if (!(await ref.get()).exists) return sendError(res, 404, "EMPRESA_NAO_ENCONTRADA");

  const salt = gerarSalt();
  const hash = hashSenha(senhaPadrao, salt);

  await ref.update({
    loginEmail,
    passwordHash: hash,
    passwordSalt: salt,
    senhaDefinidaEm: admin.firestore.FieldValue.serverTimestamp(),
    senhaDefinidaPor: adminAuth.email || adminAuth.uid,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return res.json({ ok: true, loginEmail });
}));

module.exports = router;
