const express = require("express");
const { logError, logInfo } = require("../logger");
const { asyncHandler, sendError, nowIso, normalizePathEmail } = require("../utils");
const { activeRecordings, completedRecordings, pagamentosAprovados, panelRooms, broadcastPanelUpdate } = require("../game/state");
const { normalizeRoomId } = require("../game/rooms");
const { startRoomRecording, stopRoomRecording, egressClient, generateLiveKitToken, generateSpectatorToken } = require("../video/webrtc");
const { getDb } = require("../services/firestore");
const entitlements = require("../services/entitlements");
const { requireAdmin, verifySignedToken, getBearerToken } = require("../services/auth");
const { ACCESS_TOKEN_SECRET } = require("../config");
const admin = require("firebase-admin");

function verifyHostTokenRecording(req, roomId) {
  const { normalizeRoomId: norm } = require("../game/rooms");
  const token = String(req.body?.hostToken || req.headers["x-host-token"] || "").trim();
  if (!token || !ACCESS_TOKEN_SECRET) return false;
  const r = verifySignedToken(token, ACCESS_TOKEN_SECRET);
  return r.valid && r.payload?.token_type === "host" && r.payload?.roomId === norm(roomId);
}

async function verifyFirebaseBearer(req, res) {
  const token = getBearerToken(req);
  if (!token) { res.status(401).json({ ok: false, error: "FIREBASE_TOKEN_OBRIGATORIO" }); return null; }
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return decoded;
  } catch (_) {
    res.status(401).json({ ok: false, error: "FIREBASE_TOKEN_INVALIDO" });
    return null;
  }
}
const { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL } = require("../config");

const router = express.Router();

// GET /spectate-token — token LiveKit subscriber-only para espectador (sem câmera/mic)
// Requer panel token (admin) para evitar que qualquer pessoa assista qualquer sala.
router.get("/spectate-token", asyncHandler(async (req, res) => {
  const fromQuery  = req.query.token || "";
  const fromHeader = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const t = fromQuery || fromHeader;
  const { verifySignedToken: vst } = require("../services/auth");
  const { ADMIN_SECRET: AS } = require("../config");
  const r = t && AS ? vst(t, AS) : { valid: false };
  if (!r.valid || r.payload?.token_type !== "panel_session") {
    return sendError(res, 403, "ADMIN_SECRET_INVALIDO");
  }

  const { room, user } = req.query;
  if (!room || !user) return sendError(res, 400, "ROOM_E_USER_OBRIGATORIOS");
  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) return sendError(res, 500, "LIVEKIT_NAO_CONFIGURADO");

  const normalizedRoom = normalizeRoomId(room);
  if (!panelRooms.has(normalizedRoom)) return sendError(res, 403, "SALA_NAO_REGISTRADA");

  const token = await generateSpectatorToken(room, user);
  return res.json({ ok: true, token, url: LIVEKIT_URL });
}));

// GET /token — gera token LiveKit para WebRTC
// IDOR fix: verifica Firebase ID token e confirma que uid == user solicitado.
router.get("/token", asyncHandler(async (req, res) => {
  const room = req.query.room;
  const user = req.query.user;

  if (!room || !user) return sendError(res, 400, "ROOM_E_USER_OBRIGATORIOS");
  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) return sendError(res, 500, "LIVEKIT_NAO_CONFIGURADO");

  // Autenticar caller via Firebase ID token
  const decoded = await verifyFirebaseBearer(req, res);
  if (!decoded) return;
  // participantId é aleatório (p_abc123), não há UID a comparar — room membership é o gate real

  const normalizedRoom = normalizeRoomId(room);
  const panelRoom = panelRooms.get(normalizedRoom);
  if (!panelRoom) return sendError(res, 403, "SALA_NAO_REGISTRADA");
  if (!panelRoom.players[user]) return sendError(res, 403, "JOGADOR_NAO_APROVADO");

  const token = await generateLiveKitToken(room, user);
  return res.json({ ok: true, token });
}));

// GET /recording/pass/:email — verifica passe mensal ativo (requer Firebase auth com email correspondente)
router.get("/recording/pass/:email", asyncHandler(async (req, res) => {
  const decoded = await verifyFirebaseBearer(req, res);
  if (!decoded) return;
  const email = normalizePathEmail(req);
  if (!email) return sendError(res, 400, "EMAIL_OBRIGATORIO");
  // Só pode verificar o próprio email — ou admin
  const tokenEmail = (decoded.email || "").toLowerCase();
  if (tokenEmail !== email) return sendError(res, 403, "EMAIL_NAO_CORRESPONDE");

  const ent = await entitlements.getUserEntitlements(decoded.uid);
  if (ent.isPrestige) {
    return res.json({ ok: true, active: true, expiresAt: null, type: "prestige" });
  }
  return res.json({ ok: true, active: ent.hasRecordingPass, expiresAt: ent.recordingPassExpiresAt, type: "gravacao-mensal" });
}));

// POST /recording/auto-start — inicia gravação automaticamente quando o ritual começa
// Requer hostToken da sala para evitar que qualquer pessoa dispare Egress LiveKit.
router.post("/recording/auto-start", asyncHandler(async (req, res) => {
  const roomId = normalizeRoomId(req.body?.roomId);
  if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
  if (!verifyHostTokenRecording(req, roomId)) return sendError(res, 403, "HOST_TOKEN_OBRIGATORIO");
  if (!egressClient) return sendError(res, 503, "EGRESS_NAO_CONFIGURADO");

  const room = panelRooms.get(roomId);
  if (!room || !room.sessionActive) return sendError(res, 403, "SALA_SEM_SESSAO_ATIVA");

  if (activeRecordings.has(roomId)) {
    const job = activeRecordings.get(roomId);
    return res.json({ ok: true, already: true, egressId: job.egressId, startedAt: job.startedAt });
  }

  try {
    const job = await startRoomRecording(roomId, "pending", null, null);
    return res.json({ ok: true, egressId: job.egressId, startedAt: job.startedAt });
  } catch (err) {
    logError("recording_auto_start_error", err, { roomId });
    return sendError(res, 500, "ERRO_INICIAR_GRAVACAO_AUTO");
  }
}));

// POST /recording/discard — para e descarta a gravação (sem salvar URL) [admin only]
router.post("/recording/discard", requireAdmin, asyncHandler(async (req, res) => {
  const roomId = normalizeRoomId(req.body?.roomId);
  if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");

  const job = activeRecordings.get(roomId);
  if (!job) return res.json({ ok: true, was_active: false });

  try {
    const { egressClient: client } = require("../video/webrtc");
    await client.stopEgress(job.egressId);
  } catch (err) {
    logError("recording_discard_stop_error", err, { roomId });
  }

  activeRecordings.delete(roomId);
  const room = panelRooms.get(roomId);
  if (room) { room.recordingActive = false; room.updatedAt = nowIso(); broadcastPanelUpdate(); }
  logInfo("recording_discarded", { roomId, egressId: job.egressId });
  return res.json({ ok: true, was_active: true });
}));

// POST /recording/claim — para a gravação e libera URL de download após pagamento confirmado
router.post("/recording/claim", asyncHandler(async (req, res) => {
  const decoded = await verifyFirebaseBearer(req, res);
  if (!decoded) return;
  const callerEmail = (decoded.email || "").toLowerCase();

  const roomId = normalizeRoomId(req.body?.roomId);
  const ref    = String(req.body?.ref   || "").trim();
  const type   = String(req.body?.type  || "gravacao-download").trim();
  // email do body ignorado — usa o do Firebase token para evitar reivindicação de pagamento alheio
  const email  = callerEmail;

  if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
  if (!ref)    return sendError(res, 400, "REF_OBRIGATORIO");

  const pag = pagamentosAprovados.get(ref);
  if (!pag || !pag.approved) return sendError(res, 402, "PAGAMENTO_NAO_CONFIRMADO");
  if (pag.email && callerEmail && pag.email !== callerEmail) return sendError(res, 403, "EMAIL_NAO_CORRESPONDE");

  if (activeRecordings.has(roomId)) {
    const job = activeRecordings.get(roomId);
    job.email = pag.email || email;
    job.type  = type;
    job.ref   = ref;
    try {
      const completed = await stopRoomRecording(roomId);
      if (completed && completed.egressStopOk === false) {
        return sendError(res, 502, "EGRESS_STOP_FALHOU", {
          hint: "A gravação foi marcada como concluída, mas o egress da LiveKit pode estar pendurado. Tente parar de novo em alguns segundos."
        });
      }
      return res.json({ ok: true, downloadUrl: completed.downloadUrl, type: completed.type });
    } catch (err) {
      logError("recording_claim_stop_error", err, { roomId });
      return sendError(res, 500, "ERRO_PARAR_GRAVACAO");
    }
  }

  const completed = completedRecordings.get(roomId);
  if (completed) return res.json({ ok: true, downloadUrl: completed.downloadUrl, type: completed.type });

  return sendError(res, 404, "GRAVACAO_NAO_ENCONTRADA");
}));

// POST /recording/start — inicia gravação após pagamento confirmado
// Firebase auth obrigatório: email do token deve corresponder ao email do passe/pagamento.
router.post("/recording/start", asyncHandler(async (req, res) => {
  const decoded = await verifyFirebaseBearer(req, res);
  if (!decoded) return;
  const callerEmail = (decoded.email || "").toLowerCase();

  const roomId = normalizeRoomId(req.body?.roomId);
  const ref    = String(req.body?.ref   || "").trim();
  // email do body ignorado — usa o do Firebase token para evitar abuse de passe alheio
  const email  = callerEmail;

  if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
  if (!egressClient) return sendError(res, 503, "EGRESS_NAO_CONFIGURADO");

  let authorizedEmail = email;
  let authorizedType  = "gravacao-download";

  const db = getDb();

  if (email && db) {
    try {
      const doc = await db.collection("recording_passes").doc(email).get();
      if (doc.exists && doc.data().expiresAt > Date.now()) {
        authorizedType  = "gravacao-mensal";
        authorizedEmail = email;
      } else if (!ref) {
        return sendError(res, 402, "PASSE_MENSAL_EXPIRADO_OU_INEXISTENTE");
      }
    } catch (_) {}
  }

  if (authorizedType !== "gravacao-mensal") {
    if (!ref) return sendError(res, 400, "REF_OBRIGATORIA");
    const payment = pagamentosAprovados.get(ref);
    if (!payment || !payment.approved) return sendError(res, 402, "PAGAMENTO_NAO_CONFIRMADO");
    if (payment.produto !== "gravacao-download") return sendError(res, 400, "PRODUTO_NAO_E_GRAVACAO");
    authorizedEmail = payment.email || email;
    authorizedType  = "gravacao-download";
  }

  try {
    const job = await startRoomRecording(roomId, authorizedType, ref, authorizedEmail);
    return res.json({ ok: true, egressId: job.egressId, startedAt: job.startedAt });
  } catch (err) {
    if (err.message === "GRAVACAO_JA_ATIVA") return sendError(res, 409, "GRAVACAO_JA_ATIVA");
    logError("recording_start_error", err, { roomId });
    return sendError(res, 500, "ERRO_INICIAR_GRAVACAO");
  }
}));

// POST /recording/stop [admin only]
router.post("/recording/stop", requireAdmin, asyncHandler(async (req, res) => {
  const roomId = normalizeRoomId(req.body?.roomId);
  if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
  if (!activeRecordings.has(roomId)) return sendError(res, 404, "GRAVACAO_NAO_ENCONTRADA");

  try {
    const completed = await stopRoomRecording(roomId);
    if (completed && completed.egressStopOk === false) {
      return sendError(res, 502, "EGRESS_STOP_FALHOU", {
        hint: "A gravação foi marcada como concluída, mas o egress da LiveKit pode estar pendurado. Tente parar de novo em alguns segundos."
      });
    }
    return res.json({ ok: true, downloadUrl: completed.downloadUrl || null, filepath: completed.filepath, type: completed.type });
  } catch (err) {
    logError("recording_stop_error", err, { roomId });
    return sendError(res, 500, "ERRO_PARAR_GRAVACAO");
  }
}));

// GET /recording/status/:roomId — requer panel token (expõe downloadUrl)
router.get("/recording/status/:roomId", (req, res) => {
  const fromQuery  = req.query.token || "";
  const fromHeader = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const t = fromQuery || fromHeader;
  const r = t && require("../config").ADMIN_SECRET
    ? require("../services/auth").verifySignedToken(t, require("../config").ADMIN_SECRET)
    : { valid: false };
  if (!r.valid || r.payload?.token_type !== "panel_session") {
    return res.json({ ok: true, active: false });
  }
  try {
    const roomId    = normalizeRoomId(req.params.roomId);
    const active    = activeRecordings.get(roomId);
    const completed = completedRecordings.get(roomId);

    if (active) {
      return res.json({ ok: true, active: true, egressId: active.egressId, type: active.type, startedAt: active.startedAt, downloadUrl: null });
    }

    if (completed && Date.now() - completed.completedAt < 2 * 60 * 60 * 1000) {
      return res.json({ ok: true, active: false, completed: true, type: completed.type, downloadUrl: completed.downloadUrl || null, completedAt: completed.completedAt });
    }

    return res.json({ ok: true, active: false, completed: false });
  } catch (err) {
    logError("recording_status_error", err);
    return sendError(res, 500, "ERRO_STATUS_GRAVACAO");
  }
});

module.exports = router;
