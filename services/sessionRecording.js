"use strict";
// Gravação de segurança das sessões do O SextoLugar.
//
// Decisão do produto (2026-11-17): toda sala é gravada enquanto há sessão ou
// vídeo ativo, independentemente de compra. O vídeo fica no bucket PRIVADO de
// gravações por 30 dias e então é apagado — pela regra de ciclo de vida do R2
// (prefixo recordings/) e, por garantia, por jobs/sessionRecordingCleanup.js.
// Os participantes veem o aviso de gravação na sala (sala.html).
//
// O mapa activeRecordings vive só na memória. Este registro no Firestore
// (session_recordings/{egressId}) é o que permite localizar uma gravação dias
// depois e retomar o controle das que estavam em andamento após um deploy —
// sem ele, a ronda de egress órfão (services/cleanup.js) encerraria a
// gravação de uma sessão que continua.

const { logInfo, logWarn, logError } = require("../logger");

const COLLECTION = "session_recordings";
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SECURITY_TYPE = "seguranca";

function getDb() {
  try { return require("./firestore").getDb(); } catch { return null; }
}

// --- Registro durável ------------------------------------------------------

function recordStarted(roomId, job) {
  const db = getDb();
  if (!db || !job?.egressId) return Promise.resolve();
  return db.collection(COLLECTION).doc(job.egressId).set({
    roomId,
    egressId: job.egressId,
    filepath: job.filepath,
    type: job.type || null,
    status: "recording",
    startedAtMs: job.startedAt,
    stoppedAtMs: null,
    expiresAtMs: job.startedAt + RETENTION_MS,
  }).catch(error => logError("session_recording_register_error", error, { roomId }));
}

function recordStopped(job, status = "stopped") {
  const db = getDb();
  if (!db || !job?.egressId) return Promise.resolve();
  return db.collection(COLLECTION).doc(job.egressId).set({
    status,
    type: job.type || null,
    stoppedAtMs: Date.now(),
  }, { merge: true }).catch(error => logError("session_recording_update_error", error, { egressId: job.egressId }));
}

async function listForRoom(roomId, { limit = 50 } = {}) {
  const db = getDb();
  if (!db) return [];
  // Igualdade em roomId sem orderBy: não exige índice composto; ordena aqui.
  const snap = await db.collection(COLLECTION).where("roomId", "==", roomId).limit(limit).get();
  return snap.docs.map(doc => doc.data()).sort((a, b) => (b.startedAtMs || 0) - (a.startedAtMs || 0));
}

// Após um reinício: devolve ao mapa as gravações cujo egress segue ativo e
// marca as demais como interrompidas (o arquivo até ali foi salvo).
async function rehydrate({ egressClient, activeRecordings, now = Date.now() } = {}) {
  const db = getDb();
  if (!db || !egressClient) return { restored: 0, finished: 0 };
  const snap = await db.collection(COLLECTION).where("status", "==", "recording").limit(200).get();
  if (snap.empty) return { restored: 0, finished: 0 };
  const active = new Set((await egressClient.listEgress({ active: true }) || []).map(e => e?.egressId).filter(Boolean));
  let restored = 0, finished = 0;
  for (const doc of snap.docs) {
    const data = doc.data();
    if (active.has(data.egressId) && data.roomId) {
      if (!activeRecordings.has(data.roomId)) {
        activeRecordings.set(data.roomId, {
          egressId: data.egressId, type: data.type || SECURITY_TYPE, ref: null, email: null,
          startedAt: data.startedAtMs || now, filepath: data.filepath,
        });
        restored++;
      }
    } else {
      await doc.ref.set({ status: "interrupted", stoppedAtMs: now }, { merge: true });
      finished++;
    }
  }
  logInfo("session_recordings_rehydrated", { restored, finished });
  return { restored, finished };
}

// --- Política ---------------------------------------------------------------

function storageConfigured() {
  const { S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET } = require("../config");
  return !!(S3_ACCESS_KEY && S3_SECRET_KEY && S3_BUCKET);
}

// Garante que a sala está sendo gravada. Nunca lança: falha de gravação não
// pode derrubar a sessão; fica registrada no log para alerta.
async function ensureSessionRecording(roomId, reason = "session") {
  const { activeRecordings } = require("../game/state");
  if (activeRecordings.has(roomId)) return activeRecordings.get(roomId);
  const { egressClient, startRoomRecording } = require("../video/webrtc");
  if (!egressClient || !storageConfigured()) {
    logWarn("session_recording_unavailable", { roomId, reason, egress: !!egressClient, storage: storageConfigured() });
    return null;
  }
  try {
    return await startRoomRecording(roomId, SECURITY_TYPE, null, null);
  } catch (error) {
    if (error?.message === "GRAVACAO_JA_ATIVA") return activeRecordings.get(roomId) || null;
    logError("session_recording_start_error", error, { roomId, reason });
    return null;
  }
}

// Reabre a gravação só se a sala ainda tem sessão ou vídeo (ex.: depois que
// a compra de "Salvar Sessão" fechou o arquivo do comprador).
async function ensureSessionRecordingIfActive(roomId, reason) {
  const { panelRooms } = require("../game/state");
  const room = panelRooms.get(roomId);
  if (!room || !(room.sessionActive || room.videoActive)) return null;
  return ensureSessionRecording(roomId, reason);
}

// Encerra a gravação quando a sala não tem mais sessão nem vídeo.
async function endSessionRecordingIfIdle(roomId) {
  const { activeRecordings, panelRooms } = require("../game/state");
  if (!activeRecordings.has(roomId)) return null;
  const room = panelRooms.get(roomId);
  if (room && (room.sessionActive || room.videoActive)) return null;
  try {
    const { stopRoomRecording } = require("../video/webrtc");
    return await stopRoomRecording(roomId);
  } catch (error) {
    logError("session_recording_stop_error", error, { roomId });
    return null;
  }
}

module.exports = {
  COLLECTION, RETENTION_MS, SECURITY_TYPE,
  recordStarted, recordStopped, listForRoom, rehydrate,
  ensureSessionRecording, ensureSessionRecordingIfActive, endSessionRecordingIfIdle, storageConfigured,
};
