const { AccessToken, EgressClient } = require("livekit-server-sdk");
const { logInfo, logError } = require("../logger");
const { nowIso } = require("../utils");
const {
  LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL,
  S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET, S3_REGION, S3_ENDPOINT, S3_PUBLIC_URL,
  RECORDING_LAYOUT_URL
} = require("../config");
const {
  panelRooms, activeRecordings, completedRecordings,
  broadcastPanelUpdate
} = require("../game/state");

// --- Clientes LiveKit ---

const egressClient = (LIVEKIT_API_KEY && LIVEKIT_API_SECRET)
  ? new EgressClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
  : null;

// --- Configuração S3 ---

function recordingS3Config() {
  return {
    accessKey: S3_ACCESS_KEY,
    secret: S3_SECRET_KEY,
    region: S3_REGION,
    endpoint: S3_ENDPOINT || undefined,
    bucket: S3_BUCKET,
    forcePathStyle: !!S3_ENDPOINT
  };
}

function recordingDownloadUrl(filepath) {
  if (!S3_PUBLIC_URL) return null;
  const base = S3_PUBLIC_URL.replace(/\/$/, "");
  return `${base}/${filepath}`;
}

// --- Token LiveKit para WebRTC ---

async function generateLiveKitToken(room, user) {
  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    throw new Error("LIVEKIT_NAO_CONFIGURADO");
  }

  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: String(user),
    name: String(user)
  });

  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });

  return at.toJwt();
}

// --- Gravação / Egress ---

async function startRoomRecording(roomId, type, ref, email) {
  if (!egressClient)              throw new Error("EGRESS_CLIENT_NOT_CONFIGURED");
  if (!S3_ACCESS_KEY || !S3_BUCKET) throw new Error("S3_NOT_CONFIGURED");

  if (activeRecordings.has(roomId)) throw new Error("GRAVACAO_JA_ATIVA");

  const ts       = Date.now();
  const filepath = `recordings/${roomId}/${ts}-${type}.mp4`;
  const layoutUrl = `${RECORDING_LAYOUT_URL}?room=${encodeURIComponent(roomId)}`;

  const egress = await egressClient.startWebEgress(roomId, {
    url: layoutUrl,
    audioOnly: false,
    videoOnly: false,
    awaitStartSignal: false,
    videoWidth: 1080,
    videoHeight: 1920,
    fileOutputs: [{
      fileType: 1,
      filepath,
      s3: recordingS3Config()
    }]
  });

  const job = { egressId: egress.egressId, type, ref, email, startedAt: ts, filepath };
  activeRecordings.set(roomId, job);

  const room = panelRooms.get(roomId);
  if (room) { room.recordingActive = true; room.updatedAt = nowIso(); broadcastPanelUpdate(); }

  logInfo("recording_started", { roomId, egressId: egress.egressId, type });
  return job;
}

async function stopRoomRecording(roomId) {
  const job = activeRecordings.get(roomId);
  if (!job) return null;

  try {
    await egressClient.stopEgress(job.egressId);
  } catch (err) {
    logError("stop_egress_error", err, { roomId, egressId: job.egressId });
  }

  activeRecordings.delete(roomId);

  const downloadUrl = recordingDownloadUrl(job.filepath);
  const completed   = { ...job, downloadUrl, completedAt: Date.now() };
  completedRecordings.set(roomId, completed);

  // Buffer máximo de 100 gravações concluídas em memória
  if (completedRecordings.size > 100) {
    const oldest = completedRecordings.keys().next().value;
    completedRecordings.delete(oldest);
  }

  const room = panelRooms.get(roomId);
  if (room) { room.recordingActive = false; room.updatedAt = nowIso(); broadcastPanelUpdate(); }

  logInfo("recording_stopped", { roomId, egressId: job.egressId, type: job.type });
  return completed;
}

module.exports = {
  egressClient,
  recordingS3Config, recordingDownloadUrl,
  generateLiveKitToken,
  startRoomRecording, stopRoomRecording
};
