"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname, "../routes/therapy.js"), "utf8");
const start = source.indexOf("  if (Array.isArray(req.body?.sessionTopics))");
const code = source.slice(start, source.indexOf('\n  await getDb()', start));

test("profile saves disabled topics and custom selection with bounded input", () => {
  const updates = {};
  vm.runInNewContext(code, { updates, crypto: require("node:crypto"), req: { body: {
    sessionTopics: [{ id: "mine", text: " Question ", abord: "tcc", enabled: false }, { text: "Enabled" }],
    disabledSessionTopics: ["tcc:Question", "tcc:Question", null, "x".repeat(501)]
  } } });
  assert.equal(updates.sessionTopics[0].text, "Question");
  assert.equal(updates.sessionTopics[0].enabled, false);
  assert.equal(updates.sessionTopics[0].abord, "custom");
  assert.equal(updates.sessionTopics[1].enabled, true);
  assert.equal(JSON.stringify(updates.disabledSessionTopics), '["tcc:Question"]');
});

test("omitted preferences stay untouched and empty arrays reset selections", () => {
  for (const body of [{}, { sessionTopics: [], disabledSessionTopics: [] }]) {
    const updates = {};
    vm.runInNewContext(code, { updates, req: { body } });
    assert.equal(JSON.stringify(updates), JSON.stringify(body));
  }
});
