"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const maintenance = require("../middleware/clinicalMaintenance");

test("maintenance stops clinical requests and webhooks before their handlers, preserving health checks", async () => {
  const previous = process.env.CLINICAL_MAINTENANCE;
  process.env.CLINICAL_MAINTENANCE = "true";
  const app = express();
  let writes = 0;
  app.use(maintenance);
  app.get("/health", (req, res) => res.json({ ok: true }));
  app.all("*", (req, res) => { writes++; res.json({ ok: true }); });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [method, path] of [["GET", "/public/profissionais"], ["PATCH", "/therapy/perfil"], ["POST", "/stripe/webhook"]]) {
      const response = await fetch(base + path, { method });
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("retry-after"), "60");
      assert.equal((await response.json()).error, "MANUTENCAO_PROGRAMADA");
    }
    assert.equal(writes, 0);
    assert.deepEqual(await (await fetch(base + "/health")).json(), { ok: true });
    delete process.env.CLINICAL_MAINTENANCE;
    assert.equal((await fetch(base + "/public/profissionais")).status, 200);
    assert.equal(writes, 1);
  } finally {
    if (previous === undefined) delete process.env.CLINICAL_MAINTENANCE;
    else process.env.CLINICAL_MAINTENANCE = previous;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
