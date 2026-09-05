const { RoomServiceClient, DataPacket_Kind } = require("livekit-server-sdk");

const { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL } = require("../config");
const { logWarn } = require("../logger");
const { withRetry, isTransientError } = require("./retry");

const roomServiceClient = (LIVEKIT_API_KEY && LIVEKIT_API_SECRET)
  ? new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { requestTimeout: 10 })
  : null;

function isMissingRoomError(error) {
  return error?.status === 404
    || String(error?.code || "").toLowerCase() === "not_found";
}

async function endTherapyRoom({ roomName, sessionId, client = roomServiceClient }) {
  const room = String(roomName || "").trim();
  if (!room) throw new Error("LIVEKIT_ROOM_INVALIDA");
  if (!client) throw new Error("LIVEKIT_NAO_CONFIGURADO");

  // A mensagem permite que o paciente mostre a tela de encerramento sem
  // esperar o sinal de desconexão. deleteRoom continua sendo a garantia
  // autoritativa: ele remove todos os participantes da sala.
  try {
    const payload = Buffer.from(JSON.stringify({
      t: "therapy:session-ended",
      sessionId: String(sessionId || "")
    }));
    await client.sendData(room, payload, DataPacket_Kind.RELIABLE, { topic: "therapy" });
  } catch (error) {
    if (isMissingRoomError(error)) return { alreadyClosed: true };
    logWarn("therapy_room_end_announcement_failed", {
      room,
      sessionId,
      error: error?.message || String(error)
    });
  }

  try {
    await withRetry(() => client.deleteRoom(room), {
      maxAttempts: 2,
      baseDelayMs: 150,
      shouldRetry: isTransientError,
      onRetry: (error, attempt) => logWarn("therapy_room_delete_retry", {
        room,
        sessionId,
        attempt,
        error: error?.message || String(error)
      })
    });
    return { alreadyClosed: false };
  } catch (error) {
    if (isMissingRoomError(error)) return { alreadyClosed: true };
    throw error;
  }
}

module.exports = { endTherapyRoom, isMissingRoomError };
