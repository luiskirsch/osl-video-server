"use strict";
// Exclusão automática das gravações de segurança após 30 dias.
//
// A regra de ciclo de vida do bucket (R2, prefixo recordings/) já apaga os
// arquivos; este job é a garantia do lado do servidor e o que limpa o
// registro session_recordings no Firestore:
//   1. registros vencidos → apaga o arquivo e o registro;
//   2. varredura do prefixo recordings/ → apaga arquivos com mais de 30 dias
//      que ficaram sem registro (ex.: falha ao gravar no Firestore).

const { logInfo, logError } = require("../logger");
const { COLLECTION, RETENTION_MS } = require("../services/sessionRecording");

const BATCH_SIZE = 200;
const PREFIX = "recordings/";

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
      await s3.send(new DeleteObjectsCommand({
        Bucket: bucket, Delete: { Objects: keys.slice(i, i + 1000).map(Key => ({ Key })), Quiet: true },
      }));
    }
  };

  try {
    if (db) {
      while (true) {
        const snap = await db.collection(COLLECTION).where("expiresAtMs", "<", now).limit(BATCH_SIZE).get();
        if (snap.empty) break;
        const keys = snap.docs.map(d => d.data().filepath).filter(k => typeof k === "string" && k.startsWith(PREFIX));
        if (keys.length) await removeKeys(keys);
        const batch = db.batch();
        snap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
        result.registros += snap.docs.length;
        result.arquivos += keys.length;
        if (snap.docs.length < BATCH_SIZE) break;
      }
    }

    const cutoff = now - RETENTION_MS;
    let token;
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIX, ContinuationToken: token }));
      const stale = (page.Contents || [])
        .filter(o => o.Key && o.LastModified && new Date(o.LastModified).getTime() < cutoff)
        .map(o => o.Key);
      if (stale.length) { await removeKeys(stale); result.arquivos += stale.length; }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);

    logInfo("session_recording_cleanup", { ...result, ranAt: new Date(now).toISOString() });
  } catch (error) {
    logError("session_recording_cleanup_error", error);
  }
  return result;
}

const MS_24H = 24 * 60 * 60 * 1000;
let timer = null;

function scheduleSessionRecordingCleanup() {
  if (timer) return;
  timer = setTimeout(() => {
    runSessionRecordingCleanup();
    timer = setInterval(runSessionRecordingCleanup, MS_24H);
    timer.unref?.();
  }, 2 * 60 * 1000);
  timer.unref?.();
}

module.exports = { runSessionRecordingCleanup, scheduleSessionRecordingCleanup };
