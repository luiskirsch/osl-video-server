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
function computePairsForRound(participants, roundIndex) {
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
  const event   = {
    eventId,
    title: title || `Encontro Marcado — ${new Date(scheduledAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "long" })}`,
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

async function checkinParticipant(eventId, uid, email, name, gender) {
  const hasTicket = await verifyTicket(eventId, email);
  if (!hasTicket) throw new Error("INGRESSO_NAO_ENCONTRADO");

  const event = await getEvent(eventId);
  if (!event) throw new Error("EVENTO_NAO_ENCONTRADO");
  if (!["upcoming", "waiting"].includes(event.status)) throw new Error("EVENTO_NAO_DISPONIVEL");

  const db = getDb();

  // Inicializa estado em memória se ainda não existe
  if (!activeEvent || activeEvent.eventId !== eventId) {
    activeEvent = {
      eventId,
      title:          event.title,
      scheduledAt:    event.scheduledAt,
      status:         "waiting",
      participants:   new Map(),
      currentRound:   -1,
      totalRounds:    0,
      allRoundPairs:  [], // [[{uid1,name1,uid2,name2},...]] por rodada
      currentPairs:   [],
      roundTimer:     null,
      warnTimer:      null,
      transitionTimer:null,
      interestVotes:  new Map(), // `${voterUid}_${targetUid}` → boolean
    };
  }

  activeEvent.participants.set(uid, { uid, name, email, gender });

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

async function startEvent(eventId) {
  if (!activeEvent || activeEvent.eventId !== eventId) {
    const event = await getEvent(eventId);
    if (!event) throw new Error("EVENTO_NAO_ENCONTRADO");
    activeEvent = {
      eventId,
      title:          event.title,
      scheduledAt:    event.scheduledAt,
      status:         "waiting",
      participants:   new Map(),
      currentRound:   -1,
      totalRounds:    0,
      allRoundPairs:  [],
      currentPairs:   [],
      roundTimer:     null,
      warnTimer:      null,
      transitionTimer:null,
      interestVotes:  new Map(),
    };
  }

  const men   = [...activeEvent.participants.values()].filter(p => p.gender === "M");
  const women = [...activeEvent.participants.values()].filter(p => p.gender === "F");
  if (men.length === 0 || women.length === 0) throw new Error("PARTICIPANTES_INSUFICIENTES");

  activeEvent.totalRounds = Math.min(men.length, women.length);
  activeEvent.status      = "running";

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

  const pairs = computePairsForRound(activeEvent.participants, currentRound);
  activeEvent.currentPairs = pairs;
  activeEvent.allRoundPairs.push(pairs);

  const io = getIo();
  if (io) {
    for (let i = 0; i < pairs.length; i++) {
      const pair     = pairs[i];
      const roomName = `encontro-${eventId}-r${currentRound}-p${i}`;

      try {
        const [tok1, tok2] = await Promise.all([
          generateLiveKitToken(roomName, pair.uid1),
          generateLiveKitToken(roomName, pair.uid2),
        ]);
        io.to(pair.uid1).emit("encontro:round_started", {
          eventId,
          round:        currentRound + 1,
          totalRounds,
          room:         roomName,
          livekitToken: tok1,
          partnerName:  pair.name2,
          durationMs:   ROUND_DURATION_MS,
        });
        io.to(pair.uid2).emit("encontro:round_started", {
          eventId,
          round:        currentRound + 1,
          totalRounds,
          room:         roomName,
          livekitToken: tok2,
          partnerName:  pair.name1,
          durationMs:   ROUND_DURATION_MS,
        });
      } catch (err) {
        logError("encontro_token_error", err, { eventId, roomName });
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
  voteInterest,
  getMyMatches,
  getActiveEventMemoryStatus,
  getAdminEventDetails,
};
