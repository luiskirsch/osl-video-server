"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Dicionário de teste isolado (o real é gerado pela CI).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ep-i18n-"));
fs.writeFileSync(path.join(dir, "en-US.json"), JSON.stringify({
  "Sua consulta foi confirmada": "Your session has been confirmed",
  "Olá, {0}!": "Hi, {0}!",
  "Consulta com {0} em {1}": "Session with {0} on {1}"
}));

test("e-mail em inglês: texto, padrões e data no idioma do destinatário", () => {
  const realRead = fs.readFileSync;
  fs.readFileSync = (p, ...a) => (String(p).includes(path.join("i18n", "server")) ? realRead(path.join(dir, path.basename(p)), ...a) : realRead(p, ...a));
  try {
    const { localizeMessage, dateMarker, _resetCache } = require("../services/server-i18n");
    _resetCache();
    const when = dateMarker(Date.UTC(2026, 9, 6, 18, 0));
    const out = localizeMessage({
      subject: "Sua consulta foi confirmada",
      html: `<p>Olá, Ana!</p><p>Consulta com Dr. Luis em ${when}</p><p>Texto sem tradução</p>`,
      text: `Olá, Ana!\nConsulta com Dr. Luis em ${when}`
    }, "en-US");
    assert.equal(out.subject, "Your session has been confirmed");
    assert.match(out.html, /<p>Hi, Ana!<\/p>/);
    assert.match(out.html, /Session with Dr\. Luis on Tuesday, October 06/);
    assert.match(out.html, /<p>Texto sem tradução<\/p>/, "sem entrada no dicionário, mantém o português");
    assert.match(out.text, /^Hi, Ana!\nSession with Dr\. Luis on Tuesday/);
  } finally {
    fs.readFileSync = realRead;
  }
});

test("pt-BR não altera o texto, só formata a data", () => {
  const { localizeMessage, dateMarker } = require("../services/server-i18n");
  const out = localizeMessage({ subject: "Olá", html: `<p>${dateMarker(Date.UTC(2026, 9, 6, 18, 0), { dateOnly: true })}</p>` }, "pt-BR");
  assert.equal(out.subject, "Olá");
  assert.equal(out.html, "<p>06 de outubro de 2026</p>");
});
