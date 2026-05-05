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
const { verifyFirebaseToken, signPayload, verifySignedToken } = require("../services/auth");
const {
  LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL, ACCESS_TOKEN_SECRET
} = require("../config");

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

  const finalName = patientName || session.patientName || payload.patientNameHint || "Paciente";
  const identity = `pat_${crypto.randomBytes(6).toString("hex")}`;

  const livekitToken = await issueLivekitToken({
    room: session.livekitRoom,
    identity,
    name: finalName,
    ttlMs: SESSION_TOKEN_VALIDITY_MS
  });

  await db.collection("therapy_sessions").doc(payload.sessionId).set({
    patientJoinedAt: admin.firestore.FieldValue.serverTimestamp(),
    patientNameFinal: finalName,
    patientConsentLgpdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await logAudit({
    type: "patient_joined",
    sessionId: payload.sessionId,
    patientName: finalName,
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
    sessionId: payload.sessionId
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

// GET /therapy/health — diagnóstico isolado
router.get("/therapy/health", (req, res) => {
  res.json({
    ok: true,
    livekitConfigured: !!(LIVEKIT_API_KEY && LIVEKIT_API_SECRET),
    livekitUrl: LIVEKIT_URL
  });
});

module.exports = router;
