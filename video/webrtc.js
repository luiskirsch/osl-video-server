const { AccessToken, EgressClient } = require("livekit-server-sdk");
const { logInfo, logError } = require("../logger");
const { nowIso } = require("../utils");
const {
  LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL,
  S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET, S3_REGION, S3_ENDPOINT, S3_PUBLIC_URL,
  RECORDING_LAYOUT_URL
} = require("../config");
const {
  panelRooms, activeRecordings, completedRecordings, activeStreams,
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

  // SDK v2: primeiro arg é a URL. Antes passávamos roomId aqui — a SDK aceitava
  // silenciosamente, mas o egress browser tentava carregar "SL-XXXX" como URL
  // e renderizava em branco (causava o "layout bugado" do recording).
  const egress = await egressClient.startWebEgress(
    layoutUrl,
    {
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
    }
  );

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

// --- Live streaming via RTMP ---

// Security #3: validação estrita de stream keys/URLs
// Plataformas conhecidas usam só [A-Za-z0-9_-.~] (cobre todas as chaves reais).
// Custom/TikTok aceita URL RTMP completa, validada via URL parser.
const PLATFORM_KEY_REGEX = /^[A-Za-z0-9_\-.~]+$/;
const KEY_MIN_LEN = 5;
const KEY_MAX_LEN = 200;
const CUSTOM_URL_MAX_LEN = 500;

function validatePlatformKey(value) {
  const v = String(value || "").trim();
  if (!v) throw new Error("STREAM_KEY_VAZIA");
  if (v.length < KEY_MIN_LEN || v.length > KEY_MAX_LEN) throw new Error("STREAM_KEY_TAMANHO_INVALIDO");
  if (!PLATFORM_KEY_REGEX.test(v)) throw new Error("STREAM_KEY_CARACTERES_INVALIDOS");
  return v;
}

function validateCustomRtmpUrl(value) {
  const v = String(value || "").trim();
  if (!v) throw new Error("STREAM_KEY_VAZIA");
  if (v.length > CUSTOM_URL_MAX_LEN) throw new Error("STREAM_KEY_MUITO_LONGA");
  // Bloqueia caracteres que poderiam injetar uma segunda URL ou quebrar o parse
  if (/[\r\n\t\0\x00-\x1F'"`<>\\]/.test(v)) throw new Error("STREAM_KEY_CARACTERES_INVALIDOS");
  let url;
  try { url = new URL(v); } catch { throw new Error("STREAM_KEY_URL_INVALIDA"); }
  if (url.protocol !== "rtmp:" && url.protocol !== "rtmps:") {
    throw new Error("STREAM_KEY_PROTOCOLO_INVALIDO");
  }
  return v;
}

function buildRtmpUrl(platform, streamKey) {
  const p = String(platform || "").trim().toLowerCase();

  if (p === "custom" || p === "tiktok") {
    // TikTok requer URL completa fornecida pela TikTok Live Studio (já é RTMP)
    return validateCustomRtmpUrl(streamKey);
  }

  const key = validatePlatformKey(streamKey);
  switch (p) {
    case "youtube":  return `rtmp://a.rtmp.youtube.com/live2/${key}`;
    case "twitch":   return `rtmp://live.twitch.tv/app/${key}`;
    case "facebook": return `rtmps://live-api-s.facebook.com:443/rtmp/${key}`;
    case "kick":     return `rtmps://fa723fc1b171.global-contribute.live-video.net/app/${key}`;
    default: throw new Error(`PLATAFORMA_NAO_SUPORTADA:${p}`);
  }
}

// Mapeia layoutId do frontend → layout built-in do LiveKit (room composite)
// "cards" não está aqui porque usa Web Egress com URL custom (recording-layout.html)
const LIVEKIT_BUILTIN_LAYOUTS = {
  "pov-host": "single-speaker",
  "grid":     "grid"
};

async function startRoomStreaming(roomId, platforms, layoutId = "cards") {
  if (!egressClient)              throw new Error("EGRESS_CLIENT_NOT_CONFIGURED");
  if (activeStreams.has(roomId))  throw new Error("STREAM_JA_ATIVO");
  if (!Array.isArray(platforms) || platforms.length === 0) {
    throw new Error("PLATAFORMAS_OBRIGATORIAS");
  }

  const urls = platforms.map(p => buildRtmpUrl(p.name, p.streamKey));
  const streamOutput = { stream: { protocol: 1, urls } };

  const layout = String(layoutId || "cards").trim();
  let egress;

  if (layout === "cards") {
    // Web Egress com layout HTML custom (recording-layout.html)
    const layoutUrl = `${RECORDING_LAYOUT_URL}?room=${encodeURIComponent(roomId)}`;
    egress = await egressClient.startWebEgress(layoutUrl, streamOutput);
  } else if (LIVEKIT_BUILTIN_LAYOUTS[layout]) {
    // Room Composite Egress com layout built-in LiveKit (single-speaker, grid)
    egress = await egressClient.startRoomCompositeEgress(
      roomId,
      streamOutput,
      { layout: LIVEKIT_BUILTIN_LAYOUTS[layout] }
    );
  } else {
    throw new Error(`LAYOUT_NAO_SUPORTADO:${layout}`);
  }

  const job = {
    egressId:  egress.egressId,
    platforms: platforms.map(p => ({ name: p.name })), // não persiste streamKey
    layout,
    urlCount:  urls.length,
    startedAt: Date.now()
  };
  activeStreams.set(roomId, job);

  const room = panelRooms.get(roomId);
  if (room) { room.streamingActive = true; room.updatedAt = nowIso(); broadcastPanelUpdate(); }

  logInfo("streaming_started", { roomId, egressId: egress.egressId, platforms: job.platforms, layout });
  return job;
}

async function stopRoomStreaming(roomId) {
  const job = activeStreams.get(roomId);
  if (!job) return null;

  try {
    await egressClient.stopEgress(job.egressId);
  } catch (err) {
    logError("stop_streaming_egress_error", err, { roomId, egressId: job.egressId });
  }

  activeStreams.delete(roomId);

  const room = panelRooms.get(roomId);
  if (room) { room.streamingActive = false; room.updatedAt = nowIso(); broadcastPanelUpdate(); }

  logInfo("streaming_stopped", { roomId, egressId: job.egressId, durationMs: Date.now() - job.startedAt });
  return { ...job, stoppedAt: Date.now() };
}

module.exports = {
  egressClient,
  recordingS3Config, recordingDownloadUrl,
  generateLiveKitToken,
  startRoomRecording, stopRoomRecording,
  startRoomStreaming, stopRoomStreaming, buildRtmpUrl
};
