// Dicionário de tradução dos e-mails (pt-BR → en-US / es-ES).
//
// Coleta os textos em português do código que monta e-mails, pede a tradução
// ao endpoint /i18n/translate (X-I18N-Token) e grava i18n/server/{lng}.json.
// Roda no GitHub Actions a cada push e diariamente; sem I18N_CI_TOKEN só
// lista o que falta traduzir.
import { parse } from "acorn";
import { simple } from "acorn-walk";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = process.env.I18N_API || "https://osl-video-server-production.up.railway.app";
const TOKEN = process.env.I18N_CI_TOKEN || "";
const OUT_DIR = join(ROOT, "i18n", "server");
const LANGS = ["en-US", "es-ES"];

// Arquivos cujo texto inteiro vai para e-mails; em routes/therapy.js, só o
// que está dentro de chamadas sendEmail(...).
const WHOLE_FILES = ["services/email.js", "services/scheduler.js"];
const CALL_ONLY_FILES = ["routes/therapy.js", "routes/nr1.js"];

const norm = s => s.replace(/\s+/g, " ").trim();
const PT_HINT = /[ãõçáéíóúâêôàÃÕÇÁÉÍÓÚÂÊÔ]|\b(de|do|da|não|para|com|sua|seu|você|uma|um|ao|na|no|em|por|que|ou|é|está|sem|mais|até)\b/i;
function human(s) {
  const t = norm(s);
  const bare = t.replace(/\{\d+\}/g, " ").trim();
  if (bare.length < 2 || !/[A-Za-zÀ-ÿ]{2,}/.test(bare)) return false;
  if (/^(https?:|\/|#|mailto:)/.test(t) || /\{\d+\}\/|\/\{\d+\}/.test(t)) return false;
  if (/[;=]|=>|\bfunction\b|^[\w.-]+$/.test(bare) && !PT_HINT.test(bare)) return false;
  if (/^[a-z-]+:\s?[^ {]+;?$/.test(t) || /:\s*\d+px|#[0-9a-f]{3,6}\b|font-|border|padding|margin/i.test(t)) return false; // CSS inline
  return PT_HINT.test(bare) || /\s/.test(bare) || /^[A-ZÀ-Ý][a-zà-ÿ]+[:.!?]?$/.test(bare);
}
function fragments(node) {
  // Percorre o template caractere a caractere: tags podem conter ${} (ex.:
  // <a href="${url}">Texto</a>), então o estado "dentro de tag" atravessa
  // os pedaços. Texto entre tags vira fragmento; ${} no texto vira {N}.
  const parts = [];
  let buf = "", idx = 0, inTag = false;
  const flush = () => {
    if (buf.trim()) {
      parts.push(buf);
      // Texto puro com quebras de linha: cada linha também vira entrada.
      if (buf.includes("\n")) {
        let n = 0;
        for (const line of buf.split("\n")) {
          const renum = line.replace(/\{\d+\}/g, () => `{${n++}}`);
          if (renum.trim()) parts.push(renum);
        }
      }
    }
    buf = ""; idx = 0;
  };
  node.quasis.forEach((q, i) => {
    for (const ch of (q.value.cooked ?? q.value.raw)) {
      if (inTag) { if (ch === ">") inTag = false; continue; }
      if (ch === "<") { flush(); inTag = true; continue; }
      buf += ch;
    }
    if (i < node.expressions.length && !inTag) buf += `{${idx++}}`;
  });
  flush();
  return parts.map(norm).filter(human);
}
function collect(node, out) {
  simple(node, {
    Literal(n) {
      if (typeof n.value !== "string") return;
      for (const p of n.value.split(/<[^>]*>/)) if (human(p)) out.add(norm(p));
    },
    TemplateLiteral(n) { fragments(n).forEach(f => out.add(f)); }
  });
}

const strings = new Set();
for (const rel of [...WHOLE_FILES, ...CALL_ONLY_FILES]) {
  const file = join(ROOT, rel);
  if (!existsSync(file)) continue;
  const ast = parse(readFileSync(file, "utf8"), { ecmaVersion: "latest", sourceType: "script", allowHashBang: true, allowReturnOutsideFunction: true });
  if (WHOLE_FILES.includes(rel)) { collect(ast, strings); continue; }
  simple(ast, {
    CallExpression(n) {
      const name = n.callee.type === "Identifier" ? n.callee.name : n.callee.property?.name;
      if (name === "sendEmail") n.arguments.forEach(a => collect(a, strings));
    }
  });
}

const dicts = Object.fromEntries(LANGS.map(l => [l, existsSync(join(OUT_DIR, `${l}.json`)) ? JSON.parse(readFileSync(join(OUT_DIR, `${l}.json`), "utf8")) : {}]));
const sourcePath = join(OUT_DIR, "source.json");
const known = new Set(existsSync(sourcePath) ? JSON.parse(readFileSync(sourcePath, "utf8")) : []);
const todo = [...strings].filter(s => !known.has(s));
console.log(`textos de e-mail: ${strings.size} · novos: ${todo.length}`);
if (!todo.length) process.exit(0);
if (!TOKEN) { console.log("I18N_CI_TOKEN ausente — tradução não executada."); process.exit(0); }

const PH = /\{\d+\}/g;
const ok = (pt, tr) => {
  const allowed = new Set(pt.match(PH) || []);
  return !(tr.match(PH) || []).some(x => !allowed.has(x)) && !(allowed.has("{0}") && !tr.includes("{0}"));
};
for (let i = 0; i < todo.length; i += 80) {
  const batch = todo.slice(i, i + 80);
  let d;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(`${API}/i18n/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-I18N-Token": TOKEN },
        body: JSON.stringify({ strings: batch })
      });
      d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
      break;
    } catch (err) {
      console.warn(`lote ${i / 80 + 1} tentativa ${attempt}: ${err.message}`);
      if (attempt === 3) throw err;
    }
  }
  for (const pt of batch) {
    if (d.en[pt] && ok(pt, d.en[pt])) dicts["en-US"][pt] = d.en[pt];
    if (d.es[pt] && ok(pt, d.es[pt])) dicts["es-ES"][pt] = d.es[pt];
    known.add(pt);
  }
}
mkdirSync(OUT_DIR, { recursive: true });
for (const l of LANGS) writeFileSync(join(OUT_DIR, `${l}.json`), JSON.stringify(dicts[l], null, 1) + "\n");
writeFileSync(sourcePath, JSON.stringify([...known].sort(), null, 0) + "\n");
console.log(`traduzidos: ${todo.length}`);
