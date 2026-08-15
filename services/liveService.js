'use strict';

/**
 * services/liveService.js — Live Service (P2)
 *
 * Gerencia conteúdo dinâmico que torna o jogo "vivo" entre sessões:
 *
 *  Seasons   — períodos temáticos com packIds exclusivos e multiplicador de XP
 *  Events    — eventos temporários com cartas bônus e XP extra
 *  Daily     — Ritual Diário gerado automaticamente do pool de cartas básicas;
 *              reseta à meia-noite UTC (≈21h São Paulo)
 *
 * Integração:
 *  - buildVerifiedDeck inclui getLivePackIds() no deck automaticamente
 *  - session.ended verifica se ritual diário foi jogado (via EventBus)
 *
 * Firestore:
 *  seasons/{id}               → schema Season
 *  live_events/{id}           → schema LiveEvent
 *  daily_ritual/{YYYY-MM-DD}  → schema DailyRitual
 *
 * API pública:
 *  getActiveSeason()           → Season | null
 *  getActiveEvents()           → LiveEvent[]
 *  getDailyRitual()            → DailyRitual | null
 *  getLivePackIds()            → string[]  (season + events)
 *  init()                      → registra listener session.ended
 */

const admin  = require('firebase-admin');
const logger = require('../logger');

let _db = null;
function getDb() {
  if (!_db) _db = require('./firestore').getDb();
  return _db;
}

// ── Caches ────────────────────────────────────────────────────────────────────

const SEASON_TTL_MS = 10 * 60_000;   // 10 min
const EVENT_TTL_MS  =  5 * 60_000;   //  5 min

let _seasonCache  = null;   // { data, expiresAt }
let _eventsCache  = null;   // { data, expiresAt }
let _dailyCache   = null;   // { data, date }

// ── Seasons ───────────────────────────────────────────────────────────────────

async function getActiveSeason() {
  if (_seasonCache && _seasonCache.expiresAt > Date.now()) return _seasonCache.data;

  const db = getDb();
  if (!db) return null;

  const snap = await db.collection('seasons').where('active', '==', true).get();
  const now  = Date.now();

  const active = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(s => {
      const start = s.startAt?.toMillis?.() || 0;
      const end   = s.endAt?.toMillis?.()   || Infinity;
      return start <= now && end > now;
    })
    .sort((a, b) => (b.startAt?.toMillis?.() || 0) - (a.startAt?.toMillis?.() || 0))[0] || null;

  _seasonCache = { data: active, expiresAt: now + SEASON_TTL_MS };
  return active;
}

// ── Live Events ───────────────────────────────────────────────────────────────

async function getActiveEvents() {
  if (_eventsCache && _eventsCache.expiresAt > Date.now()) return _eventsCache.data;

  const db = getDb();
  if (!db) return [];

  const snap = await db.collection('live_events').where('active', '==', true).get();
  const now  = Date.now();

  const active = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(e => {
      const start = e.startAt?.toMillis?.() || 0;
      const end   = e.endAt?.toMillis?.()   || Infinity;
      return start <= now && end > now;
    });

  _eventsCache = { data: active, expiresAt: now + EVENT_TTL_MS };
  return active;
}

// ── Daily Ritual ──────────────────────────────────────────────────────────────

function _todayStr() {
  return new Date().toISOString().slice(0, 10);  // YYYY-MM-DD UTC
}

function _endOfDayUTC(dateStr) {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

async function getDailyRitual() {
  const today = _todayStr();
  if (_dailyCache?.date === today) return _dailyCache.data;

  const db = getDb();
  if (!db) return null;

  const snap = await db.collection('daily_ritual').doc(today).get();
  let ritual = snap.exists ? snap.data() : null;

  if (!ritual || !ritual.cardText) {
    ritual = await _generateDailyRitual(today, db).catch(err => {
      logger.warn({ err, today }, 'daily_ritual_generate_failed');
      return ritual; // mantém doc antigo se geração falhar
    });
  }

  if (ritual) _dailyCache = { data: ritual, date: today };
  return ritual;
}

// ── Fallbacks usados quando a API Claude não responde ────────────────────────

const _FALLBACK_RITUALS = [
  { title: 'O Peso Silencioso',   text: 'O que você carrega hoje que nunca contou a ninguém?' },
  { title: 'A Escolha Não Feita', text: 'Que decisão você continua adiando, e por quê?' },
  { title: 'O Espelho',           text: 'O que em outra pessoa te incomoda e que também existe em você?' },
  { title: 'A Dívida Invisível',  text: 'Para quem você deveria ligar hoje, mas não vai?' },
  { title: 'O Momento Exato',     text: 'Quando foi a última vez que você foi completamente honesto com alguém?' },
  { title: 'A Fronteira',         text: 'Que limite você exige dos outros mas não coloca em si mesmo?' },
  { title: 'O Não Dito',          text: 'O que você gostaria que alguém soubesse, sem ter que explicar?' },
  { title: 'A Versão Real',       text: 'Quem você seria se não tivesse medo de ser julgado?' },
  { title: 'O Custo',             text: 'O que você está pagando para manter uma versão de si que não é mais você?' },
  { title: 'A Ausência',          text: 'Quem sumiu da sua vida e você ainda pensa nisso?' },
  { title: 'O Limite',            text: 'Qual foi a última vez que você disse não e quis dizer sim?' },
  { title: 'A Inveja Honesta',    text: 'Quem você inveja de verdade, e o que isso te diz sobre você?' },
  { title: 'O Arrependimento',    text: 'Se você pudesse refazer um momento da última semana, qual seria?' },
  { title: 'A Máscara',           text: 'Que versão de você mesma você apresenta que não corresponde a quem você é?' },
];

async function _askClaude(prompt) {
  const Anthropic = require('@anthropic-ai/sdk');
  const apiKey    = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 120,
    messages: [{ role: 'user', content: prompt }],
  });
  return msg.content?.[0]?.text?.trim() || null;
}

async function _generateDailyRitual(dateStr, db) {
  // Contexto do mundo para informar a pergunta
  const [season, events, world] = await Promise.allSettled([
    getActiveSeason(),
    getActiveEvents(),
    require('./worldState').getWorldState().catch(() => null),
  ]);

  const seasonData  = season.status  === 'fulfilled' ? season.value  : null;
  const eventsData  = events.status  === 'fulfilled' ? events.value  : [];
  const worldData   = world.status   === 'fulfilled' ? world.value   : null;

  // Monta contexto descritivo para o Claude
  const dateObj    = new Date(dateStr);
  const weekday    = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'][dateObj.getUTCDay()];
  const progress   = worldData ? Math.round((worldData.communityProgress || 0) * 100) : 0;
  const mission    = worldData?.currentMission?.name || null;
  const eventNames = eventsData.map(e => e.name).filter(Boolean).join(', ') || 'nenhum';

  let seasonCtx = 'sem temporada ativa';
  if (seasonData) {
    const startMs   = seasonData.startAt?.toMillis?.() || 0;
    const endMs     = seasonData.endAt?.toMillis?.()   || 0;
    const totalDays = endMs > startMs ? Math.round((endMs - startMs) / 86400000) : 0;
    const dayIn     = Math.round((Date.now() - startMs) / 86400000);
    const weekIn    = Math.ceil(dayIn / 7);
    const weekTotal = Math.ceil(totalDays / 7);
    seasonCtx = `temporada "${seasonData.name}" — semana ${weekIn} de ${weekTotal}`;
  }

  const prompt = `Você é a voz de um mundo vivo e interativo — um jogo de conexões humanas chamado SextoLugar.

Contexto de hoje (${weekday}, ${dateStr}):
- Mundo: ${seasonCtx}
- Progresso da comunidade: ${progress}%
- Missão ativa: ${mission || 'nenhuma'}
- Eventos: ${eventNames}

Gere UMA pergunta de reflexão individual para o Ritual do Dia. A pergunta:
- É feita para uma pessoa ler sozinha no hub, não em grupo
- É direta, pessoal e provoca desconforto produtivo
- Tem no máximo 2 frases curtas
- Não tem introdução, só a pergunta em si
- Está em português brasileiro

Responda APENAS com a pergunta, sem aspas, sem título, sem explicação.`;

  let cardText    = null;
  let cardTitle   = null;
  let generatedBy = 'claude';

  try {
    cardText = await _askClaude(prompt);
  } catch (err) {
    logger.warn({ err, dateStr }, 'daily_ritual_claude_failed');
  }

  // Fallback determinístico se Claude falhar ou API key ausente
  if (!cardText) {
    const dayNum  = new Date(dateStr).getTime();
    const seed    = _FALLBACK_RITUALS[Math.abs(Math.round(dayNum / 86400000)) % _FALLBACK_RITUALS.length];
    cardText    = seed.text;
    cardTitle   = seed.title;
    generatedBy = 'fallback';
    logger.info({ dateStr }, 'daily_ritual_fallback_used');
  } else {
    const firstWords = cardText.split(/\s+/).slice(0, 3).join(' ').replace(/[^a-zA-ZÀ-ú\s]/g, '').trim();
    cardTitle = firstWords || 'O Ritual';
  }

  const ritual = {
    date:            dateStr,
    cardTitle,
    cardText,
    cardType:        'Ritual',
    challengeType:   'individual',
    bonusXp:         50,
    completionCount: 0,
    expiresAt:       _endOfDayUTC(dateStr),
    createdAt:       new Date(),
    generatedBy,
  };

  await db.collection('daily_ritual').doc(dateStr).set(ritual);
  logger.info({ dateStr, cardTitle, generatedBy: ritual.generatedBy }, 'daily_ritual_generated');
  return ritual;
}

// ── Deck integration ──────────────────────────────────────────────────────────

async function getLivePackIds() {
  const [season, events] = await Promise.all([getActiveSeason(), getActiveEvents()]);
  const ids = new Set();
  (season?.packIds || []).forEach(id => ids.add(id));
  for (const e of events) if (e.bonusCardPackId) ids.add(e.bonusCardPackId);
  return [...ids];
}

// ── Session.ended listener ────────────────────────────────────────────────────

let _initialized = false;

function init() {
  if (_initialized) return;
  _initialized = true;

  const events = require('./events');
  events.on('session.ended', async ({ payload }) => {
    const { roomId, summary, players } = payload || {};
    if (!roomId || !summary) return;

    const ritual = await getDailyRitual().catch(() => null);
    if (!ritual) return;

    const played = (summary.cardCounts?.[ritual.cardTitle] || 0) > 0;
    if (!played) return;

    const db = getDb();
    if (!db) return;

    const authedUids = [...new Set((players || []).map(p => p.userId).filter(Boolean))];
    if (!authedUids.length) return;

    // Hub e sala compartilham o mesmo ledger por UID/data. Assim, jogar a carta
    // no ritual completo depois de descobri-la no Hub (ou o inverso) nunca
    // concede XP, streak ou progresso mundial duas vezes.
    const accountState = require('./accountState');
    const completions = await Promise.all(authedUids.map(async uid => ({
      uid,
      result: await accountState.completeDailyRitual({ db, uid, daily: ritual }),
    })));
    const newlyCompletedUids = completions
      .filter(item => !item.result.alreadyCompleted)
      .map(item => item.uid);

    _dailyCache = null;
    if (newlyCompletedUids.length) {
      await events.emitAsync('live.daily_ritual_completed', {
        roomId, date: ritual.date, cardTitle: ritual.cardTitle,
        authedUids: newlyCompletedUids,
        playerCount: newlyCompletedUids.length,
        source: 'session',
      });
    }

    logger.info({ roomId, date: ritual.date, cardTitle: ritual.cardTitle,
      completed: newlyCompletedUids.length, alreadyCompleted: authedUids.length - newlyCompletedUids.length },
      'daily_ritual_completed');
  });

  // Pre-aquece o ritual do dia no startup
  getDailyRitual().catch(() => {});

  logger.info({}, 'live_service_initialized');
}

// ── Cache invalidation ────────────────────────────────────────────────────────

function invalidate(what = 'all') {
  if (what === 'season' || what === 'all') _seasonCache = null;
  if (what === 'events' || what === 'all') _eventsCache = null;
  if (what === 'daily'  || what === 'all') _dailyCache  = null;
}

module.exports = {
  getActiveSeason, getActiveEvents, getDailyRitual,
  getLivePackIds, init, invalidate,
};
