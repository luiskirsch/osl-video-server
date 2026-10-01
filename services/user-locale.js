"use strict";
// Idioma preferido de cada usuário (pt-BR / en-US / es-ES).
//
// O site envia o idioma escolhido no header X-Locale em toda chamada; quando a
// chamada é autenticada, guardamos { locale, email } em user_locales/{uid}.
// Na hora de enviar um e-mail, o idioma do destinatário é buscado pelo
// endereço. Sem registro, vale pt-BR.

const admin = require("firebase-admin");

const SUPPORTED = new Set(["pt-BR", "en-US", "es-ES"]);
const DEFAULT_LOCALE = "pt-BR";
const COLLECTION = "user_locales";

const lastSaved = new Map();     // uid → locale já gravado (evita escrita a cada request)
const byEmail = new Map();       // email → { locale, at }
const EMAIL_CACHE_MS = 10 * 60 * 1000;

function normalizeLocale(value) {
  const v = String(value || "").trim();
  return SUPPORTED.has(v) ? v : null;
}

function db() {
  try { return admin.apps.length ? admin.firestore() : null; } catch { return null; }
}

// Chamado após validar o token Firebase. Nunca bloqueia nem falha a request.
function rememberLocale(decoded, headerValue) {
  const locale = normalizeLocale(headerValue);
  const uid = decoded?.uid;
  if (!locale || !uid || lastSaved.get(uid) === locale) return;
  const store = db();
  if (!store) return;
  lastSaved.set(uid, locale);
  const email = String(decoded.email || "").trim().toLowerCase() || null;
  if (email) byEmail.set(email, { locale, at: Date.now() });
  store.collection(COLLECTION).doc(uid).set({
    locale, email, updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true }).catch(() => lastSaved.delete(uid));
}

async function localeForEmail(email) {
  const key = String(email || "").trim().toLowerCase();
  if (!key) return DEFAULT_LOCALE;
  const cached = byEmail.get(key);
  if (cached && Date.now() - cached.at < EMAIL_CACHE_MS) return cached.locale;
  const store = db();
  if (!store) return DEFAULT_LOCALE;
  try {
    const snap = await store.collection(COLLECTION).where("email", "==", key).limit(1).get();
    const locale = normalizeLocale(snap.docs[0]?.data()?.locale) || DEFAULT_LOCALE;
    byEmail.set(key, { locale, at: Date.now() });
    return locale;
  } catch {
    return DEFAULT_LOCALE;
  }
}

module.exports = { rememberLocale, localeForEmail, normalizeLocale, DEFAULT_LOCALE };
