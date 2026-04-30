const express = require("express");
const { logError, logInfo } = require("../logger");
const { asyncHandler, sendError } = require("../utils");
const { activeStreams } = require("../game/state");
const { normalizeRoomId } = require("../game/rooms");
const { startRoomStreaming, stopRoomStreaming, egressClient } = require("../video/webrtc");

const router = express.Router();

// POST /streaming/start
// body: { roomId, platforms: [{ name: "youtube"|"twitch"|"facebook"|"kick"|"tiktok"|"custom", streamKey }] }
router.post("/streaming/start", asyncHandler(async (req, res) => {
  const roomId    = normalizeRoomId(req.body?.roomId);
  const platforms = req.body?.platforms;

  if (!roomId)                            return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
  if (!Array.isArray(platforms) || !platforms.length) return sendError(res, 400, "PLATAFORMAS_OBRIGATORIAS");
  if (!egressClient)                      return sendError(res, 503, "EGRESS_NAO_CONFIGURADO");

  // Valida cada plataforma
  for (const p of platforms) {
    if (!p?.name)      return sendError(res, 400, "PLATAFORMA_SEM_NOME");
    if (!p?.streamKey) return sendError(res, 400, "STREAM_KEY_OBRIGATORIA");
  }

  try {
    const job = await startRoomStreaming(roomId, platforms);
    return res.json({
      ok: true,
      egressId:  job.egressId,
      platforms: job.platforms,
      startedAt: job.startedAt
    });
  } catch (err) {
    if (err.message === "STREAM_JA_ATIVO") return sendError(res, 409, "STREAM_JA_ATIVO");
    if (err.message?.startsWith("PLATAFORMA_NAO_SUPORTADA")) return sendError(res, 400, err.message);
    logError("streaming_start_error", err, { roomId });
    return sendError(res, 500, "ERRO_INICIAR_STREAMING");
  }
}));

// POST /streaming/stop
// body: { roomId }
router.post("/streaming/stop", asyncHandler(async (req, res) => {
  const roomId = normalizeRoomId(req.body?.roomId);
  if (!roomId) return sendError(res, 400, "ROOM_ID_OBRIGATORIO");
  if (!activeStreams.has(roomId)) return sendError(res, 404, "STREAM_NAO_ENCONTRADO");

  try {
    const job = await stopRoomStreaming(roomId);
    return res.json({ ok: true, durationMs: job ? (job.stoppedAt - job.startedAt) : 0 });
  } catch (err) {
    logError("streaming_stop_error", err, { roomId });
    return sendError(res, 500, "ERRO_PARAR_STREAMING");
  }
}));

// GET /streaming/status/:roomId
router.get("/streaming/status/:roomId", (req, res) => {
  try {
    const roomId = normalizeRoomId(req.params.roomId);
    const active = activeStreams.get(roomId);

    if (active) {
      return res.json({
        ok: true,
        active: true,
        egressId:  active.egressId,
        platforms: active.platforms,
        startedAt: active.startedAt,
        durationMs: Date.now() - active.startedAt
      });
    }
    return res.json({ ok: true, active: false });
  } catch (err) {
    logError("streaming_status_error", err);
    return sendError(res, 500, "ERRO_STATUS_STREAMING");
  }
});

module.exports = router;
