"use strict";
// Exclusão automática das gravações de sessão (services/sessionRecording.js):
//   • ninguém comprou → ~1h após o fim da partida;
//   • anfitrião recusou → em minutos;
//   • comprou → 7 dias.
//
// Roda a cada 15 minutos:
//   1. registros com prazo vencido → apaga o arquivo e o registro (nunca o de
//      uma gravação ainda em andamento);
//   2. varredura do prefixo recordings/ → apaga arquivos mais velhos que o
//      prazo máximo que ficaram sem registro (ex.: falha ao gravar no Firestore).
// Reserva: regra de ciclo de vida do R2 no prefixo recordings/ (8 dias).

const { logInfo, logError } = require("../logger");
const { COLLECTION, MAX_RETENTION_MS, UNPURCHASED_GRACE_MS } = require("../services/sessionRecording");

const BATCH_SIZE = 200;
const PREFIX = "recordings/";
const ORPHAN_AGE_MS = MAX_RETENTION_MS + UNPURCHASED_GRACE_MS;

async function runSessionRecordingCleanup({
  db = require("../services/firestore").getDb(),
  s3 = require("../video/webrtc").recordingS3Client(),
  bucket = require("../config").S3_BUCKET,
  now = Date.now(),
} = {}) {
  const result = { registros: 0, arquivos: 0 };
  if (!s3 || !bucket) return result;
  const { DeleteObjectsCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
  const removeKeys = async keys => {
    for (let i = 0; i < keys.length; i += 1000) {
      const response = await s3.send(new DeleteObjectsCommand({
        Bucket: bucket, Delete: { Objects: keys.slice(i, i + 1000).map(Key => ({ Key })), Quiet: true },
      }));
      if (response.Errors?.length) throw new Error("R2_EXCLUSAO_PARCIAL");
    }
  };
  // O egress também grava um manifesto <egressId>.json ao lado do vídeo.
  const keysFor = data => {
    const keys = [];
    if (typeof data.filepath === "string" && data.filepath.startsWith(PREFIX)) {
      keys.push(data.filepath);
      if (data.egressId) keys.push(data.filepath.replace(/[^/]+$/, `${data.egressId}.json`));
    }
    return keys;
  };

  try {
    if (db) {
      let cursorMs = 0;
      while (true) {
        const snap = await db.collection(COLLECTION).where("expiresAtMs", "<", now).limit(BATCH_SIZE).get();
        const due = snap.docs.filter(d => d.data().status !== "recording" && (d.data().expiresAtMs || 0) >= cursorMs);
        if (!due.length) break;
        const keys = due.flatMap(d => keysFor(d.data()));
        if (keys.length) await removeKeys(keys);
        const batch = db.batch();
        due.forEach(d => batch.delete(d.ref));
        await batch.commit();
        result.registros += due.length;
        result.arquivos += keys.length;
        if (snap.docs.length < BATCH_SIZE) break;
        cursorMs = Math.max(...due.map(d => d.data().expiresAtMs || 0));
      }
    }

    const cutoff = now - ORPHAN_AGE_MS;
    let token;
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIX, ContinuationToken: token }));
      const stale = (page.Contents || [])
        .filter(o => o.Key && o.LastModified && new Date(o.LastModified).getTime() < cutoff)
        .map(o => o.Key);
      if (stale.length) { await removeKeys(stale); result.arquivos += stale.length; }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);

    if (result.registros || result.arquivos) {
      logInfo("session_recording_cleanup", { ...result, ranAt: new Date(now).toISOString() });
    }
  } catch (error) {
    logError("session_recording_cleanup_error", error);
  }
  return result;
}

const INTERVAL_MS = 15 * 60 * 1000;
let timer = null;

function scheduleSessionRecordingCleanup() {
  if (timer) return;
  timer = setTimeout(() => {
    runSessionRecordingCleanup();
    timer = setInterval(runSessionRecordingCleanup, INTERVAL_MS);
    timer.unref?.();
  }, 2 * 60 * 1000);
  timer.unref?.();
}

module.exports = { runSessionRecordingCleanup, scheduleSessionRecordingCleanup };
