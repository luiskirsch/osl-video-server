// Limpeza periódica de Maps in-memory (vazamento lento se servidor rodar muito tempo)
const { logInfo, logWarn } = require("../logger");
const {
  panelRooms, activeRecordings, activeStreams,
  completedRecordings, pagamentosAprovados, pendingJoinRequests
} = require("../game/state");

// TTLs (em ms)
const STALE_STREAM_TTL_MS    = 6 * 60 * 60 * 1000;   // egress sem stop em 6h → assume crashado
const COMPLETED_TTL_MS       = 2 * 60 * 60 * 1000;   // gravações completas saem após 2h
const APPROVED_PAYMENT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // payments após 30d (memória)
const STALE_JOIN_REQUEST_TTL_MS = 10 * 60 * 1000;    // pedidos de join expiram em 10min

let cleanupTimer = null;

function pruneStaleEntries() {
  const now = Date.now();
  let pruned = 0;

  // Streams órfãos (sem /stop em 6h)
  for (const [roomId, job] of activeStreams.entries()) {
    if (now - (job.startedAt || 0) > STALE_STREAM_TTL_MS) {
      activeStreams.delete(roomId);
      pruned++;
      logWarn("stale_stream_pruned", { roomId, ageMs: now - job.startedAt });
    }
  }

  // Recordings órfãos
  for (const [roomId, job] of activeRecordings.entries()) {
    if (now - (job.startedAt || 0) > STALE_STREAM_TTL_MS) {
      activeRecordings.delete(roomId);
      pruned++;
      logWarn("stale_recording_pruned", { roomId, ageMs: now - job.startedAt });
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

function startCleanupLoop() {
  if (cleanupTimer) return;
  // Roda a cada 1h
  cleanupTimer = setInterval(pruneStaleEntries, 60 * 60 * 1000);
  cleanupTimer.unref();
  logInfo("cleanup_loop_started", { intervalMs: 60 * 60 * 1000 });
}

function stopCleanupLoop() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

module.exports = { startCleanupLoop, stopCleanupLoop, pruneStaleEntries };
