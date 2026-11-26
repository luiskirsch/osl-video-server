"use strict";
// Gravação da sessão do jogo para o "Salvar Sessão" do O SextoLugar.
//
// Modelo combinado com o dono (2026-11-17):
//   • a sessão do jogo é gravada do início (/game/session/start) ao fim
//     (/game/session/end ou fechamento da sala) — só para que o anfitrião
//     possa comprar o vídeo no fim. Lobby e vídeo fora da sessão não gravam;
//   • ninguém comprou → o arquivo é apagado ~1h após o fim da partida (folga
//     para o pagamento confirmar);
//   • o anfitrião recusou ("Sair sem salvar") → apagado em minutos;
//   • comprou → link de download por 7 dias; depois o arquivo é apagado.
// Não existe acervo "de segurança": segurança fica com denúncia/bloqueio e os
// registros de acesso (6 meses, audit_logs). Os jogadores são informados nos
// Termos (termos.html), aceitos ao entrar na sala.
//
// A exclusão é feita por jobs/sessionRecordingCleanup.js (a cada 15 min), com
// a regra de ciclo de vida do R2 (prefixo recordings/, 8 dias) como reserva.
//
// O mapa activeRecordings vive só na memória. Este registro no Firestore
// (session_recordings/{egressId}) guarda o prazo de cada arquivo, permite
// anexar uma compra feita depois do fim da partida e retomar as gravações em
// andamento após um deploy (senão a ronda de egress órfão as encerraria).

const { logInfo, logWarn, logError } = require("../logger");

const COLLECTION = "session_recordings";
const MINUTE = 60 * 1000;
const UNPURCHASED_GRACE_MS = 60 * MINUTE;               // ninguém comprou
const DECLINED_GRACE_MS = 10 * MINUTE;                  // anfitrião recusou (só espera o upload)
const PURCHASED_RETENTION_MS = 7 * 24 * 60 * MINUTE;    // comprou: 7 dias de download
const MAX_RETENTION_MS = PURCHASED_RETENTION_MS;        // teto enquanto ainda grava
const PENDING_TYPE = "pendente";
const PURCHASED_TYPES = new Set(["gravacao-download", "gravacao-mensal"]);

const isPurchased = type => PURCHASED_TYPES.has(type);

function retentionAfterStop(job) {
  if (isPurchased(job?.type)) return PURCHASED_RETENTION_MS;
  return job?.declined ? DECLINED_GRACE_MS : UNPURCHASED_GRACE_MS;
}

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
    sessionId: job.sessionId || null,
    filepath: job.filepath,
    type: job.type || null,
    status: "recording",
    startedAtMs: job.startedAt,
    stoppedAtMs: null,
    expiresAtMs: job.startedAt + MAX_RETENTION_MS,
  }).catch(error => logError("session_recording_register_error", error, { roomId }));
}

function recordStopped(job, { now = Date.now() } = {}) {
  const db = getDb();
  if (!db || !job?.egressId) return Promise.resolve();
  return db.collection(COLLECTION).doc(job.egressId).set({
    status: "stopped",
    type: job.type || null,
    stoppedAtMs: now,
    ...(isPurchased(job.type) && job.ref ? { purchasedRef: job.ref } : {}),
    expiresAtMs: now + retentionAfterStop(job),
  }, { merge: true }).catch(error => logError("session_recording_update_error", error, { egressId: job.egressId }));
}

async function listForRoom(roomId, { limit = 50, sessionId = null, transaction = null } = {}) {
  const db = getDb();
  if (!db) return [];
  // Igualdade em roomId sem orderBy: não exige índice composto; ordena aqui.
  let query = db.collection(COLLECTION).where("roomId", "==", roomId);
  if (sessionId) query = query.where("sessionId", "==", sessionId);
  query = query.limit(limit);
  const snap = transaction ? await transaction.get(query) : await query.get();
  return snap.docs
    .map(doc => ({ ref: doc.ref, ...doc.data() }))
    .sort((a, b) => (b.startedAtMs || 0) - (a.startedAtMs || 0));
}

// Compra confirmada depois do fim da partida: anexa à gravação mais recente da
// sala que ainda não expirou e estende o prazo para 7 dias. Idempotente para a
// mesma referência de pagamento.
async function attachPurchase(roomId, { ref, sessionId = null, now = Date.now() } = {}) {
  const db = getDb();
  if (!db) return null;
  return db.runTransaction(async transaction => {
    const items = await listForRoom(roomId, { sessionId, transaction });
    const target = items.find(r =>
      r.status !== "recording" && (r.expiresAtMs || 0) > now &&
      (!isPurchased(r.type) || (ref && r.purchasedRef === ref)));
    if (!target) return null;
    if (isPurchased(target.type) && target.purchasedRef === ref) return target;
    const update = { type: "gravacao-download", purchasedRef: ref || null, purchasedAtMs: now, expiresAtMs: now + PURCHASED_RETENTION_MS };
    transaction.update(target.ref, update);
    return { ...target, ...update };
  });
}

// "Sair sem salvar" depois que a partida já terminou: apaga em minutos.
async function expireLatestUnpurchased(roomId, { now = Date.now(), sessionId = null } = {}) {
  const db = getDb();
  if (!db) return null;
  return db.runTransaction(async transaction => {
    const items = await listForRoom(roomId, { sessionId, transaction });
    const target = items.find(r => r.status !== "recording" && !isPurchased(r.type) && (r.expiresAtMs || 0) > now);
    if (!target) return null;
    const expiresAtMs = Math.min(target.expiresAtMs, now + DECLINED_GRACE_MS);
    transaction.update(target.ref, { expiresAtMs, declinedAtMs: now });
    return { ...target, expiresAtMs };
  });
}

// Após um reinício: devolve ao mapa as gravações cujo egress segue ativo e
// marca as demais como interrompidas (o arquivo até ali foi salvo) com o
// prazo de quem não comprou.
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
          egressId: data.egressId, sessionId: data.sessionId || null, type: data.type || PENDING_TYPE, ref: null, email: null,
          startedAt: data.startedAtMs || now, filepath: data.filepath,
        });
        restored++;
      }
    } else {
      await doc.ref.set({ status: "interrupted", stoppedAtMs: now, expiresAtMs: now + retentionAfterStop(data) }, { merge: true });
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

// Garante que a sessão está sendo gravada. Nunca lança: falha de gravação não
// pode derrubar a partida; fica registrada no log.
async function ensureSessionRecording(roomId, reason = "session") {
  const { activeRecordings } = require("../game/state");
  if (activeRecordings.has(roomId)) return activeRecordings.get(roomId);
  const { egressClient, startRoomRecording } = require("../video/webrtc");
  if (!egressClient || !storageConfigured()) {
    logWarn("session_recording_unavailable", { roomId, reason, egress: !!egressClient, storage: storageConfigured() });
    return null;
  }
  try {
    const db = getDb();
    const room = db && await db.collection("salas").doc(roomId).get();
    const sessionId = room?.data()?.currentSessionId || null;
    if (!require("../game/state").panelRooms.get(roomId)?.sessionActive) return null;
    return await startRoomRecording(roomId, PENDING_TYPE, null, null, sessionId);
  } catch (error) {
    if (error?.message === "GRAVACAO_JA_ATIVA") return activeRecordings.get(roomId) || null;
    logError("session_recording_start_error", error, { roomId, reason });
    return null;
  }
}

// Encerra a gravação no fim da sessão do jogo (o vídeo pode seguir no lobby).
async function endSessionRecording(roomId) {
  const { activeRecordings, panelRooms } = require("../game/state");
  if (!activeRecordings.has(roomId)) return null;
  const room = panelRooms.get(roomId);
  if (room && room.sessionActive) return null;
  try {
    const { stopRoomRecording } = require("../video/webrtc");
    return await stopRoomRecording(roomId);
  } catch (error) {
    logError("session_recording_stop_error", error, { roomId });
    return null;
  }
}

module.exports = {
  COLLECTION, PENDING_TYPE, UNPURCHASED_GRACE_MS, DECLINED_GRACE_MS, PURCHASED_RETENTION_MS, MAX_RETENTION_MS,
  isPurchased, retentionAfterStop,
  recordStarted, recordStopped, listForRoom, attachPurchase, expireLatestUnpurchased, rehydrate,
  ensureSessionRecording, endSessionRecording, storageConfigured,
};
