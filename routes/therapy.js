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
const admin   = require("firebase-admin");
const crypto  = require("crypto");
const { AccessToken } = require("livekit-server-sdk");

const { logError, logInfo } = require("../logger");
const { asyncHandler, sendError } = require("../utils");
const { ensureDb, getDb } = require("../services/firestore");
const { verifyFirebaseToken, signPayload, verifySignedToken, getBearerToken } = require("../services/auth");
const {
  LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL, ACCESS_TOKEN_SECRET,
  THERAPY_ADMIN_EMAILS,
  THERAPY_PLAN_AMOUNT, THERAPY_PLAN_RECEM_FORMADO_AMOUNT, THERAPY_PLAN_PROFISSIONAL_AMOUNT,
  THERAPY_PLAN_NAME,
  THERAPY_TRIAL_DAYS, THERAPY_TRIAL_DAYS_PROFISSIONAL, THERAPY_TRIAL_DAYS_RECEM_FORMADO,
  THERAPY_FRONTEND_BASE,
  THERAPY_MIN_CANCEL_HOURS_PATIENT,
  MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET
} = require("../config");
const { mercadoPagoFetch } = require("../services/payments");
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
  isValidPracticeType
} = require("../services/professional-councils");
const {
  sendEmail, templateConfirmation, templateDispensacaoNotice,
  templateStudentApproved, templateStudentRejected,
  templateRecemFormadoApproved, templateRecemFormadoRejected,
  templateFormacaoApproved, templateFormacaoRejected,
  buildJoinUrl: buildPatientJoinUrl, buildCancelUrl: buildPatientCancelUrl,
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
//   - student-active        → libera (tier estudante gratuito)
//   - pro                   → libera (assinatura paga e ativa)
//   - trial COM trialUntil > now → libera (período gratuito)
//   - qualquer outro estado → bloqueia (trial expirado, canceled, expired,
//                              recem-formado-eligible que não contratou ainda,
//                              pending-review além do trial)
// Retorna { ok: bool, reason?: string, plano: string, trialUntil?: number }
function evaluatePlanAccess(therapist) {
  if (!therapist) return { ok: false, reason: "PROFISSIONAL_NAO_REGISTRADO", plano: null };
  const plano = therapist.plano || "trial";
  if (plano === "student-active" || plano === "pro") {
    return { ok: true, plano };
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
//   "receita"             — só CRM (prescrição medicamentosa, RDC ANVISA)
//   "documentos-clinicos" — CRM + CRP + CRN + CRO (atestado de doença,
//                           relatório, encaminhamento). CRESS/CREFITO/CRFa/
//                           CREF não emitem porque não é prerrogativa do
//                           conselho deles.
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
        { hint: "Aceitos: psicanalise, terapia-integrativa, hipnoterapia." });
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

  // Tier escolhido na landing — define duração do trial. Aceita: "estudante",
  // "recem-formado" (alias: "recem"), "profissional" (default).
  const intendedTierRaw = String(req.body?.intendedTier || "").trim().toLowerCase();
  const intendedTier =
    intendedTierRaw === "estudante"      ? "estudante"     :
    intendedTierRaw === "recem"          ? "recem-formado" :
    intendedTierRaw === "recem-formado"  ? "recem-formado" :
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
    especialidade,
    bio,
    e2eeSalt:      lockedSalt,
    wrappedDEK:    lockedWrappedDEK,
    wrappedDEKIv:  lockedWrappedDEKIv,
    role: "therapist",
    plano: existingData?.plano || "trial",
    intendedTier: existingData?.intendedTier || intendedTier,
    trialUntil,
    consentLgpd: true,
    consentLgpdAt: existingData?.consentLgpdAt || admin.firestore.FieldValue.serverTimestamp(),
    createdAt: existingData?.createdAt || admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  if (formacaoNaoRegulamentada) {
    therapistDoc.formacaoNaoRegulamentada = formacaoNaoRegulamentada;
    // Marca verificação como pending-review já no cadastro — SEM_CONSELHO
    // nunca passa por aprovação automática. Admin precisa revisar diploma
    // (S22.1) antes de habilitar verificationStatus="verified".
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
      uid, displayName, crp, crm, tipoConselho, numeroConselho, especialidade, bio,
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
// "recém-formado" (R$ 49,90/mês — disponível se inscrição no conselho
// foi nos últimos 12 meses).
// Reusa hash dedup, rate limit, fluxo do tier estudante.
// Estados em therapists/{uid}.plano:
//   "recem-formado-pending-review"  — confiança média, fila admin
//   "recem-formado-eligible"        — aprovado, pode iniciar assinatura R$ 49,90
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
  // Conselho profissional: atualização atômica via { tipoConselho, numeroConselho }.
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

  return res.json({
    ok: true,
    therapist,
    planAccess: {
      canUseFeatures: access.ok,
      reason: access.reason || null,
      plano: access.plano,
      trialUntil: trialUntilMs || null,
      trialDaysLeft: daysLeft
    },
    conselho: {
      sigla: conselhoSigla || null,
      label: conselho?.label || null,
      profissional: conselho?.profissional || null,
      capabilities
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
    }

    batch.set(db.collection("therapy_sessions").doc(sId), {
      sessionId: sId,
      therapistUid: uid,
      therapistDisplayName: therapist.displayName || "",
      therapistEmail,
      patientName,
      patientId: patientId || null,
      patientEmail,
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
      joinUrl: buildPatientJoinUrl(firstJoinToken),
      cancelUrl: buildPatientCancelUrl(cancelTokenInfo.token)
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
  await logAudit({
    type: "session_created",
    sessionId: created[0].sessionId,
    therapistUid: uid,
    recurrenceGroupId,
    recurrenceCount: isRecurring ? occurrences : null
  });

  const first = created[0];
  return res.json({
    ok: true,
    session: {
      sessionId: first.sessionId,
      livekitRoom: `therapy_${first.sessionId}`,
      patientName,
      scheduledAt: first.scheduledAt,
      status: "scheduled",
      joinToken: firstJoinToken,
      joinTokenExp: firstJoinTokenExp
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
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  return res.json({ ok: true, joinToken, joinTokenExp: joinPayload.exp });
}));

// GET /therapy/sessoes — lista as sessões do profissional logado
router.get("/therapy/sessoes", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const db = getDb();
  // Sem orderBy server-side pra evitar exigência de composite index no
  // Firestore. Limit defensivo de 200; ordenação é feita client-side.
  // Filtro hiddenFromPainel também client-side pelo mesmo motivo (composite
  // index). Painel só mostra sessões não ocultas; prontuário do paciente
  // continua mostrando tudo (rota /therapy/pacientes/:id/sessoes).
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
        status: data.status,
        scheduledAt: data.scheduledAt || null,
        livekitRoom: data.livekitRoom,
        createdAt: data.createdAt?.toMillis ? data.createdAt.toMillis() : null,
        completedAt: data.completedAt?.toMillis ? data.completedAt.toMillis() : null,
        canceledAt: data.canceledAt?.toMillis ? data.canceledAt.toMillis() : null,
        canceledBy: data.canceledBy || null,
        cancelReason: data.cancelReason || null,
        joinTokenExp: data.joinTokenExp || null,
        recurrenceGroupId: data.recurrenceGroupId || null,
        recurrenceIndex: typeof data.recurrenceIndex === "number" ? data.recurrenceIndex : null,
        recurrenceCount: data.recurrenceCount || null,
        hiddenFromPainel: data.hiddenFromPainel === true
      };
    })
    .filter(s => !s.hiddenFromPainel)
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

  const therapist = await loadTherapist(uid);
  const identity = `pro_${uid}`;
  const livekitToken = await issueLivekitToken({
    room: session.livekitRoom,
    identity,
    name: therapist?.displayName || "Profissional",
    ttlMs: SESSION_TOKEN_VALIDITY_MS
  });

  await db.collection("therapy_sessions").doc(sessionId).set({
    status: session.status === "completed" ? session.status : "in_progress",
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
    e2eeSalt: therapist?.e2eeSalt || null
  });
}));

// ─────────────────────────────────────────────────────────────────────────
// POST /therapy/sessao/join
// Paciente troca joinToken + nome por livekitToken. Sem auth Firebase.
// Body: { joinToken, patientName?, consentLgpd: true }
// ─────────────────────────────────────────────────────────────────────────
router.post("/therapy/sessao/join", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  if (!ensureLivekit(res)) return;

  const joinToken   = String(req.body?.joinToken   || "").trim();
  const patientName = String(req.body?.patientName || "").trim().slice(0, PATIENT_NAME_MAX);
  const consentLgpd = !!req.body?.consentLgpd;
  const patientIdToken = String(req.body?.patientIdToken || "").trim();

  if (!joinToken)   return sendError(res, 400, "JOIN_TOKEN_OBRIGATORIO");
  if (!consentLgpd) return sendError(res, 400, "CONSENTIMENTO_LGPD_OBRIGATORIO");

  const verification = verifySignedToken(joinToken, ACCESS_TOKEN_SECRET);
  if (!verification.valid) return sendError(res, 401, verification.error || "JOIN_TOKEN_INVALIDO");
  const payload = verification.payload;
  if (payload.token_type !== "therapy_join") return sendError(res, 401, "JOIN_TOKEN_NAO_AUTORIZADO");

  const db = getDb();
  const snap = await db.collection("therapy_sessions").doc(payload.sessionId).get();
  if (!snap.exists) return sendError(res, 404, "SESSAO_NAO_ENCONTRADA");
  const session = snap.data();
  if (session.status === "completed") return sendError(res, 410, "SESSAO_ENCERRADA");

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
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  if (patientAccountUid) sessionUpdate.patientAccountUid = patientAccountUid;

  await db.collection("therapy_sessions").doc(payload.sessionId).set(sessionUpdate, { merge: true });

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

  await db.collection("therapy_sessions").doc(sessionId).set({
    status: "completed",
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({ type: "session_completed", sessionId, therapistUid: uid });

  return res.json({ ok: true });
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

async function applyCancellation(db, sessionId, sessData, { canceledBy, reason }) {
  const update = {
    status: "canceled",
    canceledAt: admin.firestore.FieldValue.serverTimestamp(),
    canceledBy,
    cancelReason: reason || null,
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
    return res.json({ ok: true, canceledCount: 1 });
  }

  // "forward": esta + todas as ocorrências futuras do grupo. Sem grupo,
  // cai pro comportamento "this" silenciosamente.
  if (!sessData.recurrenceGroupId) {
    if (sessData.status === "canceled") return res.json({ ok: true, alreadyCanceled: true, canceledCount: 0 });
    await applyCancellation(db, sessionId, sessData, { canceledBy: "therapist", reason });
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

  return res.json({ ok: true, canceledCount, scope: "forward" });
}));

// (b) Paciente cancela via link público (token assinado)
router.post("/therapy/sessao/cancelar-publico", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const token = String(req.body?.cancelToken || "").trim();
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
  return res.json({ ok: true });
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
    createdAt: existingData?.createdAt || admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({
    type: "patient_account_registered",
    patientAccountUid: uid,
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || null
  });

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
  if (!requireCapability(therapist, res, "receita",
    "Apenas profissionais com CRM podem emitir receitas medicamentosas (RDC ANVISA).")) return;

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
    formCiphertext,
    formIv,
    quantidadePrescrita,
    quantidadeDispensada: 0,
    dispensacaoStatus: "pendente",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await logAudit({ type: "receita_created", receitaId, therapistUid: uid, patientId });

  return res.json({ ok: true, receitaId });
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
  if (!requireCapability(therapistDoc, res, "receita",
    "Apenas profissionais com CRM podem assinar receitas medicamentosas.")) return;

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
  if (!requireCapability(therapist, res, "documentos-clinicos",
    "Atestado de doença, encaminhamento e relatório clínico só podem ser emitidos por médicos (CRM) e psicólogos (CRP).")) return;

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
  if (!requireCapability(therapistDoc, res, "documentos-clinicos",
    "Apenas médicos (CRM) e psicólogos (CRP) podem editar documentos clínicos.")) return;

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
  if (!requireCapability(therapistDoc, res, "documentos-clinicos",
    "Apenas médicos (CRM) e psicólogos (CRP) podem assinar documentos clínicos.")) return;

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
//   1) THERAPY_PLAN_AMOUNT (env, default 49.90)
//   2) MP_ACCESS_TOKEN (já configurado pro jogo)
//   3) MP_WEBHOOK_SECRET (recomendado pra produção)
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
// Body opcional: { tier: "recem-formado" | "profissional" }
//   - "recem-formado" → cobra R$ 49,90 (exige plano === "recem-formado-eligible")
//   - "profissional"  → cobra R$ 120
//   - sem tier (compat) → cobra THERAPY_PLAN_AMOUNT (default 49,90)
router.post("/therapy/profissional/plano/iniciar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 403, "PROFISSIONAL_NAO_REGISTRADO");

  // Determina tier + preço. Default mantém compat (sem flag = THERAPY_PLAN_AMOUNT).
  const tier = String(req.body?.tier || "").trim().toLowerCase();
  let amount, planTier, planLabel;
  if (tier === "recem-formado") {
    if (therapist.plano !== "recem-formado-eligible") {
      return sendError(res, 403, "RECEM_FORMADO_NAO_ELEGIVEL", {
        detail: "Envie o comprovante de inscrição CRP/CRM em /comprovante-recem-formado.html antes de assinar este tier."
      });
    }
    amount = THERAPY_PLAN_RECEM_FORMADO_AMOUNT;
    planTier = "recem-formado";
    planLabel = `${THERAPY_PLAN_NAME} — Recém-formado`;
  } else if (tier === "profissional") {
    amount = THERAPY_PLAN_PROFISSIONAL_AMOUNT;
    planTier = "profissional";
    planLabel = `${THERAPY_PLAN_NAME} — Profissional`;
  } else {
    // Compat: chamadas antigas sem tier usam o default histórico
    amount = THERAPY_PLAN_AMOUNT;
    planTier = "default";
    planLabel = THERAPY_PLAN_NAME;
  }

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
      frequency: 1,
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
    ({ response, data } = await mercadoPagoFetch("https://api.mercadopago.com/preapproval", {
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
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({
    type: "therapy_plano_iniciado",
    therapistUid: uid,
    preapprovalId: data.id,
    tier: planTier,
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
    ({ response, data } = await mercadoPagoFetch(
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

  // Validação de assinatura (best-effort — sem MP_WEBHOOK_SECRET, só loga warning)
  if (MP_WEBHOOK_SECRET && dataId) {
    try {
      const sigHeader = String(req.headers["x-signature"] || "");
      const reqId     = String(req.headers["x-request-id"] || "");
      if (sigHeader && reqId) {
        const parts = Object.fromEntries(sigHeader.split(",").map(p => p.trim().split("=")));
        const ts = parts.ts, v1 = parts.v1;
        if (ts && v1) {
          const template = `id:${dataId};request-id:${reqId};ts:${ts};`;
          const expected = crypto.createHmac("sha256", MP_WEBHOOK_SECRET).update(template).digest("hex");
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

  // Busca o estado atual do preapproval na API MP
  let preapproval;
  try {
    const { response, data } = await mercadoPagoFetch(
      `https://api.mercadopago.com/preapproval/${encodeURIComponent(dataId)}`
    );
    if (!response.ok) {
      logError("therapy_mp_preapproval_fetch_failed", new Error("FETCH_FAIL"), { dataId, status: response.status });
      return res.status(200).json({ ok: true, ignored: true, reason: "FETCH_FAIL" });
    }
    preapproval = data;
  } catch (err) {
    logError("therapy_mp_preapproval_fetch_error", err, { dataId });
    return res.status(200).json({ ok: true, ignored: true, reason: "NETWORK" });
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

  await db.collection("therapists").doc(uid).set(update, { merge: true });

  await logAudit({
    type: "therapy_mp_webhook",
    therapistUid: uid,
    preapprovalId: preapproval.id,
    mpStatus: status,
    plano: plano || "unchanged"
  });

  return res.status(200).json({ ok: true });
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
    "studentDoc.decision": "approved",
    "studentDoc.reviewedBy": adminAuth.email,
    "studentDoc.reviewedAt": admin.firestore.FieldValue.serverTimestamp(),
    "studentDoc.reviewNotes": notes,
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
    "studentDoc.decision": "rejected",
    "studentDoc.reviewedBy": adminAuth.email,
    "studentDoc.reviewedAt": admin.firestore.FieldValue.serverTimestamp(),
    "studentDoc.reviewNotes": reason,
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
router.post("/therapy/admin/comprovantes-recem-formado/:uid/aprovar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const adminAuth = await verifyAdminTherapy(req, res);
  if (!adminAuth) return;

  const targetUid = String(req.params.uid || "").trim();
  if (!targetUid) return sendError(res, 400, "UID_OBRIGATORIO");

  const therapist = await loadTherapist(targetUid);
  if (!therapist) return sendError(res, 404, "PROFISSIONAL_NAO_ENCONTRADO");

  const notes = String(req.body?.notes || "").trim().slice(0, 500);

  await getDb().collection("therapists").doc(targetUid).set({
    plano: "recem-formado-eligible",
    recemFormadoVerifiedAt: admin.firestore.FieldValue.serverTimestamp(),
    "recemFormadoDoc.decision": "approved",
    "recemFormadoDoc.reviewedBy": adminAuth.email,
    "recemFormadoDoc.reviewedAt": admin.firestore.FieldValue.serverTimestamp(),
    "recemFormadoDoc.reviewNotes": notes,
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
    "recemFormadoDoc.decision": "rejected",
    "recemFormadoDoc.reviewedBy": adminAuth.email,
    "recemFormadoDoc.reviewedAt": admin.firestore.FieldValue.serverTimestamp(),
    "recemFormadoDoc.reviewNotes": reason,
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
    "formacaoDoc.decision": "approved",
    "formacaoDoc.reviewedBy": adminAuth.email,
    "formacaoDoc.reviewedAt": admin.firestore.FieldValue.serverTimestamp(),
    "formacaoDoc.reviewNotes": notes,
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
    "formacaoDoc.decision": "rejected",
    "formacaoDoc.reasons": [reason],
    "formacaoDoc.reviewedBy": adminAuth.email,
    "formacaoDoc.reviewedAt": admin.firestore.FieldValue.serverTimestamp(),
    "formacaoDoc.reviewNotes": reason,
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

// GET /therapy/health — diagnóstico isolado
router.get("/therapy/health", (req, res) => {
  res.json({
    ok: true,
    livekitConfigured: !!(LIVEKIT_API_KEY && LIVEKIT_API_SECRET),
    livekitUrl: LIVEKIT_URL,
    mpAccessTokenConfigured:   !!MP_ACCESS_TOKEN,
    mpWebhookSecretConfigured: !!MP_WEBHOOK_SECRET,
    docValidatorProvider: String(process.env.DOC_VALIDATOR_PROVIDER || "claude").toLowerCase()
  });
});

module.exports = router;
