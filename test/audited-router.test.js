"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const firestore = require("../services/firestore");
const { auditedRouter } = require("../middleware/auditLog");

// O middleware guarda o banco em cache na primeira gravação: um só banco falso.
const entries = [];
const fakeDb = { collection() { return { add: async row => { entries.push(row); } }; } };

test("each request is audited once, under the router that answered it", async t => {
  entries.length = 0;
  t.mock.method(firestore, "getDb", () => fakeDb);

  const app = express();
  for (const name of ["recording", "payment", "ritual"]) {
    const router = express.Router();
    router.post(`/${name}/acao`, (req, res) => res.json({ ok: true }));
    app.use(auditedRouter(name, router));
  }
  app.use((req, res) => res.status(404).end());

  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  await fetch(`${base}/ritual/acao`, { method: "POST" });
  await fetch(`${base}/payment/acao`, { method: "POST" });
  await fetch(`${base}/nenhum/router`, { method: "POST" });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(entries.map(e => `${e.category} ${e.path}`), ["ritual /ritual/acao", "payment /payment/acao"]);
});

test("wrapped routers stay visible to route walkers (rate-limit buckets, DUMP_ROUTES)", () => {
  const router = express.Router();
  router.get("/x", (req, res) => res.end());
  assert.equal(auditedRouter("x", router).stack, router.stack);
});

test("errors raised inside a router are still audited under that router", async t => {
  entries.length = 0;
  t.mock.method(firestore, "getDb", () => fakeDb);

  const app = express();
  const router = express.Router();
  router.post("/admin/quebra", () => { throw new Error("falha"); });
  app.use(auditedRouter("admin", router));
  app.use((err, req, res, next) => res.status(500).end()); // eslint-disable-line no-unused-vars

  const server = app.listen(0);
  t.after(() => server.close());
  await fetch(`http://127.0.0.1:${server.address().port}/admin/quebra`, { method: "POST" });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(entries.length, 1);
  assert.equal(entries[0].category, "admin");
  assert.equal(entries[0].statusCode, 500);
});
