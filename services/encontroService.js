const crypto = require("crypto");
const { getIo } = require("./socketio");
const { generateLiveKitToken } = require("../video/webrtc");
const { getDb } = require("./firestore");
const { logInfo, logError } = require("../logger");

const ROUND_DURATION_MS = 4 * 60 * 1000;  // 4 min
const WARN_BEFORE_MS    = 30 * 1000;       // aviso 30s antes
const TRANSITION_MS     = 15 * 1000;       // intervalo entre rodadas

// Estado em memória do evento ativo (apenas 1 por vez)
let activeEvent = null;

function generateEventId() {
  return crypto.randomBytes(4).toString("hex");
}

// Algoritmo clássico de speed dating:
// homens ficam fixos, mulheres rotacionam por roundIndex
function computePairsForRound(participants, roundIndex, forceMode = false) {
  if (forceMode) {
    // Modo teste: pareia sequencialmente ignorando gênero
    const all = [...participants.values()];
    const pairs = [];
    for (let i = 0; i + 1 < all.length; i += 2) {
      pairs.push({
        uid1: all[i].uid,     name1: all[i].name,
        uid2: all[i+1].uid,   name2: all[i+1].name,
      });
    }
    return pairs;
  }
  const men   = [...participants.values()].filter(p => p.gender === "M");
  const women = [...participants.values()].filter(p => p.gender === "F");
  const n     = Math.min(men.length, women.length);
  const pairs = [];
  for (let i = 0; i < n; i++) {
    pairs.push({
      uid1:  men[i].uid,
      name1: men[i].name,
      uid2:  women[(i + roundIndex) % women.length].uid,
      name2: women[(i + roundIndex) % women.length].name,
    });
  }
  return pairs;
}

function clearTimers() {
  if (!activeEvent) return;
  if (activeEvent.roundTimer)      clearTimeout(activeEvent.roundTimer);
  if (activeEvent.warnTimer)       clearTimeout(activeEvent.warnTimer);
  if (activeEvent.transitionTimer) clearTimeout(activeEvent.transitionTimer);
  activeEvent.roundTimer = activeEvent.warnTimer = activeEvent.transitionTimer = null;
}

function broadcastToEvent(eventName, payload) {
  if (!activeEvent) return;
  const io = getIo();
  if (!io) return;
  for (const uid of activeEvent.participants.keys()) {
    io.to(uid).emit(eventName, payload);
  }
}

// ─── Eventos (CRUD Firestore) ────────────────────────────────────────────────

async function createEvent(title, scheduledAt) {
  const db = getDb();
  if (!db) throw new Error("DB_NAO_DISPONIVEL");

  const eventId = generateEventId();
  const months = ["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"];
  const d = new Date(scheduledAt);
  const defaultTitle = `Encontro Marcado — ${String(d.getDate()).padStart(2,"0")} de ${months[d.getMonth()]}`;
  const event   = {
    eventId,
    title: title || defaultTitle,
    scheduledAt,
    status: "upcoming",
    createdAt: Date.now(),
  };
  await db.collection("encontro_eventos").doc(eventId).set(event);
  logInfo("encontro_event_created", { eventId, scheduledAt });
  return event;
}

async function listEvents() {
  const db = getDb();
  if (!db) return [];
  const snap = await db.collection("encontro_eventos")
    .orderBy("scheduledAt", "desc")
    .limit(20)
    .get();
  return snap.docs.map(d => d.data());
}

async function getEvent(eventId) {
  const db = getDb();
  if (!db) return null;
  const doc = await db.collection("encontro_eventos").doc(eventId).get();
  return doc.exists ? doc.data() : null;
}

async function deleteEvent(eventId) {
  const db = getDb();
  if (!db) throw new Error("DB_NAO_DISPONIVEL");
  if (activeEvent?.eventId === eventId) {
    clearTimers();
    activeEvent = null;
  }
  await db.collection("encontro_eventos").doc(eventId).delete();
}

// ─── Ingresso ────────────────────────────────────────────────────────────────

async function verifyTicket(eventId, email) {
  const db = getDb();
  if (!db) return false;
  const doc = await db.collection("encontro_tickets")
    .doc(`${eventId}_${email.toLowerCase()}`)
    .get();
  return doc.exists;
}

// ─── Check-in ────────────────────────────────────────────────────────────────

async function loadCheckins(db, eventId) {
  if (!db) return new Map();
  const snap = await db.collection("encontro_checkins")
    .where("eventId", "==", eventId)
    .get();
  const map = new Map();
  for (const doc of snap.docs) {
    const d = doc.data();
    map.set(d.uid, { uid: d.uid, name: d.name, email: d.email, gender: d.gender });
  }
  return map;
}

async function checkinParticipant(eventId, uid, email, name, gender) {
  const hasTicket = await verifyTicket(eventId, email);
  if (!hasTicket) throw new Error("INGRESSO_NAO_ENCONTRADO");

  const event = await getEvent(eventId);
  if (!event) throw new Error("EVENTO_NAO_ENCONTRADO");
  if (!["upcoming", "waiting", "running"].includes(event.status)) throw new Error("EVENTO_NAO_DISPONIVEL");

  const db = getDb();

  // Inicializa estado em memória — recarrega check-ins do Firestore se necessário
  if (!activeEvent || activeEvent.eventId !== eventId) {
    activeEvent = {
      eventId,
      title:          event.title,
      scheduledAt:    event.scheduledAt,
      status:         "waiting",
      participants:   await loadCheckins(db, eventId),
      currentRound:   -1,
      totalRounds:    0,
      forceMode:      false,
      allRoundPairs:  [],
      currentPairs:   [],
      roundStartedAt: null,
      roundTimer:     null,
      warnTimer:      null,
      transitionTimer:null,
      interestVotes:  new Map(),
    };
  }

  activeEvent.participants.set(uid, { uid, name, email, gender });

  // Persiste check-in no Firestore para sobreviver a restarts do servidor
  if (db) {
    await db.collection("encontro_checkins").doc(`${eventId}_${uid}`).set(
      { eventId, uid, name, email, gender, checkedInAt: Date.now() },
      { merge: true }
    );
  }

  // Atualiza status no Firestore para "waiting" na primeira vez
  if (event.status === "upcoming" && db) {
    await db.collection("encontro_eventos").doc(eventId).update({ status: "waiting" });
  }

  logInfo("encontro_checkin", { eventId, uid, gender, total: activeEvent.participants.size });

  const men   = [...activeEvent.participants.values()].filter(p => p.gender === "M").length;
  const women = [...activeEvent.participants.values()].filter(p => p.gender === "F").length;

  broadcastToEvent("encontro:count_update", {
    eventId,
    total: activeEvent.participants.size,
    men,
    women,
    status: activeEvent.status,
  });

  return { eventId, total: activeEvent.participants.size, men, women };
}

// ─── Orquestração das rodadas ─────────────────────────────────────────────────

async function startEvent(eventId, force = false) {
  if (!activeEvent || activeEvent.eventId !== eventId) {
    const event = await getEvent(eventId);
    if (!event) throw new Error("EVENTO_NAO_ENCONTRADO");
    const db = getDb();
    activeEvent = {
      eventId,
      title:          event.title,
      scheduledAt:    event.scheduledAt,
      status:         "waiting",
      participants:   await loadCheckins(db, eventId),
      currentRound:   -1,
      totalRounds:    0,
      forceMode:      false,
      allRoundPairs:  [],
      currentPairs:   [],
      roundStartedAt: null,
      roundTimer:     null,
      warnTimer:      null,
      transitionTimer:null,
      interestVotes:  new Map(),
    };
    logInfo("encontro_participants_reloaded", { eventId, count: activeEvent.participants.size });
  }

  const all   = [...activeEvent.participants.values()];
  const men   = all.filter(p => p.gender === "M");
  const women = all.filter(p => p.gender === "F");

  if (force) {
    // Modo teste: pareia qualquer pessoa com qualquer pessoa, ignora gênero
    if (all.length < 1) throw new Error("PARTICIPANTES_INSUFICIENTES");
    // Com 1 participante real, injeta parceiro virtual para testar o fluxo solo
    if (all.length === 1) {
      const bot = { uid: "bot_parceiro", name: "Convidado(a)", gender: "F" };
      activeEvent.participants.set(bot.uid, bot);
    }
    activeEvent.forceMode   = true;
    activeEvent.totalRounds = 1; // 1 rodada de teste é suficiente
  } else {
    if (men.length === 0 || women.length === 0) throw new Error("PARTICIPANTES_INSUFICIENTES");
    activeEvent.forceMode   = false;
    activeEvent.totalRounds = Math.min(men.length, women.length);
  }

  activeEvent.status = "running";

  const db = getDb();
  if (db) {
    await db.collection("encontro_eventos").doc(eventId).update({ status: "running", startedAt: Date.now() });
  }

  logInfo("encontro_event_started", { eventId, men: men.length, women: women.length, totalRounds: activeEvent.totalRounds });

  await advanceToNextRound();
}

async function advanceToNextRound() {
  if (!activeEvent) return;
  clearTimers();

  activeEvent.currentRound++;
  const { eventId, currentRound, totalRounds } = activeEvent;

  if (currentRound >= totalRounds) {
    await endEvent(eventId);
    return;
  }

  const pairs = computePairsForRound(activeEvent.participants, currentRound, activeEvent.forceMode);
  activeEvent.currentPairs    = pairs;
  activeEvent.roundStartedAt  = Date.now();
  activeEvent.allRoundPairs.push(pairs);

  const io = getIo();
  if (io) {
    for (let i = 0; i < pairs.length; i++) {
      const pair     = pairs[i];
      const roomName = `encontro-${eventId}-r${currentRound}-p${i}`;

      // Gera tokens independentemente — bot não bloqueia usuário real
      const tok1 = pair.uid1.startsWith("bot_") ? null
        : await generateLiveKitToken(roomName, pair.uid1).catch(err => {
            logError("encontro_token_error", err, { eventId, roomName, uid: pair.uid1 });
            return null;
          });
      const tok2 = pair.uid2.startsWith("bot_") ? null
        : await generateLiveKitToken(roomName, pair.uid2).catch(err => {
            logError("encontro_token_error", err, { eventId, roomName, uid: pair.uid2 });
            return null;
          });

      if (tok1) {
        io.to(pair.uid1).emit("encontro:round_started", {
          eventId,
          round:        currentRound + 1,
          totalRounds,
          room:         roomName,
          livekitToken: tok1,
          partnerName:  pair.name2,
          durationMs:   ROUND_DURATION_MS,
        });
      }
      if (tok2) {
        io.to(pair.uid2).emit("encontro:round_started", {
          eventId,
          round:        currentRound + 1,
          totalRounds,
          room:         roomName,
          livekitToken: tok2,
          partnerName:  pair.name1,
          durationMs:   ROUND_DURATION_MS,
        });
      }
    }

    // Participantes que ficam de fora nesta rodada (grupo maior)
    const pairedUids = new Set(pairs.flatMap(p => [p.uid1, p.uid2]));
    for (const uid of activeEvent.participants.keys()) {
      if (!pairedUids.has(uid)) {
        io.to(uid).emit("encontro:sitting_out", {
          eventId,
          round:      currentRound + 1,
          totalRounds,
          durationMs: ROUND_DURATION_MS,
        });
      }
    }
  }

  logInfo("encontro_round_started", { eventId, round: currentRound + 1, pairs: pairs.length });

  // Aviso 30 segundos antes
  activeEvent.warnTimer = setTimeout(() => {
    broadcastToEvent("encontro:round_warning", { eventId, secondsLeft: 30 });
  }, ROUND_DURATION_MS - WARN_BEFORE_MS);

  // Fim da rodada → transição
  activeEvent.roundTimer = setTimeout(() => {
    if (!activeEvent || activeEvent.eventId !== eventId) return;
    const isLast = (currentRound + 1) >= totalRounds;
    broadcastToEvent("encontro:round_ended", {
      eventId,
      completedRound: currentRound + 1,
      nextRound:      isLast ? null : currentRound + 2,
      isLastRound:    isLast,
      transitionMs:   TRANSITION_MS,
    });
    activeEvent.transitionTimer = setTimeout(() => advanceToNextRound(), TRANSITION_MS);
  }, ROUND_DURATION_MS);
}

async function endEvent(eventId) {
  if (!activeEvent || activeEvent.eventId !== eventId) return;
  clearTimers();
  activeEvent.status = "ended";

  const db = getDb();
  if (db) {
    await db.collection("encontro_eventos").doc(eventId).update({ status: "ended", endedAt: Date.now() });
  }

  const io = getIo();
  if (io) {
    const allPairs   = activeEvent.allRoundPairs;
    const participants = activeEvent.participants;

    for (const [uid] of participants) {
      const metPeople = [];
      const seen      = new Set();
      for (const roundPairs of allPairs) {
        for (const pair of roundPairs) {
          if (pair.uid1 === uid && !seen.has(pair.uid2)) {
            seen.add(pair.uid2);
            const p = participants.get(pair.uid2);
            if (p) metPeople.push({ uid: p.uid, name: p.name, gender: p.gender });
          } else if (pair.uid2 === uid && !seen.has(pair.uid1)) {
            seen.add(pair.uid1);
            const p = participants.get(pair.uid1);
            if (p) metPeople.push({ uid: p.uid, name: p.name, gender: p.gender });
          }
        }
      }
      io.to(uid).emit("encontro:event_ended", { eventId, metPeople });
    }
  }

  logInfo("encontro_event_ended", { eventId });
}

async function forceEndEvent(eventId) {
  await endEvent(eventId);
}

async function resetCheckins(eventId) {
  const db = getDb();
  if (db) {
    const snap = await db.collection("encontro_checkins")
      .where("eventId", "==", eventId)
      .get();
    const batch = db.batch();
    snap.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    // Reseta status do evento para "waiting" para permitir novo teste
    await db.collection("encontro_eventos").doc(eventId).update({ status: "waiting" });
  }
  if (activeEvent?.eventId === eventId) {
    clearTimers();
    activeEvent.participants = new Map();
    activeEvent.status       = "waiting";
    activeEvent.currentRound = -1;
    activeEvent.totalRounds  = 0;
    activeEvent.forceMode    = false;
    activeEvent.allRoundPairs = [];
    activeEvent.currentPairs  = [];
    activeEvent.roundStartedAt = null;
    activeEvent.interestVotes  = new Map();
  }
  logInfo("encontro_checkins_reset", { eventId });
}

// ─── Match / interesse ────────────────────────────────────────────────────────

async function voteInterest(eventId, voterUid, targetUid, liked) {
  const db  = getDb();
  const key = `${voterUid}_${targetUid}`;

  if (db) {
    await db.collection("encontro_interests")
      .doc(`${eventId}_${voterUid}_${targetUid}`)
      .set({ eventId, voterUid, targetUid, liked, createdAt: Date.now() }, { merge: true });
  }

  if (activeEvent?.eventId === eventId) {
    activeEvent.interestVotes.set(key, liked);
  }

  if (!liked) return { matched: false };

  // Bot responde always com like → match imediato
  if (targetUid.startsWith("bot_")) {
    const io = getIo();
    if (io) {
      const voterInfo  = activeEvent?.participants.get(voterUid);
      const targetInfo = activeEvent?.participants.get(targetUid);
      io.to(voterUid).emit("encontro:match", {
        eventId,
        matchUid:  targetUid,
        matchName: targetInfo?.name || "Convidado(a)",
      });
    }
    return { matched: true };
  }

  // Verifica match mútuo
  const reverseKey = `${targetUid}_${voterUid}`;
  let theyLiked    = activeEvent?.interestVotes?.get(reverseKey);

  if (theyLiked === undefined && db) {
    const reverseDoc = await db.collection("encontro_interests")
      .doc(`${eventId}_${targetUid}_${voterUid}`)
      .get();
    if (reverseDoc.exists) theyLiked = reverseDoc.data().liked;
  }

  if (theyLiked === true) {
    const io = getIo();
    if (io) {
      const voterInfo  = activeEvent?.participants.get(voterUid);
      const targetInfo = activeEvent?.participants.get(targetUid);
      io.to(voterUid).emit("encontro:match",  { eventId, matchUid: targetUid, matchName: targetInfo?.name || "Alguém" });
      io.to(targetUid).emit("encontro:match", { eventId, matchUid: voterUid,  matchName: voterInfo?.name  || "Alguém" });
    }
    return { matched: true };
  }

  return { matched: false };
}

async function getMyMatches(eventId, uid) {
  const db = getDb();
  if (!db) return [];

  const myVotes = await db.collection("encontro_interests")
    .where("eventId", "==", eventId)
    .where("voterUid", "==", uid)
    .where("liked", "==", true)
    .get();

  const matches = [];
  for (const doc of myVotes.docs) {
    const targetUid  = doc.data().targetUid;
    const reverseDoc = await db.collection("encontro_interests")
      .doc(`${eventId}_${targetUid}_${uid}`)
      .get();
    if (reverseDoc.exists && reverseDoc.data().liked === true) {
      const info = activeEvent?.participants.get(targetUid);
      matches.push({ uid: targetUid, name: info?.name || "Match" });
    }
  }
  return matches;
}

// ─── Catch-up para socket que conectou durante rodada em andamento ────────────

async function getRoundCatchupForUser(uid) {
  if (!activeEvent || activeEvent.status !== "running") return null;
  if (!activeEvent.participants.has(uid)) return null;

  const { eventId, currentRound, totalRounds, currentPairs, roundStartedAt } = activeEvent;
  if (!currentPairs || currentPairs.length === 0) return null;

  const pairIndex = currentPairs.findIndex(p => p.uid1 === uid || p.uid2 === uid);
  if (pairIndex === -1) {
    // Está de fora nesta rodada
    const elapsed    = Date.now() - (roundStartedAt || 0);
    const remaining  = Math.max(0, ROUND_DURATION_MS - elapsed);
    return { type: "sitting_out", eventId, round: currentRound + 1, totalRounds, durationMs: remaining };
  }

  const pair      = currentPairs[pairIndex];
  const roomName  = `encontro-${eventId}-r${currentRound}-p${pairIndex}`;
  const isUid1    = pair.uid1 === uid;
  const partnerName = isUid1 ? pair.name2 : pair.name1;

  const elapsed   = Date.now() - (roundStartedAt || 0);
  const remaining = Math.max(0, ROUND_DURATION_MS - elapsed);
  if (remaining <= 0) return null; // rodada já acabou, não faz catch-up

  try {
    const token = await generateLiveKitToken(roomName, uid);
    return {
      type: "round_started",
      eventId,
      round:        currentRound + 1,
      totalRounds,
      room:         roomName,
      livekitToken: token,
      partnerName,
      durationMs:   remaining,
    };
  } catch {
    return null;
  }
}

// ─── Status e detalhes (admin) ────────────────────────────────────────────────

function getActiveEventMemoryStatus(eventId) {
  if (!activeEvent || activeEvent.eventId !== eventId) return null;
  const men   = [...activeEvent.participants.values()].filter(p => p.gender === "M").length;
  const women = [...activeEvent.participants.values()].filter(p => p.gender === "F").length;
  return {
    eventId,
    status:       activeEvent.status,
    participants: activeEvent.participants.size,
    men,
    women,
    currentRound: activeEvent.currentRound + 1,
    totalRounds:  activeEvent.totalRounds,
  };
}

async function getAdminEventDetails(eventId) {
  const db    = getDb();
  const event = await getEvent(eventId);
  if (!event) return null;

  let ticketCount = 0;
  if (db) {
    const snap = await db.collection("encontro_tickets")
      .where("eventId", "==", eventId)
      .get();
    ticketCount = snap.size;
  }

  const mem = getActiveEventMemoryStatus(eventId);
  return {
    ...event,
    ticketCount,
    checkedIn:    mem?.participants   || 0,
    men:          mem?.men            || 0,
    women:        mem?.women          || 0,
    currentRound: mem?.currentRound   || 0,
    totalRounds:  mem?.totalRounds    || 0,
  };
}

module.exports = {
  createEvent,
  listEvents,
  getEvent,
  deleteEvent,
  verifyTicket,
  checkinParticipant,
  startEvent,
  forceEndEvent,
  resetCheckins,
  voteInterest,
  getMyMatches,
  getActiveEventMemoryStatus,
  getAdminEventDetails,
  getRoundCatchupForUser,
};
