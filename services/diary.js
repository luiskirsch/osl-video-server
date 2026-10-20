"use strict";
const crypto = require("node:crypto");
const { encryptJson, decryptJson } = require("./clinical-encryption");

const FEELINGS = ["serenidade", "nostalgia", "alegria", "gratidao", "tristeza", "ansiedade", "cansaco"];
const AROMAS = ["", "lavanda", "cafe", "chuva", "laranja", "madeira"];
const FONTS = ["hand", "classic", "simple"];
const WEATHER = ["", "clear", "cloudy", "rain", "storm", "snow", "fog"];

function invalid(message = "REGISTRO_INVALIDO") {
  throw Object.assign(new Error(message), { status: 400 });
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const parsed = new Date(value + "T12:00:00Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function normalize(input, today) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !["diary", "dream", "capsule"].includes(input.kind)) invalid();
  if (typeof input.text !== "string" || input.text.length > 20000) invalid("TEXTO_INVALIDO");
  if (!validDate(input.date) || input.date > today) invalid("DATA_INVALIDA");
  if (input.kind === "capsule") {
    if (!validDate(input.unlockDate) || input.unlockDate <= today) invalid("ABERTURA_INVALIDA");
  } else if (input.unlockDate != null) invalid("ABERTURA_INVALIDA");
  if (!Number.isSafeInteger(input.version) || input.version < 0 || input.version === Number.MAX_SAFE_INTEGER) invalid("VERSAO_INVALIDA");
  if (!Array.isArray(input.feelings) || input.feelings.length > 3 || input.feelings.some(value => !FEELINGS.includes(value))) invalid("SENTIMENTO_INVALIDO");
  if (!Array.isArray(input.tags) || input.tags.length > 6 || input.tags.some(value => typeof value !== "string" || value.length > 30)) invalid("MARCADORES_INVALIDOS");
  const aroma = input.aroma === undefined ? "" : input.aroma;
  const aromaText = input.aromaText === undefined ? "" : input.aromaText;
  const font = input.font === undefined ? "hand" : input.font;
  const weather = input.weather === undefined ? "" : input.weather;
  const sealed = input.sealed === undefined ? false : input.sealed;
  if (typeof sealed !== "boolean") invalid("SELO_INVALIDO");
  if (!AROMAS.includes(aroma)) invalid("AROMA_INVALIDO");
  if (typeof aromaText !== "string" || aromaText.length > 100 || /[\u0000-\u001f\u007f]/.test(aromaText)) invalid("AROMA_INVALIDO");
  if (!FONTS.includes(font)) invalid("CALIGRAFIA_INVALIDA");
  if (!WEATHER.includes(weather)) invalid("CLIMA_INVALIDO");
  const text = input.text.trim();
  const feelings = [...new Set(input.feelings)];
  const tags = [...new Set(input.tags.map(value => value.replace(/^#/, "").trim()).filter(Boolean))];
  const customAroma = aroma ? "" : aromaText.trim();
  const hasMemory = Boolean(text || feelings.length || tags.length || aroma || customAroma || weather || font !== "hand");
  if (input.kind === "capsule" && !text) invalid("TEXTO_INVALIDO");
  if (input.kind !== "capsule" && !hasMemory && input.version === 0) invalid("TEXTO_INVALIDO");
  return {
    kind: input.kind, text, date: input.date,
    unlockDate: input.kind === "capsule" ? input.unlockDate : null,
    feelings, tags, aroma, aromaText: customAroma, font, weather,
    // Guardar o dia é um gesto da pessoa, não consequência de ter salvo:
    // sem escrita não há dia para selar.
    sealed: sealed && Boolean(text),
  };
}

function keyFor(uid, secret) {
  if (typeof secret !== "string" || secret.length < 16) throw Object.assign(new Error("DIARIO_INDISPONIVEL"), { status: 503 });
  return Buffer.from(crypto.hkdfSync("sha256", secret, Buffer.from(uid), "ep:personal-diary:v1", 32));
}

function seal(uid, payload, secret) {
  const key = keyFor(uid, secret);
  try { return encryptJson(payload, key); }
  finally { key.fill(0); }
}

function open(uid, payload, secret) {
  const key = keyFor(uid, secret);
  try { return decryptJson(payload, key); }
  finally { key.fill(0); }
}

function view(uid, id, record, secret, today) {
  // Capsule release dates are authenticated inside the ciphertext. Altering
  // searchable metadata must never reveal a sealed capsule early.
  const payload = open(uid, record.payload, secret);
  if (payload.kind !== record.kind || payload.date !== record.date || payload.unlockDate !== record.unlockDate) {
    throw new Error("REGISTRO_CIFRADO_INVALIDO");
  }
  const common = {
    id, kind: payload.kind, date: payload.date, unlockDate: payload.unlockDate,
    version: record.version, createdAt: record.createdAt, updatedAt: record.updatedAt,
  };
  if (payload.kind === "capsule" && payload.unlockDate > today) return { ...common, locked: true };
  return { ...payload, ...common, locked: false };
}

const COVER_TITLE_MAX = 40;

// O nome da capa é escrita da pessoa, não configuração: viaja cifrado como
// o resto do diário e mora no documento do próprio diário.
function normalizeCover(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("CAPA_INVALIDA");
  const raw = input.title === undefined || input.title === null ? "" : input.title;
  if (typeof raw !== "string" || /[\u0000-\u001f\u007f]/.test(raw)) invalid("CAPA_INVALIDA");
  const title = raw.replace(/\s+/g, " ").trim();
  if (title.length > COVER_TITLE_MAX) invalid("CAPA_INVALIDA");
  return { title };
}

function ownerOf(uid) {
  return crypto.createHash("sha256").update(uid).digest("hex");
}

function diaryFor(db, uid) {
  return db.collection("therapy_diaries").doc(ownerOf(uid));
}

function entriesFor(db, uid) {
  return diaryFor(db, uid).collection("entries");
}

async function deleteForAccount(db, uid) {
  const entries = entriesFor(db, uid);
  let deleted = 0;
  // Firestore retains subcollections when their parent document is removed.
  for (;;) {
    const snapshot = await entries.limit(400).get();
    if (!snapshot.docs.length) break;
    const batch = db.batch();
    for (const doc of snapshot.docs) batch.delete(doc.ref);
    await batch.commit();
    deleted += snapshot.docs.length;
  }
  // O documento do diário guarda o nome da capa cifrado: some junto.
  const cover = db.batch();
  cover.delete(diaryFor(db, uid));
  await cover.commit();
  return deleted;
}

module.exports = { normalize, normalizeCover, seal, open, view, validDate, diaryFor, entriesFor, deleteForAccount, COVER_TITLE_MAX };
