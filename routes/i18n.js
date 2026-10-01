"use strict";
// Tradução automática do Espaço Prelúdio (pt-BR → en-US / es-ES).
//
// Usado pela automação do repositório do site (GitHub Actions): a cada push,
// o script de sincronização encontra textos novos e pede a tradução aqui.
// A chave da Anthropic nunca sai do servidor; o CI só conhece I18N_CI_TOKEN.
//
//   POST /i18n/translate        (X-I18N-Token) { strings: [pt...] } → { en: {pt: en}, es: {pt: es} }
//   GET  /i18n/server-strings   (X-I18N-Token) → textos de conteúdo do servidor (trilhas) para traduzir

const crypto = require("crypto");
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const corporateDevelopment = require("../services/corporate-development");
const studentDevelopment = require("../services/student-development");

const router = express.Router();
const MODEL = "claude-sonnet-5-5";
const MAX_STRINGS = 120;
const MAX_CHARS = 2000;

let _client = null;
function client() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 120_000, maxRetries: 2 });
  return _client;
}

function authorized(req) {
  const expected = process.env.I18N_CI_TOKEN || "";
  const got = String(req.get("X-I18N-Token") || "");
  if (expected.length < 32 || got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

const SYSTEM = `You translate UI strings for "Espaço Prelúdio", a Brazilian telepsychology / mental-health platform (therapists, patients, schools, companies, employees).
Input: JSON {"strings": [Portuguese texts]}. Output ONLY JSON: {"en": [...], "es": [...]} — arrays in the same order and length as the input. No commentary, no code fences.
Rules:
- English: natural US English. Spanish: neutral Spanish using the informal "tú", as in the rest of the app.
- Preserve every HTML tag and attribute exactly; translate only human-readable text. Keep empty tags (<span></span>, <i></i>) in place.
- Keep placeholders like {0}, {1}, {{name}}, \${x}, %s, emojis, arrows, numbers, URLs and e-mails unchanged. A placeholder that only appends a Portuguese plural suffix may be dropped.
- Never translate the brand "Espaço Prelúdio" / "Prelúdio" / "Projeto Lemniscata". Keep LGPD, NR-1, AEP, PGR, PCMSO, CRP, CRM, CFP, CPF, CNPJ, PIX/Pix, SAMU, CVV, TISS, TUSS as-is.
- Concise, warm, professional UI tone; keep capitalization style (ALL CAPS stays ALL CAPS).`;

async function translateBatch(strings) {
  const c = client();
  if (!c) throw Object.assign(new Error("ANTHROPIC_NAO_CONFIGURADO"), { status: 503 });
  const res = await c.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    messages: [{ role: "user", content: JSON.stringify({ strings }) }]
  });
  const text = (res.content || []).map(b => b.text || "").join("").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const out = JSON.parse(text);
  if (!Array.isArray(out.en) || !Array.isArray(out.es) || out.en.length !== strings.length || out.es.length !== strings.length) {
    throw new Error("RESPOSTA_INVALIDA");
  }
  const en = {}, es = {};
  strings.forEach((pt, i) => {
    if (typeof out.en[i] === "string" && out.en[i]) en[pt] = out.en[i];
    if (typeof out.es[i] === "string" && out.es[i]) es[pt] = out.es[i];
  });
  return { en, es };
}

router.post("/i18n/translate", async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: "NAO_AUTORIZADO" });
  const strings = Array.isArray(req.body?.strings) ? req.body.strings : [];
  const clean = [...new Set(strings.filter(s => typeof s === "string" && s.trim() && s.length <= MAX_CHARS))].slice(0, MAX_STRINGS);
  if (!clean.length) return res.status(400).json({ ok: false, error: "SEM_TEXTOS" });
  try {
    const result = await translateBatch(clean);
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(err.status || 502).json({ ok: false, error: err.message || "FALHA_TRADUCAO" });
  }
});

// Textos de conteúdo que moram no servidor (trilhas educativas) e aparecem
// nas telas via API — o site precisa deles no dicionário de tradução.
function collectStrings(value, out) {
  if (typeof value === "string") {
    const t = value.replace(/\s+/g, " ").trim();
    if (/[A-Za-zÀ-ÿ]{3,}/.test(t) && /\s/.test(t) && !/^https?:/.test(t)) out.add(t);
  } else if (Array.isArray(value)) value.forEach(v => collectStrings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach(v => collectStrings(v, out));
  return out;
}

router.get("/i18n/server-strings", (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: "NAO_AUTORIZADO" });
  const out = new Set();
  collectStrings(corporateDevelopment.TRACKS, out);
  collectStrings(studentDevelopment.ITEMS, out);
  return res.json({ ok: true, strings: [...out] });
});

module.exports = router;
module.exports._test = { collectStrings, authorized };
