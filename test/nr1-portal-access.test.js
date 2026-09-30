"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("consulta de campanhas exibe estado vazio sem liberar submissão sem vínculo", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "routes", "nr1.js"), "utf8");
  assert.match(source, /employee\(req, res, \{ allowUnlinked: true \}\)/);
  assert.match(source, /if \(!companyIds\.length && allowUnlinked\) return \{ uid, companyIds: \[\] \}/);
  assert.match(source, /router\.post\("\/therapy\/paciente\/nr1\/campaigns\/:id\/responses"[\s\S]*?employee\(req, res\);/);
});
