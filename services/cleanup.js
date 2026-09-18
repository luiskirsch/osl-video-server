// Limpeza periódica de Maps in-memory (vazamento lento se servidor rodar muito tempo)
const { logInfo, logWarn, logError } = require("../logger");
const {
  panelRooms, activeRecordings, activeStreams,
  completedRecordings, pagamentosAprovados, pendingJoinRequests
} = require("../game/state");
const { egressClient, stopRoomRecording, stopRoomStreaming } = require("../video/webrtc");

// TTLs (em ms)
const STALE_STREAM_TTL_MS    = 6 * 60 * 60 * 1000;   // egress sem stop em 6h → assume crashado
const COMPLETED_TTL_MS       = 2 * 60 * 60 * 1000;   // gravações completas saem após 2h
const APPROVED_PAYMENT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // payments após 30d (memória)
const STALE_JOIN_REQUEST_TTL_MS = 10 * 60 * 1000;    // pedidos de join expiram em 10min

// #B3: poll periódico da LiveKit pra identificar egresses ativos no provider
// que não estão nos Maps locais (cliente crashou sem /stop, restart do
// Railway, etc). Para evitar gastar minutos pagos sem o servidor saber.
const ORPHAN_POLL_INTERVAL_MS = 15 * 60 * 1000; // 15min

let cleanupTimer = null;
let orphanTimer  = null;
let orphanStartupTimer = null;

async function pruneStaleEntries() {
  const now = Date.now();
  let pruned = 0;

  // Streams órfãos (sem /stop em 6h)
  for (const [roomId, job] of activeStreams.entries()) {
    if (now - (job.startedAt || 0) > STALE_STREAM_TTL_MS) {
      const stopped = await stopRoomStreaming(roomId);
      if (stopped?.egressStopOk) {
        pruned++;
        logWarn("stale_stream_stopped", { roomId, ageMs: now - job.startedAt });
      } else {
        logWarn("stale_stream_stop_pending", { roomId, ageMs: now - job.startedAt });
      }
    }
  }

  // Recordings órfãos
  for (const [roomId, job] of activeRecordings.entries()) {
    if (now - (job.startedAt || 0) > STALE_STREAM_TTL_MS) {
      const stopped = await stopRoomRecording(roomId);
      if (stopped?.egressStopOk) {
        pruned++;
        logWarn("stale_recording_stopped", { roomId, ageMs: now - job.startedAt });
      } else {
        logWarn("stale_recording_stop_pending", { roomId, ageMs: now - job.startedAt });
      }
    }
  }

  // Recordings completas antigas
  for (const [roomId, job] of completedRecordings.entries()) {
    if (now - (job.completedAt || 0) > COMPLETED_TTL_MS) {
      completedRecordings.delete(roomId);
      pruned++;
    }
  }

  // Pagamentos aprovados antigos (30d) — eles permanecem no Firestore;
  // o Map só serve pra polling rápido durante checkout
  for (const [ref, p] of pagamentosAprovados.entries()) {
    if (now - (p.updatedAt || 0) > APPROVED_PAYMENT_TTL_MS) {
      pagamentosAprovados.delete(ref);
      pruned++;
    }
  }

  // Join requests antigas
  for (const [key, req] of pendingJoinRequests.entries()) {
    const requestedAt = new Date(req.requestedAt || 0).getTime();
    if (now - requestedAt > STALE_JOIN_REQUEST_TTL_MS) {
      pendingJoinRequests.delete(key);
      pruned++;
    }
  }

  if (pruned > 0) {
    logInfo("cleanup_pruned", {
      pruned,
      activeStreams: activeStreams.size,
      activeRecordings: activeRecordings.size,
      completedRecordings: completedRecordings.size,
      pagamentosAprovados: pagamentosAprovados.size,
      pendingJoinRequests: pendingJoinRequests.size,
      panelRooms: panelRooms.size
    });
  }
}

// #B3: lista egresses ativos na LiveKit Cloud e cruza com Maps locais.
// Egresses que não conhecemos → stopEgress (eram órfãos). Se LiveKit falhar
// (rede/credenciais), apenas loga e segue — nunca derruba o cleanup loop.
async function pollLiveKitOrphans() {
  if (!egressClient) return;
  try {
    const list = await egressClient.listEgress({ active: true });
    if (!Array.isArray(list)) return;

    // Compare pelo egressId. Comparar só roomName deixava um segundo egress
    // órfão escapar sempre que houvesse outro job legítimo na mesma sala.
    const knownEgressIds = new Set([
      ...[...activeStreams.values()].map(job => job?.egressId).filter(Boolean),
      ...[...activeRecordings.values()].map(job => job?.egressId).filter(Boolean),
    ]);
    let orphansFound = 0, orphansStopped = 0, orphansFailed = 0;

    for (const e of list) {
      const roomName = e?.roomName || e?.request?.roomName || null;
      const egressId = e?.egressId || null;
      if (!egressId) continue;
      if (knownEgressIds.has(egressId)) continue; // tracked, ok

      orphansFound++;
      try {
        await egressClient.stopEgress(egressId);
        orphansStopped++;
        logWarn("orphan_egress_stopped", { egressId, roomName });
      } catch (err) {
        orphansFailed++;
        logError("orphan_egress_stop_failed", err, { egressId, roomName });
      }
    }

    if (orphansFound > 0) {
      logInfo("livekit_orphan_poll", { orphansFound, orphansStopped, orphansFailed, knownEgresses: knownEgressIds.size });
    }
  } catch (err) {
    logError("livekit_orphan_poll_error", err);
  }
}

function startCleanupLoop() {
  if (cleanupTimer) return;
  // Roda a cada 1h
  cleanupTimer = setInterval(() => {
    pruneStaleEntries().catch(e => logError("cleanup_prune_unhandled", e));
  }, 60 * 60 * 1000);
  cleanupTimer.unref();
  logInfo("cleanup_loop_started", { intervalMs: 60 * 60 * 1000 });

  // Orphan poll a cada 15min — só se egressClient configurado.
  if (egressClient && !orphanTimer) {
    // Primeiro poll após 2min do startup (evita corrida com LiveKit init).
    orphanStartupTimer = setTimeout(() => {
      orphanStartupTimer = null;
      pollLiveKitOrphans().catch(e => logError("orphan_poll_unhandled", e));
      orphanTimer = setInterval(() => {
        pollLiveKitOrphans().catch(e => logError("orphan_poll_unhandled", e));
      }, ORPHAN_POLL_INTERVAL_MS);
      orphanTimer.unref();
    }, 2 * 60 * 1000);
    orphanStartupTimer.unref?.();
    logInfo("orphan_poll_loop_started", { intervalMs: ORPHAN_POLL_INTERVAL_MS });
  }
}

function stopCleanupLoop() {
  if (orphanStartupTimer) {
    clearTimeout(orphanStartupTimer);
    orphanStartupTimer = null;
  }
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  if (orphanTimer) {
    clearInterval(orphanTimer);
    orphanTimer = null;
  }
}

module.exports = { startCleanupLoop, stopCleanupLoop, pruneStaleEntries, pollLiveKitOrphans };
