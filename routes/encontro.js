const express    = require("express");
const admin      = require("firebase-admin");
const { asyncHandler, sendError } = require("../utils");
const { requireAdmin } = require("../services/auth");
const { logError } = require("../logger");
const { ensureDb } = require("../services/firestore");
const {
  createEvent, listEvents, getEvent, deleteEvent,
  verifyTicket, checkinParticipant,
  startEvent, forceEndEvent,
  voteInterest, getMyMatches,
  getActiveEventMemoryStatus, getAdminEventDetails,
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
  if (!ensureDb(res)) return;
  const title       = String(req.body?.title       || "").trim();
  const scheduledAt = Number(req.body?.scheduledAt || 0);
  if (!scheduledAt || scheduledAt < Date.now()) return sendError(res, 400, "DATA_INVALIDA");

  try {
    const event = await createEvent(title || null, scheduledAt);
    return res.json({ ok: true, event });
  } catch (err) {
    logError("encontro_create_error", err);
    return sendError(res, 500, "ERRO_CRIAR_EVENTO", { detail: err.message });
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
  try {
    await startEvent(eventId);
    return res.json({ ok: true, message: "Evento iniciado" });
  } catch (err) {
    const known = ["EVENTO_NAO_ENCONTRADO","PARTICIPANTES_INSUFICIENTES"];
    if (known.includes(err.message)) return sendError(res, 400, err.message);
    logError("encontro_start_error", err, { eventId });
    return sendError(res, 500, "ERRO_INICIAR_EVENTO", { detail: err.message });
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
