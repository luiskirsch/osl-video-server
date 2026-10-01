"use strict";
// Tradução de textos gerados pelo servidor (e-mails) para en-US / es-ES.
//
// Os modelos continuam escritos em português. Depois de montados, o texto
// visível é traduzido por um dicionário pt → idioma (i18n/server/{lng}.json),
// gerado automaticamente a partir do código pela CI — nenhum dado de usuário
// passa pela tradução automática. Entradas com {0}, {1}… são padrões: o valor
// dinâmico (nome, data, link) é preservado.
//
// Datas: modelos usam dateMarker(ms); o envio troca a marca pela data
// formatada no idioma do destinatário.

const fs = require("fs");
const path = require("path");

const DICT_DIR = path.join(__dirname, "..", "i18n", "server");
const INTL = { "pt-BR": "pt-BR", "en-US": "en-US", "es-ES": "es-ES" };
const cache = new Map();

const norm = s => s.replace(/\s+/g, " ").trim();
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function dictionary(locale) {
  if (cache.has(locale)) return cache.get(locale);
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(path.join(DICT_DIR, `${locale}.json`), "utf8")); } catch { /* sem dicionário */ }
  const exact = new Map();
  const patterns = [];
  for (const [pt, tr] of Object.entries(raw)) {
    if (typeof tr !== "string" || !tr) continue;
    if (!/\{\d+\}/.test(pt)) { exact.set(pt, tr); continue; }
    const order = [];
    const src = pt.split(/(\{\d+\})/).map(part => {
      const m = part.match(/^\{(\d+)\}$/);
      if (m) { order.push(m[1]); return "([\\s\\S]+?)"; }
      return escapeRe(part);
    }).join("");
    patterns.push({ re: new RegExp("^" + src + "$"), order, tr, weight: pt.replace(/\{\d+\}/g, "").length });
  }
  patterns.sort((a, b) => b.weight - a.weight);
  const d = { exact, patterns };
  cache.set(locale, d);
  return d;
}

function translateSegment(text, d) {
  const key = norm(text);
  if (key.length < 2 || !/[A-Za-zÀ-ÿ]/.test(key)) return null;
  const hit = d.exact.get(key);
  if (hit !== undefined) return hit;
  for (const p of d.patterns) {
    const m = key.match(p.re);
    if (!m) continue;
    const values = {};
    p.order.forEach((n, i) => { values[n] = m[i + 1]; });
    return p.tr.replace(/\{(\d+)\}/g, (_, n) => {
      const v = values[n] ?? "";
      const inner = d.exact.get(norm(v));
      return inner !== undefined ? inner : v;
    });
  }
  return null;
}

function keepSpacing(original, translated) {
  return original.match(/^\s*/)[0] + translated + original.match(/\s*$/)[0];
}

// Texto simples: tenta o texto inteiro, depois linha a linha.
function translateText(text, locale) {
  if (!text || !INTL[locale] || locale === "pt-BR") return text;
  const d = dictionary(locale);
  const whole = translateSegment(text, d);
  if (whole != null) return keepSpacing(text, whole);
  return String(text).split("\n").map(line => {
    const t = translateSegment(line, d);
    return t != null ? keepSpacing(line, t) : line;
  }).join("\n");
}

// HTML: traduz cada trecho de texto entre tags (conteúdo de <style> intacto).
function translateHtml(html, locale) {
  if (!html || !INTL[locale] || locale === "pt-BR") return html;
  const d = dictionary(locale);
  let inStyle = false;
  return String(html).split(/(<[^>]+>)/).map(part => {
    if (part.startsWith("<")) {
      if (/^<style\b/i.test(part)) inStyle = true;
      else if (/^<\/style/i.test(part)) inStyle = false;
      return part;
    }
    if (inStyle || !part.trim()) return part;
    const t = translateSegment(part, d);
    return t != null ? keepSpacing(part, t) : part;
  }).join("");
}

// ─── Datas no idioma do destinatário ──────────────────────────────────────
const MARK = /⟦(dt|d):(\d+)⟧/g;
function dateMarker(ms, { dateOnly = false } = {}) { return `⟦${dateOnly ? "d" : "dt"}:${Number(ms) || 0}⟧`; }
function formatDate(ms, locale, dateOnly) {
  const opts = dateOnly
    ? { day: "2-digit", month: "long", year: "numeric", timeZone: "America/Sao_Paulo" }
    : { weekday: "long", day: "2-digit", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" };
  return new Date(Number(ms)).toLocaleString(INTL[locale] || "pt-BR", opts);
}
function resolveDates(text, locale) {
  return text == null ? text : String(text).replace(MARK, (_, kind, ms) => formatDate(ms, locale, kind === "d"));
}

// Aplica idioma a uma mensagem montada em português.
function localizeMessage({ subject, html, text }, locale) {
  const tr = (fn, v) => (v == null ? v : resolveDates(fn(v, locale), locale));
  return { subject: tr(translateText, subject), html: tr(translateHtml, html), text: tr(translateText, text) };
}

module.exports = { translateText, translateHtml, localizeMessage, dateMarker, resolveDates, _resetCache: () => cache.clear() };
