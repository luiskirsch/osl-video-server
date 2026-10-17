"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Uma instância sem e-mail configurado (ex.: cópia antiga do backend) recebia
// "skipped" do sendEmail e marcava lembrete/NPS/aniversário como enviados;
// a instância que entrega e-mail então não enviava nada.
const source = fs.readFileSync(path.join(__dirname, "..", "services", "scheduler.js"), "utf8");

test("envio 'skipped' nunca conta como enviado no agendador", () => {
  assert.doesNotMatch(source, /(result|r)\.ok \|\| (result|r)\.skipped/);
  assert.match(source, /npsSentAt: admin\.firestore\.FieldValue\.delete\(\)/);
});

test("agendador não inicia sem e-mail configurado", () => {
  const start = source.slice(source.indexOf("function startSchedulerLoop"));
  assert.match(start, /if \(!RESEND_API_KEY\) \{\s*logWarn\("scheduler_desativado_sem_email"/);
  assert.ok(start.indexOf("RESEND_API_KEY") < start.indexOf("startJoinPushLoop"), "a checagem vem antes de qualquer loop");
});
