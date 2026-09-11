"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { templateInstitutionLeadReceived } = require("../services/email");

test("e-mail do lead institucional identifica a oportunidade e escapa conteúdo", () => {
  const result = templateInstitutionLeadReceived({
    name: "Ana <script>alert(1)</script>",
    role: "Direção & mantenedora",
    institution: "Escola <Piloto>",
    institutionType: "private_school",
    students: 450,
    email: "ana@example.com",
    phone: "(51) 99999-9999",
    city: "Torres",
    state: "RS",
    message: "Quero conversar <b>agora</b>."
  });

  assert.match(result.subject, /Escola <Piloto>/);
  assert.match(result.html, /Nova oportunidade institucional/);
  assert.match(result.html, /Escola particular/);
  assert.match(result.html, /Escola &lt;Piloto&gt;/);
  assert.match(result.html, /Ana &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(result.html.includes("<script>alert(1)</script>"), false);
  assert.match(result.text, /Alunos: 450/);
});
