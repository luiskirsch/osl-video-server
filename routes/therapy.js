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
  THERAPY_PLAN_AMOUNT, THERAPY_PLAN_NAME, THERAPY_TRIAL_DAYS, THERAPY_FRONTEND_BASE,
  MP_WEBHOOK_SECRET
} = require("../config");
const { mercadoPagoFetch } = require("../services/payments");

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
// Body: { displayName, crp?, crm?, especialidade?, bio?, e2eeSalt }
//   e2eeSalt: base64 (16-32 bytes) gerado client-side ao criar conta. Imutável depois.
// ─────────────────────────────────────────────────────────────────────────
router.post("/therapy/profissional/registrar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const displayName   = String(req.body?.displayName   || "").trim().slice(0, 80);
  const crp           = String(req.body?.crp           || "").trim().slice(0, 20).toUpperCase();
  const crm           = String(req.body?.crm           || "").trim().slice(0, 20).toUpperCase();
  const especialidade = String(req.body?.especialidade || "").trim().slice(0, 60);
  const bio           = String(req.body?.bio           || "").trim().slice(0, 500);
  const e2eeSalt      = String(req.body?.e2eeSalt      || "").trim();
  const wrappedDEK    = String(req.body?.wrappedDEK    || "").trim();
  const wrappedDEKIv  = String(req.body?.wrappedDEKIv  || "").trim();
  const consentLgpd   = !!req.body?.consentLgpd;

  if (!displayName)   return sendError(res, 400, "NOME_OBRIGATORIO");
  if (!consentLgpd)   return sendError(res, 400, "CONSENTIMENTO_LGPD_OBRIGATORIO");
  if (!crp && !crm)   return sendError(res, 400, "REGISTRO_PROFISSIONAL_OBRIGATORIO");
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
  const trialUntil = existingData?.trialUntil
    || (Date.now() + THERAPY_TRIAL_DAYS * 24 * 60 * 60 * 1000);

  await ref.set({
    uid,
    displayName,
    crp,
    crm,
    especialidade,
    bio,
    e2eeSalt:      lockedSalt,
    wrappedDEK:    lockedWrappedDEK,
    wrappedDEKIv:  lockedWrappedDEKIv,
    role: "therapist",
    plano: existingData?.plano || "trial",
    trialUntil,
    consentLgpd: true,
    consentLgpdAt: existingData?.consentLgpdAt || admin.firestore.FieldValue.serverTimestamp(),
    createdAt: existingData?.createdAt || admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({
    type: "therapist_registered",
    therapistUid: uid,
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || null
  });

  return res.json({
    ok: true,
    therapist: {
      uid, displayName, crp, crm, especialidade, bio,
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
  if (req.body?.crp !== undefined) {
    updates.crp = String(req.body.crp || "").trim().toUpperCase().slice(0, 20);
  }
  if (req.body?.crm !== undefined) {
    updates.crm = String(req.body.crm || "").trim().toUpperCase().slice(0, 20);
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

  return res.json({ ok: true, therapist });
}));

// ─────────────────────────────────────────────────────────────────────────
// POST /therapy/sessao/criar
// Cria uma consulta agendada/imediata. Devolve link com joinToken para o paciente.
// Body: { patientName, scheduledAt?, notes? (rascunho cifrado opcional) }
// ─────────────────────────────────────────────────────────────────────────
router.post("/therapy/sessao/criar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 403, "PROFISSIONAL_NAO_REGISTRADO");

  const patientName = String(req.body?.patientName || "Paciente").trim().slice(0, PATIENT_NAME_MAX);
  const patientId   = String(req.body?.patientId || "").trim();
  const scheduledAtRaw = Number(req.body?.scheduledAt || 0);
  const scheduledAt = Number.isFinite(scheduledAtRaw) && scheduledAtRaw > 0 ? scheduledAtRaw : null;

  // Se patientId passado, valida ownership.
  if (patientId) {
    const db0 = getDb();
    const psnap = await db0.collection("therapy_patients").doc(patientId).get();
    if (!psnap.exists) return sendError(res, 404, "PACIENTE_NAO_ENCONTRADO");
    if (psnap.data().therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");
  }

  const sessionId   = newId("sess");
  const livekitRoom = `therapy_${sessionId}`;
  // Chave E2EE da sala: 32 bytes aleatórios. LiveKit Cloud nunca a recebe — só
  // os dois clientes (profissional e paciente). Nosso servidor a guarda apenas
  // para entregar a ambos via HTTPS autenticado.
  const e2eeKey = crypto.randomBytes(32).toString("base64");

  const joinPayload = {
    token_type: "therapy_join",
    sessionId,
    therapistUid: uid,
    livekitRoom,
    patientNameHint: patientName,
    iat: Date.now(),
    exp: Date.now() + JOIN_TOKEN_VALIDITY_MS
  };
  const joinToken = signPayload(joinPayload, ACCESS_TOKEN_SECRET);

  const db = getDb();
  await db.collection("therapy_sessions").doc(sessionId).set({
    sessionId,
    therapistUid: uid,
    therapistDisplayName: therapist.displayName || "",
    patientName,
    patientId: patientId || null,
    livekitRoom,
    e2eeKey,
    scheduledAt,
    status: "scheduled",
    joinTokenExp: joinPayload.exp,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await logAudit({ type: "session_created", sessionId, therapistUid: uid });

  return res.json({
    ok: true,
    session: {
      sessionId,
      livekitRoom,
      patientName,
      scheduledAt,
      status: "scheduled",
      joinToken,
      joinTokenExp: joinPayload.exp
    }
  });
}));

// GET /therapy/sessoes — lista as sessões do profissional logado
router.get("/therapy/sessoes", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const db = getDb();
  // Sem orderBy server-side pra evitar exigência de composite index no
  // Firestore. Limit defensivo de 200; ordenação é feita client-side.
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
        joinTokenExp: data.joinTokenExp || null
      };
    })
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
// PACIENTES — CRUD cifrado client-side. Server vê só ciphertext + iv.
// O blob cifrado contém: { name, contact, observations, birthdate?, ... }
// ─────────────────────────────────────────────────────────────────────────

const PATIENT_CIPHERTEXT_MAX = 64 * 1024; // 64 KB cifrado por paciente

// POST /therapy/pacientes — cria paciente
router.post("/therapy/pacientes", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

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

  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 403, "PROFISSIONAL_NAO_REGISTRADO");

  const formCiphertext       = String(req.body?.formCiphertext || "").trim();
  const formIv               = String(req.body?.formIv || "").trim();
  const patientId            = String(req.body?.patientId || "").trim() || null;
  const patientNameSnapshot  = String(req.body?.patientNameSnapshot || "").trim().slice(0, PATIENT_NAME_MAX);
  const sessionId            = String(req.body?.sessionId || "").trim() || null;

  if (!formCiphertext || !formIv) return sendError(res, 400, "FORMULARIO_OBRIGATORIO");
  if (formCiphertext.length > RECEITA_FORM_CIPHERTEXT_MAX) return sendError(res, 413, "FORMULARIO_GRANDE_DEMAIS");
  if (!patientNameSnapshot)       return sendError(res, 400, "NOME_PACIENTE_OBRIGATORIO");

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

  const db = getDb();
  const ref = db.collection("therapy_receitas").doc(receitaId);
  const snap = await ref.get();
  if (!snap.exists) return sendError(res, 404, "RECEITA_NAO_ENCONTRADA");
  const r = snap.data();
  if (r.therapistUid !== uid) return sendError(res, 403, "ACESSO_NEGADO");
  if (r.status === "signed")  return sendError(res, 409, "RECEITA_JA_ASSINADA");

  await ref.set({
    formCiphertext, formIv,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

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

  // Reutiliza token pré-gerado se ainda válido. Senão fallback (PDF pode estar
  // sem QR ou com QR que não bate, mas a receita continua íntegra).
  let deliveryToken    = r.deliveryToken    || null;
  let deliveryTokenExp = r.deliveryTokenExp || null;
  if (!deliveryToken || !deliveryTokenExp || deliveryTokenExp < Date.now()) {
    const fresh = buildDeliveryToken(receitaId);
    deliveryToken    = fresh.token;
    deliveryTokenExp = fresh.exp;
  }

  await ref.set({
    status: "signed",
    signatureMethod,
    pdfSignedBase64: pdfBase64,
    pdfSignedMime: pdfMime,
    deliveryToken,
    deliveryTokenExp,
    signedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({
    type: "receita_signed",
    receitaId,
    therapistUid: uid,
    signatureMethod
  });

  return res.json({ ok: true, deliveryToken, deliveryTokenExp });
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

  return res.json({
    ok: true,
    receita: {
      receitaId: r.receitaId,
      patientNameSnapshot: r.patientNameSnapshot,
      pdfBase64: r.pdfSignedBase64,
      pdfMime: r.pdfSignedMime || "application/pdf",
      signedAt: r.signedAt?.toMillis ? r.signedAt.toMillis() : null,
      signatureMethod: r.signatureMethod || null,
      deliveryTokenExp: r.deliveryTokenExp || null,
      issuer
    }
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
  "receita_created", "receita_signed", "receita_deleted_draft", "receita_publica_access"
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
router.post("/therapy/profissional/plano/iniciar", asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const uid = await verifyFirebaseToken(req, res);
  if (!uid) return;

  const therapist = await loadTherapist(uid);
  if (!therapist) return sendError(res, 403, "PROFISSIONAL_NAO_REGISTRADO");

  // Pega e-mail do Firebase Auth (preapproval exige payer_email)
  let payerEmail = "";
  try {
    const fbUser = await admin.auth().getUser(uid);
    payerEmail = fbUser.email || "";
  } catch { /* ignore */ }
  if (!payerEmail) return sendError(res, 400, "EMAIL_INDISPONIVEL");

  const externalRef = `EP_THERAPY_${uid}`;

  const body = {
    reason: THERAPY_PLAN_NAME,
    auto_recurring: {
      frequency: 1,
      frequency_type: "months",
      transaction_amount: THERAPY_PLAN_AMOUNT,
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
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({
    type: "therapy_plano_iniciado",
    therapistUid: uid,
    preapprovalId: data.id
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

// GET /therapy/health — diagnóstico isolado
router.get("/therapy/health", (req, res) => {
  res.json({
    ok: true,
    livekitConfigured: !!(LIVEKIT_API_KEY && LIVEKIT_API_SECRET),
    livekitUrl: LIVEKIT_URL
  });
});

module.exports = router;
