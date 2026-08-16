'use strict';

/**
 * AccountSnapshot v1
 *
 * A conta do jogo tem uma única raiz persistente: users/{firebaseUid}.
 * Este módulo concentra a normalização de perfil/progressão para que Hub,
 * sala e futuras superfícies não recriem fórmulas ou fallbacks diferentes.
 */

const { FieldValue } = require('firebase-admin/firestore');
const { levelFromXP } = require('../data/cards');

const SCHEMA_VERSION = 1;

// Espelho do mapa de moedas do frontend (js/constants.js OSL_COINS_PER_LEVEL).
// Índice 0 = nível 1, mas moedas só são concedidas ao subir DE nível (≥2).
const COINS_PER_LEVEL = [
   25,  25,  25,  25, 100,
   25,  25,  25,  25, 100,
   30,  30,  30,  30, 150,
   30,  30,  30,  30, 150,
   50,  50,  50,  50, 200,
   50,  50,  50,  50, 200,
   75,  75,  75,  75, 300,
   75,  75,  75,  75, 300,
  100, 100, 100, 100, 400,
  100, 100, 100, 100, 500,
];

// Espelho do catálogo visual já usado pelo cliente. O último título também é
// usado para níveis acima do catálogo, preservando a progressão numérica.
const XP_TITLES = [
  'Curioso', 'Iniciado', 'Aprendiz', 'Observador', 'Explorador',
  'Intérprete', 'Analista', 'Psicólogo', 'Revelador', 'Guardião',
  'Vidente', 'Confessor', 'Decodificador', 'Intuitivo', 'Provocador',
  'Desvelador', 'Estrategista', 'Manipulador', 'Arquiteto', 'Oráculo',
  'Sussurrador', 'Catalisador', 'Espelho', 'Sombra', 'Confrontador',
  'Alquimista', 'Ritualista', 'Sacerdote', 'Xamã', 'Hierofante',
  'Iluminado', 'Transcendente', 'Ancestral', 'Voz do Abismo', 'Guardião do Segredo',
  'Tecelão', 'Escultor de Almas', 'Navegador', 'Portador da Chave', 'Mestre das Sombras',
  'Portador do Fogo', 'Arquivista Eterno', 'Cronista', 'Sentinela', 'Arauto',
  'Profeta', 'Deus das Perguntas', 'Além do Nome', 'O Inominável', 'O Sexto',
];

const REPUTATION_TIERS = [
  { min: 1000, tier: 'Ícone' },
  { min: 600,  tier: 'Lendário' },
  { min: 300,  tier: 'Veterano' },
  { min: 150,  tier: 'Engajado' },
  { min: 50,   tier: 'Participante' },
  { min: 0,    tier: 'Iniciante' },
];

function nonNegativeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function integer(value, fallback = 0) {
  return Math.floor(nonNegativeNumber(value, fallback));
}

function cleanString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized || fallback;
}

function timestampMs(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function jsonSafe(value, depth = 0) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const millis = timestampMs(value);
  if (millis !== null && (value instanceof Date || typeof value?.toMillis === 'function' || typeof value?.toDate === 'function')) {
    return millis;
  }
  if (depth >= 4) return null;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => jsonSafe(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      out[key] = jsonSafe(item, depth + 1);
    }
    return out;
  }
  return null;
}

function xpForLevel(level) {
  const safeLevel = Math.max(1, integer(level, 1));
  return Math.pow(safeLevel - 1, 2) * 50;
}

function xpForNextLevel(level) {
  const safeLevel = Math.max(1, integer(level, 1));
  return Math.pow(safeLevel, 2) * 50;
}

function titleForLevel(level) {
  const index = Math.max(0, Math.min(integer(level, 1) - 1, XP_TITLES.length - 1));
  return XP_TITLES[index];
}

function reputationTier(score) {
  const safeScore = nonNegativeNumber(score);
  return REPUTATION_TIERS.find(item => safeScore >= item.min)?.tier || 'Iniciante';
}

function resolveAvatar(user = {}, legacyProfile = {}, claims = {}) {
  const canonical = user.avatar && typeof user.avatar === 'object' ? user.avatar : {};
  const legacyAvatar = legacyProfile.avatar && typeof legacyProfile.avatar === 'object'
    ? legacyProfile.avatar
    : {};

  const requestedKind = cleanString(canonical.kind || legacyAvatar.kind);
  // Uma escolha explícita por emoji significa também remover a fotografia.
  // Sem esta regra, o `claims.picture` do Firebase ressuscitava uma foto antiga.
  const canUseImageFallback = requestedKind !== 'emoji';

  const url = canUseImageFallback ? cleanString(
    canonical.url
      || user.avatarPhotoUrl
      || user.avatarPhotoURL
      || user.photoURL
      || user.photoUrl
      || legacyAvatar.url
      || legacyProfile.avatarPhotoUrl
      || legacyProfile.photoURL
      || legacyProfile.photoBase64
      || claims.picture
      || '',
  ) : '';
  const emoji = cleanString(canonical.emoji || user.avatarEmoji || legacyAvatar.emoji || legacyProfile.avatarEmoji, '🔮');
  const color = cleanString(canonical.color || user.avatarColor || legacyAvatar.color || legacyProfile.avatarColor, '#342718');

  let kind = requestedKind;
  if (!kind) kind = url ? 'image' : 'emoji';
  if (!['image', 'emoji', 'generated'].includes(kind)) kind = url ? 'image' : 'emoji';

  return { kind, url: url || null, emoji, color };
}

function normalizeActiveSession(user = {}) {
  const raw = user.activeSession || user.lastActivity || null;
  if (!raw || typeof raw !== 'object') return null;
  const roomId = cleanString(raw.roomId);
  const sessionId = cleanString(raw.sessionId);
  const type = cleanString(raw.type || raw.mode, 'ritual');
  if (!roomId && !sessionId) return null;
  return {
    type,
    roomId: roomId || null,
    sessionId: sessionId || null,
    startedAt: timestampMs(raw.startedAt || user.lastActivityAt),
  };
}

function buildAccountSnapshot({ uid, claims = {}, user = {}, legacyProfile = {}, lastSession = null } = {}) {
  if (!uid) throw new Error('UID_OBRIGATORIO');

  const xp = integer(user.xp);
  const level = levelFromXP(xp);
  const levelXp = xpForLevel(level);
  const nextLevelXp = xpForNextLevel(level);
  const xpIntoLevel = Math.max(0, xp - levelXp);
  const xpNeededForLevel = Math.max(1, nextLevelXp - levelXp);
  const progressPct = Math.max(0, Math.min(100, Math.round((xpIntoLevel / xpNeededForLevel) * 100)));

  const rep = user.reputation && typeof user.reputation === 'object' ? user.reputation : {};
  const stats = user.stats && typeof user.stats === 'object' ? jsonSafe(user.stats) : {};
  const totalSessions = integer(rep.totalSessions ?? stats.gamesPlayed);
  const dailyCompleted = Math.max(
    integer(rep.dailyRitualsCompleted),
    integer(stats.dailyRitualsCompleted),
  );
  const achievements = user.achievements;
  const achievementsCount = Array.isArray(achievements)
    ? achievements.length
    : (achievements && typeof achievements === 'object' ? Object.keys(achievements).length : 0);

  const email = cleanString(user.email || claims.email).toLowerCase();
  const username = cleanString(user.username);
  const displayName = cleanString(
    user.displayName
      || user.name
      || claims.name
      || username
      || (email ? email.split('@')[0] : ''),
    'Jogador',
  );

  return {
    schemaVersion: SCHEMA_VERSION,
    uid,
    profile: {
      displayName,
      username,
      email,
      bio: cleanString(user.bio),
      avatar: resolveAvatar(user, legacyProfile, claims),
    },
    progression: {
      xp,
      level,
      title: titleForLevel(level),
      levelXp,
      nextLevelXp,
      xpIntoLevel,
      xpNeededForLevel,
      progressPct,
      dailyStreak: integer(user.dailyStreak),
      achievementsCount,
      stats: {
        ...stats,
        gamesPlayed: integer(stats.gamesPlayed ?? totalSessions),
        wins: integer(stats.wins),
        dailyRitualsCompleted: dailyCompleted,
      },
    },
    wallet: {
      coins: integer(user.coins),
    },
    reputation: {
      score: integer(rep.score),
      tier: cleanString(rep.tier || rep.level, reputationTier(rep.score)),
      totalSessions,
      totalReactions: integer(rep.totalReactions),
      topReactorCount: integer(rep.topReactorCount),
      dailyRitualsCompleted: dailyCompleted,
    },
    social: {
      friendsCount: Array.isArray(user.friends) ? new Set(user.friends.filter(Boolean)).size : 0,
      incomingCount: Array.isArray(user.incomingRequests) ? new Set(user.incomingRequests.filter(Boolean)).size : 0,
      outgoingCount: Array.isArray(user.outgoingRequests) ? new Set(user.outgoingRequests.filter(Boolean)).size : 0,
    },
    activity: {
      activeSession: normalizeActiveSession(user),
      lastSession: lastSession ? jsonSafe(lastSession) : null,
    },
  };
}

async function loadAccountSnapshot({ db, uid, claims = {}, userData, lastSession = null } = {}) {
  if (!db) throw new Error('DB_INDISPONIVEL');
  if (!uid) throw new Error('UID_OBRIGATORIO');

  const userPromise = userData !== undefined
    ? Promise.resolve(userData)
    : db.collection('users').doc(uid).get().then(snap => snap.exists ? snap.data() : {});
  const legacyPromise = db.collection('user_profiles').doc(uid).get()
    .then(snap => snap.exists ? snap.data() : {})
    .catch(() => ({}));

  const [user, legacyProfile] = await Promise.all([userPromise, legacyPromise]);
  return buildAccountSnapshot({ uid, claims, user: user || {}, legacyProfile, lastSession });
}

/**
 * Garante a raiz canonica users/{uid} e devolve o mesmo snapshot usado por
 * todas as superficies. Campos preenchidos pelo jogador nunca sao
 * sobrescritos; claims e perfil legado servem apenas para completar ausencias.
 */
async function ensureAccountSnapshot({ db, uid, claims = {}, userData, lastSession = null } = {}) {
  if (!db) throw new Error('DB_INDISPONIVEL');
  if (!uid) throw new Error('UID_OBRIGATORIO');

  const userRef = db.collection('users').doc(uid);
  const legacyRef = db.collection('user_profiles').doc(uid);

  // Sempre relê dentro da transação. `userData` pode acelerar renderizações em
  // outros chamadores, mas não é prova suficiente para um backfill econômico:
  // XP/moedas podem mudar entre a leitura do Hub e esta gravação.
  void userData;
  return db.runTransaction(async tx => {
    const [userSnap, legacySnap] = await Promise.all([
      tx.get(userRef),
      tx.get(legacyRef),
    ]);
    const user = userSnap.exists ? (userSnap.data() || {}) : {};
    const legacyProfile = legacySnap.exists ? (legacySnap.data() || {}) : {};

    const patch = {};
    if (user.schemaVersion !== SCHEMA_VERSION) patch.schemaVersion = SCHEMA_VERSION;
    if (user.uid !== uid) patch.uid = uid;
    if (user.userId !== uid) patch.userId = uid;
    if (!Number.isFinite(Number(user.xp)) || Number(user.xp) < 0) patch.xp = 0;
    if (!Number.isFinite(Number(user.coins)) || Number(user.coins) < 0) patch.coins = 0;

    // Concede coins para level-ups que o cliente nunca conseguiu persistir
    // (Firestore rules bloqueiam escrita de coins pelo cliente).
    const _currentLevel = levelFromXP(integer(user.xp));
    const _coinAwardedUpToLevel = integer(user.coinAwardedUpToLevel, 0);
    let _coinAwardAmount = 0;
    if (_currentLevel > _coinAwardedUpToLevel) {
      for (let _lvl = Math.max(2, _coinAwardedUpToLevel + 1); _lvl <= _currentLevel; _lvl++) {
        _coinAwardAmount += COINS_PER_LEVEL[_lvl - 1] ?? 25;
      }
      if (_coinAwardAmount > 0) {
        delete patch.coins; // remove eventual patch.coins=0 para usar increment
        patch.coins = FieldValue.increment(_coinAwardAmount);
      }
      patch.coinAwardedUpToLevel = _currentLevel;
    }

    if (!Array.isArray(user.friends)) patch.friends = [];
    if (!Array.isArray(user.incomingRequests)) patch.incomingRequests = [];
    if (!Array.isArray(user.outgoingRequests)) patch.outgoingRequests = [];
    if (!user.achievements || typeof user.achievements !== 'object') patch.achievements = {};

    const currentStats = user.stats && typeof user.stats === 'object' ? user.stats : {};
    const statsPatch = {};
    if (!Number.isFinite(Number(currentStats.gamesPlayed))) statsPatch.gamesPlayed = 0;
    if (!Number.isFinite(Number(currentStats.wins))) statsPatch.wins = 0;
    if (Object.keys(statsPatch).length) patch.stats = statsPatch;

    const email = cleanString(user.email || claims.email).toLowerCase();
    if (!cleanString(user.email) && email) patch.email = email;

    const displayName = cleanString(
      user.displayName
        || user.name
        || claims.name
        || legacyProfile.displayName
        || legacyProfile.name,
    );
    if (!cleanString(user.displayName) && displayName) patch.displayName = displayName;

    if (!user.avatar || typeof user.avatar !== 'object') {
      patch.avatar = resolveAvatar(user, legacyProfile, claims);
    }
    if (!userSnap.exists) patch.createdAt = FieldValue.serverTimestamp();
    if (Object.keys(patch).length) {
      patch.updatedAt = FieldValue.serverTimestamp();
      tx.set(userRef, patch, { merge: true });
    }

    const mergedUser = {
      ...user,
      ...patch,
      // coins pode ser FieldValue.increment — usa valor numérico para o snapshot
      coins: integer(user.coins) + _coinAwardAmount,
      coinAwardedUpToLevel: _currentLevel,
      avatar: patch.avatar || user.avatar,
      stats: {
        ...(user.stats && typeof user.stats === 'object' ? user.stats : {}),
        ...(patch.stats || {}),
      },
    };
    return buildAccountSnapshot({ uid, claims, user: mergedUser, legacyProfile, lastSession });
  });
}

function previousIsoDate(dateString) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function nextDailyStreak(user = {}, dateString) {
  const previous = previousIsoDate(dateString);
  const lastDate = cleanString(user.lastDailyCompletedDate || user.lastDailyReward);
  return lastDate === previous ? Math.max(1, integer(user.dailyStreak) + 1) : 1;
}

/**
 * Registra a conclusão diária uma única vez por UID/data.
 * Retorna apenas dados transacionais; publicação no EventBus fica a cargo da
 * rota, depois do commit, para nunca anunciar uma recompensa que não persistiu.
 */
async function completeDailyRitual({ db, uid, daily, now = new Date(), fieldValue = FieldValue } = {}) {
  if (!db) throw new Error('DB_INDISPONIVEL');
  if (!uid) throw new Error('UID_OBRIGATORIO');
  if (!daily?.date) throw new Error('RITUAL_INVALIDO');

  const date = String(daily.date);
  const dailyRef = db.collection('daily_ritual').doc(date);
  const completionRef = dailyRef.collection('completions').doc(uid);
  const userRef = db.collection('users').doc(uid);

  return db.runTransaction(async tx => {
    const [completionSnap, dailySnap, userSnap] = await Promise.all([
      tx.get(completionRef),
      tx.get(dailyRef),
      tx.get(userRef),
    ]);

    const persistedDaily = dailySnap.exists ? dailySnap.data() : daily;
    // A recompensa pertence ao documento diário lido na mesma transação.
    // Assim uma alteração administrativa concorrente não concede o valor
    // obsoleto que estava no cache do chamador.
    const xpValue = integer(persistedDaily?.bonusXp, integer(daily.bonusXp, 35)) || 35;
    const currentCount = integer(persistedDaily?.completionCount);

    if (completionSnap.exists) {
      const completion = completionSnap.data() || {};
      return {
        alreadyCompleted: true,
        xpAwarded: 0,
        originalXpAwarded: integer(completion.xpAwarded, xpValue),
        completionCount: currentCount,
        completedAt: timestampMs(completion.completedAt),
      };
    }

    const user = userSnap.exists ? userSnap.data() : {};
    const streak = nextDailyStreak(user, date);
    const completedAt = fieldValue.serverTimestamp();

    tx.set(completionRef, {
      uid,
      date,
      xpAwarded: xpValue,
      streak,
      completedAt,
    });
    tx.set(dailyRef, {
      completionCount: fieldValue.increment(1),
      updatedAt: fieldValue.serverTimestamp(),
    }, { merge: true });
    tx.set(userRef, {
      uid,
      email: cleanString(user.email),
      xp: fieldValue.increment(xpValue),
      dailyStreak: streak,
      lastDailyCompletedDate: date,
      stats: {
        dailyRitualsCompleted: fieldValue.increment(1),
      },
      updatedAt: fieldValue.serverTimestamp(),
    }, { merge: true });

    return {
      alreadyCompleted: false,
      xpAwarded: xpValue,
      originalXpAwarded: xpValue,
      completionCount: currentCount + 1,
      completedAt: timestampMs(now),
      streak,
    };
  });
}

module.exports = {
  SCHEMA_VERSION,
  XP_TITLES,
  buildAccountSnapshot,
  loadAccountSnapshot,
  ensureAccountSnapshot,
  completeDailyRitual,
  resolveAvatar,
  reputationTier,
  xpForLevel,
  xpForNextLevel,
  nextDailyStreak,
  timestampMs,
};
