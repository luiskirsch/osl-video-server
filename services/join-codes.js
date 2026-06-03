// Espaço Prelúdio — short codes pra links de paciente.
//
// JWT do joinToken tem ~500 chars; URL `entrar.html?t=<jwt>` fica feia e
// passa cara de phishing/golpe. Mapeamos cada joinToken pra um código de 8
// chars (base32 sem ambiguidade) armazenado em `therapy_session_join_codes`.
// URL final: `entrar.html?c=K9RTPX73` (~50 chars).
//
// JWT continua sendo fonte da verdade — o code é só um índice opaco. Não
// substitui o token: o backend resolve `code → token` antes de validar.

const crypto = require("crypto");
const admin = require("firebase-admin");
const { getDb } = require("./firestore");

const JOIN_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // 32 chars, sem 0/O/1/I/L
const JOIN_CODE_LEN = 8;
const DEFAULT_VALIDITY_MS = 2 * 60 * 60 * 1000; // 2h, bate com JOIN_TOKEN_VALIDITY_MS

function generateJoinCode() {
  const bytes = crypto.randomBytes(JOIN_CODE_LEN);
  let out = "";
  for (let i = 0; i < JOIN_CODE_LEN; i++) {
    out += JOIN_CODE_ALPHABET[bytes[i] % JOIN_CODE_ALPHABET.length];
  }
  return out;
}

// Cria short code novo apontando pro joinToken. Tenta até 5x em colisão.
async function createJoinCode({ joinToken, sessionId, expiresAt }) {
  const db = getDb();
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateJoinCode();
    const ref = db.collection("therapy_session_join_codes").doc(code);
    try {
      await ref.create({
        joinToken,
        sessionId,
        expiresAt: expiresAt || (Date.now() + DEFAULT_VALIDITY_MS),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return code;
    } catch (e) {
      if (e?.code !== 6 && !/already exists/i.test(e?.message || "")) throw e;
    }
  }
  throw new Error("JOIN_CODE_GEN_FALHOU");
}

// Resolve code → joinToken (ou null se expirou / não existe / código inválido).
async function resolveJoinCode(code) {
  if (!code || typeof code !== "string") return null;
  const clean = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,16}$/.test(clean)) return null;
  const snap = await getDb().collection("therapy_session_join_codes").doc(clean).get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (data.expiresAt && data.expiresAt < Date.now()) return null;
  return data.joinToken || null;
}

// ─── Short codes genéricos para cancel/confirm tokens ───────────────────────
// Mesma mecânica dos join codes mas coleção separada (therapy_session_action_codes)
// pra evitar colisão e permitir TTL diferente (60 dias vs 2h).

const ACTION_CODE_VALIDITY_MS = 60 * 24 * 60 * 60 * 1000; // 60 dias (bate com CANCEL_TOKEN_VALIDITY_MS)

async function createActionCode({ token, type }) {
  const db = getDb();
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateJoinCode(); // mesmo alfabeto/tamanho
    const ref = db.collection("therapy_session_action_codes").doc(code);
    try {
      await ref.create({
        token,
        type,
        expiresAt: Date.now() + ACTION_CODE_VALIDITY_MS,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return code;
    } catch (e) {
      if (e?.code !== 6 && !/already exists/i.test(e?.message || "")) throw e;
    }
  }
  throw new Error("ACTION_CODE_GEN_FALHOU");
}

async function resolveActionCode(code) {
  if (!code || typeof code !== "string") return null;
  const clean = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,16}$/.test(clean)) return null;
  const snap = await getDb().collection("therapy_session_action_codes").doc(clean).get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (data.expiresAt && data.expiresAt < Date.now()) return null;
  return { token: data.token, type: data.type };
}

module.exports = { createJoinCode, resolveJoinCode, createActionCode, resolveActionCode };
