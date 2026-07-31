const express    = require("express");
const admin      = require("firebase-admin");
const { asyncHandler, sendError } = require("../utils");
const { requireAdmin } = require("../services/auth");
const { logError } = require("../logger");
const { ensureDb, getDb } = require("../services/firestore");
const {
  createEvent, listEvents, getEvent, deleteEvent,
  verifyTicket, checkinParticipant,
  startEvent, forceEndEvent, resetCheckins,
  voteInterest, getMyMatches,
  getActiveEventMemoryStatus, getAdminEventDetails,
  getAllMyMatches,
  saveProfilePhoto, getProfilePhoto,
  saveUserPhoto, getUserPhoto,
  makeChatId, checkMutualMatch, getChatMessages,
} = require("../services/encontroService");

const router = express.Router();

// Middleware: verifica Firebase ID Token
async function requireFirebaseToken(req, res, next) {
  const auth  = String(req.headers["authorization"] || "").trim();
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return sendError(res, 401, "AUTH_REQUIRED");
  try {
    const decoded  = await admin.auth().verifyIdToken(token);
    req.firebaseUid   = decoded.uid;
    req.firebaseEmail = (decoded.email || "").toLowerCase();
    next();
  } catch {
    return sendError(res, 401, "AUTH_INVALID");
  }
}

// ─── Rotas públicas ───────────────────────────────────────────────────────────

// GET /encontro/eventos — lista eventos (máx 20, desc)
router.get("/encontro/eventos", asyncHandler(async (req, res) => {
  const events = await listEvents();
  return res.json({ ok: true, events });
}));

// GET /encontro/eventos/:id — detalhes de um evento
router.get("/encontro/eventos/:id", asyncHandler(async (req, res) => {
  const event = await getEvent(String(req.params.id || "").trim());
  if (!event) return sendError(res, 404, "EVENTO_NAO_ENCONTRADO");
  return res.json({ ok: true, event });
}));

// GET /encontro/status/:id — status em memória do evento ativo
router.get("/encontro/status/:id", (req, res) => {
  const eventId = String(req.params.id || "").trim();
  const status  = getActiveEventMemoryStatus(eventId);
  return res.json({ ok: true, active: !!status, status: status || null });
});

// GET /encontro/meu-ingresso — verifica se o usuário logado tem ingresso
router.get("/encontro/meu-ingresso", requireFirebaseToken, asyncHandler(async (req, res) => {
  const eventId = String(req.query.eventId || "").trim();
  if (!eventId) return sendError(res, 400, "EVENT_ID_OBRIGATORIO");
  const hasTicket = await verifyTicket(eventId, req.firebaseEmail);
  return res.json({ ok: true, hasTicket, email: req.firebaseEmail });
}));

// GET /encontro/meu-checkin — verifica se o usuário ainda tem check-in ativo (Firestore)
router.get("/encontro/meu-checkin", requireFirebaseToken, asyncHandler(async (req, res) => {
  const eventId = String(req.query.eventId || "").trim();
  if (!eventId) return sendError(res, 400, "EVENT_ID_OBRIGATORIO");
  const db = getDb();
  if (!db) return res.json({ ok: true, checkedIn: false });
  const doc = await db.collection("encontro_checkins").doc(`${eventId}_${req.firebaseUid}`).get();
  return res.json({ ok: true, checkedIn: doc.exists });
}));

// POST /encontro/checkin — check-in do participante
router.post("/encontro/checkin", requireFirebaseToken, asyncHandler(async (req, res) => {
  const eventId = String(req.body?.eventId || "").trim();
  const name    = String(req.body?.name    || "").trim().slice(0, 40);
  const gender  = String(req.body?.gender  || "").trim().toUpperCase();

  if (!eventId)               return sendError(res, 400, "EVENT_ID_OBRIGATORIO");
  if (!name)                  return sendError(res, 400, "NOME_OBRIGATORIO");
  if (!["M","F"].includes(gender)) return sendError(res, 400, "GENERO_INVALIDO");

  try {
    const result = await checkinParticipant(eventId, req.firebaseUid, req.firebaseEmail, name, gender);
    return res.json({ ok: true, ...result });
  } catch (err) {
    const known = ["INGRESSO_NAO_ENCONTRADO","EVENTO_NAO_ENCONTRADO","EVENTO_NAO_DISPONIVEL"];
    if (known.includes(err.message)) return sendError(res, 400, err.message);
    logError("encontro_checkin_error", err, { eventId, uid: req.firebaseUid });
    return sendError(res, 500, "ERRO_CHECKIN");
  }
}));

// POST /encontro/match — votar interesse
router.post("/encontro/match", requireFirebaseToken, asyncHandler(async (req, res) => {
  const eventId   = String(req.body?.eventId   || "").trim();
  const targetUid = String(req.body?.targetUid || "").trim();
  const liked     = req.body?.liked === true || req.body?.liked === "true";

  if (!eventId || !targetUid) return sendError(res, 400, "PARAMETROS_INVALIDOS");
  if (targetUid === req.firebaseUid) return sendError(res, 400, "VOTO_PROPRIO_NAO_PERMITIDO");

  const result = await voteInterest(eventId, req.firebaseUid, targetUid, liked);
  return res.json({ ok: true, ...result });
}));

// GET /encontro/matches — busca matches mútuos do usuário
router.get("/encontro/matches", requireFirebaseToken, asyncHandler(async (req, res) => {
  const eventId = String(req.query.eventId || "").trim();
  if (!eventId) return sendError(res, 400, "EVENT_ID_OBRIGATORIO");
  const matches = await getMyMatches(eventId, req.firebaseUid);
  return res.json({ ok: true, matches });
}));

// POST /encontro/perfil/foto — salva foto de perfil permanente do usuário
router.post("/encontro/perfil/foto", requireFirebaseToken, asyncHandler(async (req, res) => {
  const photo = String(req.body?.photo || "").trim();
  if (!photo) return sendError(res, 400, "PARAMETROS_INVALIDOS");
  if (!photo.startsWith("data:image/")) return sendError(res, 400, "FORMATO_INVALIDO");
  try {
    await saveProfilePhoto(req.firebaseUid, photo);
    return res.json({ ok: true });
  } catch (err) {
    if (err.message === "FOTO_MUITO_GRANDE") return sendError(res, 400, "FOTO_MUITO_GRANDE");
    return sendError(res, 500, "ERRO_SALVAR_FOTO");
  }
}));

// GET /encontro/perfil/foto — busca foto de perfil de qualquer usuário
router.get("/encontro/perfil/foto", requireFirebaseToken, asyncHandler(async (req, res) => {
  const uid = String(req.query.uid || req.firebaseUid || "").trim();
  if (!uid) return sendError(res, 400, "PARAMETROS_INVALIDOS");
  const photo = await getProfilePhoto(uid);
  return res.json({ ok: true, photo: photo || null });
}));

// GET /encontro/meus-matches — todos os matches do usuário em todos os eventos
router.get("/encontro/meus-matches", requireFirebaseToken, asyncHandler(async (req, res) => {
  const matches = await getAllMyMatches(req.firebaseUid);
  return res.json({ ok: true, matches });
}));

// POST /encontro/foto — salva foto do participante (thumbnail JPEG base64)
router.post("/encontro/foto", requireFirebaseToken, asyncHandler(async (req, res) => {
  const eventId = String(req.body?.eventId || "").trim();
  const photo   = String(req.body?.photo   || "").trim();
  if (!eventId || !photo) return sendError(res, 400, "PARAMETROS_INVALIDOS");
  if (!photo.startsWith("data:image/")) return sendError(res, 400, "FORMATO_INVALIDO");
  try {
    await saveUserPhoto(eventId, req.firebaseUid, photo);
    return res.json({ ok: true });
  } catch (err) {
    if (err.message === "FOTO_MUITO_GRANDE") return sendError(res, 400, "FOTO_MUITO_GRANDE");
    return sendError(res, 500, "ERRO_SALVAR_FOTO");
  }
}));

// GET /encontro/foto — busca foto de um participante
router.get("/encontro/foto", requireFirebaseToken, asyncHandler(async (req, res) => {
  const eventId = String(req.query.eventId || "").trim();
  const uid     = String(req.query.uid     || "").trim();
  if (!eventId || !uid) return sendError(res, 400, "PARAMETROS_INVALIDOS");
  const photo = await getUserPhoto(eventId, uid);
  return res.json({ ok: true, photo: photo || null });
}));

// GET /encontro/chat — histórico de mensagens entre dois matches
router.get("/encontro/chat", requireFirebaseToken, asyncHandler(async (req, res) => {
  const eventId      = String(req.query.eventId      || "").trim();
  const recipientUid = String(req.query.recipientUid || "").trim();
  if (!eventId || !recipientUid) return sendError(res, 400, "PARAMETROS_INVALIDOS");
  const isOk = await checkMutualMatch(eventId, req.firebaseUid, recipientUid);
  if (!isOk) return sendError(res, 403, "SEM_MATCH");
  const chatId = makeChatId(eventId, req.firebaseUid, recipientUid);
  const msgs   = await getChatMessages(chatId);
  return res.json({ ok: true, chatId, msgs });
}));

// ─── Rotas admin ──────────────────────────────────────────────────────────────

// GET /encontro/admin/eventos — lista com detalhes admin
router.get("/encontro/admin/eventos", requireAdmin, asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  try {
    const events = await listEvents();
    return res.json({ ok: true, events });
  } catch (err) {
    logError("encontro_list_error", err);
    return sendError(res, 500, "ERRO_LISTAR_EVENTOS", { detail: err.message });
  }
}));

// POST /encontro/admin/eventos — criar evento
router.post("/encontro/admin/eventos", requireAdmin, asyncHandler(async (req, res) => {
  console.log("[ENCONTRO] POST /encontro/admin/eventos body=", JSON.stringify(req.body));
  if (!ensureDb(res)) return;
  const title       = String(req.body?.title       || "").trim();
  const scheduledAt = Number(req.body?.scheduledAt || 0);
  console.log("[ENCONTRO] title=", title, "scheduledAt=", scheduledAt, "now=", Date.now());
  if (!scheduledAt || scheduledAt < Date.now()) return sendError(res, 400, "DATA_INVALIDA");

  try {
    const event = await createEvent(title || null, scheduledAt);
    console.log("[ENCONTRO] event created:", event.eventId);
    return res.json({ ok: true, event });
  } catch (err) {
    console.error("[ENCONTRO] createEvent failed:", err.message, err.stack);
    logError("encontro_create_error", err);
    return sendError(res, 500, "ERRO_CRIAR_EVENTO", { detail: err.message });
  }
}));

// PUT /encontro/admin/eventos/:id — editar titulo e/ou data
router.put("/encontro/admin/eventos/:id", requireAdmin, asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const eventId    = String(req.params.id || "").trim();
  const title      = req.body?.title      ? String(req.body.title).trim()  : null;
  const scheduledAt = req.body?.scheduledAt ? Number(req.body.scheduledAt) : null;
  if (scheduledAt !== null && isNaN(scheduledAt)) return sendError(res, 400, "DATA_INVALIDA");
  try {
    const db = getDb();
    const updates = {};
    if (title)       updates.title       = title;
    if (scheduledAt) updates.scheduledAt = scheduledAt;
    if (!Object.keys(updates).length) return sendError(res, 400, "NADA_PARA_ATUALIZAR");
    await db.collection("encontro_eventos").doc(eventId).update(updates);
    return res.json({ ok: true });
  } catch (err) {
    logError("encontro_edit_error", err);
    return sendError(res, 500, "ERRO_EDITAR_EVENTO", { detail: err.message });
  }
}));

// DELETE /encontro/admin/eventos/:id — excluir evento
router.delete("/encontro/admin/eventos/:id", requireAdmin, asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const eventId = String(req.params.id || "").trim();
  try {
    await deleteEvent(eventId);
    return res.json({ ok: true });
  } catch (err) {
    logError("encontro_delete_error", err);
    return sendError(res, 500, "ERRO_EXCLUIR_EVENTO", { detail: err.message });
  }
}));

// GET /encontro/admin/eventos/:id — detalhes admin (ingressos + check-ins)
router.get("/encontro/admin/eventos/:id", requireAdmin, asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const eventId = String(req.params.id || "").trim();
  try {
    const details = await getAdminEventDetails(eventId);
    if (!details) return sendError(res, 404, "EVENTO_NAO_ENCONTRADO");
    return res.json({ ok: true, event: details });
  } catch (err) {
    logError("encontro_details_error", err);
    return sendError(res, 500, "ERRO_DETALHES_EVENTO", { detail: err.message });
  }
}));

// POST /encontro/admin/eventos/:id/iniciar — iniciar evento
router.post("/encontro/admin/eventos/:id/iniciar", requireAdmin, asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const eventId = String(req.params.id || "").trim();
  const force   = req.body?.force === true || req.query.force === "true";
  try {
    await startEvent(eventId, force);
    return res.json({ ok: true, message: "Evento iniciado" });
  } catch (err) {
    const known = ["EVENTO_NAO_ENCONTRADO","PARTICIPANTES_INSUFICIENTES"];
    if (known.includes(err.message)) return sendError(res, 400, err.message);
    logError("encontro_start_error", err, { eventId });
    return sendError(res, 500, "ERRO_INICIAR_EVENTO", { detail: err.message });
  }
}));

// POST /encontro/admin/eventos/:id/abrir-sala — avança scheduledAt para agora (teste)
router.post("/encontro/admin/eventos/:id/abrir-sala", requireAdmin, asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const eventId = String(req.params.id || "").trim();
  try {
    const db = getDb();
    await db.collection("encontro_eventos").doc(eventId).update({ scheduledAt: Date.now() - 5000, status: "waiting" });
    return res.json({ ok: true });
  } catch (err) {
    return sendError(res, 500, "ERRO_ABRIR_SALA", { detail: err.message });
  }
}));

// POST /encontro/admin/eventos/:id/dar-ingresso — ingresso manual (teste/cortesia)
router.post("/encontro/admin/eventos/:id/dar-ingresso", requireAdmin, asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const eventId = String(req.params.id || "").trim();
  const email   = String(req.body?.email || "").trim().toLowerCase();
  if (!email) return sendError(res, 400, "EMAIL_OBRIGATORIO");
  try {
    const db = getDb();
    const ticketId = `${eventId}_${email}`;
    await db.collection("encontro_tickets").doc(ticketId).set({
      email, eventId, paymentRef: "admin_manual", paymentId: "admin_manual",
      approvedAt: Date.now()
    }, { merge: true });
    return res.json({ ok: true, ticketId, email, eventId });
  } catch (err) {
    return sendError(res, 500, "ERRO_DAR_INGRESSO", { detail: err.message });
  }
}));

// POST /encontro/admin/eventos/:id/resetar-checkins — limpa check-ins (testes)
router.post("/encontro/admin/eventos/:id/resetar-checkins", requireAdmin, asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const eventId = String(req.params.id || "").trim();
  try {
    await resetCheckins(eventId);
    return res.json({ ok: true });
  } catch (err) {
    return sendError(res, 500, "ERRO_RESETAR_CHECKINS", { detail: err.message });
  }
}));

// POST /encontro/admin/eventos/:id/encerrar — encerrar evento manualmente
router.post("/encontro/admin/eventos/:id/encerrar", requireAdmin, asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;
  const eventId = String(req.params.id || "").trim();
  try {
    await forceEndEvent(eventId);
    return res.json({ ok: true, message: "Evento encerrado" });
  } catch (err) {
    logError("encontro_end_error", err);
    return sendError(res, 500, "ERRO_ENCERRAR_EVENTO", { detail: err.message });
  }
}));

module.exports = router;
