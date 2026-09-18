"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { updateCurrentAttempt } = require("../services/therapy-ai-summary");

function fakeDb(current) {
  const writes = [];
  return {
    writes,
    async runTransaction(callback) {
      return callback({
        async get() {
          return { exists: current != null, data: () => current };
        },
        set(ref, data, options) {
          writes.push({ ref, data, options });
        },
      });
    },
  };
}

test("resumo IA grava somente na tentativa que ainda possui o lease", async () => {
  const db = fakeDb({ status: "processing", attemptId: "current" });
  const stored = await updateCurrentAttempt({
    db,
    summaryRef: { id: "session" },
    attemptId: "current",
    data: { status: "completed" },
  });

  assert.equal(stored, true);
  assert.equal(db.writes.length, 1);
  assert.equal(db.writes[0].data.status, "completed");
});

test("resumo IA descarta resultado atrasado de uma tentativa substituida", async () => {
  const db = fakeDb({ status: "processing", attemptId: "newer" });
  const stored = await updateCurrentAttempt({
    db,
    summaryRef: { id: "session" },
    attemptId: "expired",
    data: { status: "failed" },
  });

  assert.equal(stored, false);
  assert.equal(db.writes.length, 0);
});
