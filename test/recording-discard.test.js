"use strict";
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || "x".repeat(48);
process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || "y".repeat(48);

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { signHostToken } = require("../services/auth");
const recordingRouter = require("../routes/recording");

async function withServer(t) {
  const app = express();
  app.use(express.json());
  app.use(recordingRouter);
  const server = app.listen(0);
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}
const post = (base, body, headers = {}) => fetch(`${base}/recording/discard`, {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
});

test("the room host can discard the room recording with its host token", async t => {
  const base = await withServer(t);
  const res = await post(base, { roomId: "ABCDE", hostToken: signHostToken("ABCDE") });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, was_active: false });
});

test("discard without host token asks for one; another room's token is refused", async t => {
  const base = await withServer(t);
  const anonymous = await post(base, { roomId: "ABCDE" });
  assert.equal(anonymous.status, 403);
  assert.match(JSON.stringify(await anonymous.json()), /HOST_TOKEN_OBRIGATORIO/);

  const otherRoom = await post(base, { roomId: "ABCDE", hostToken: signHostToken("ZZZZZ") });
  assert.equal(otherRoom.status, 403);

  const fakeAdmin = await post(base, { roomId: "ABCDE" }, { Authorization: "Bearer forjado" });
  assert.equal(fakeAdmin.status, 403);
});
