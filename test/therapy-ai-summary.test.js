"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { updateCurrentAttempt, splitAudioSegments, transcribeSegments } = require("../services/therapy-ai-summary");

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

test("separa o áudio em trechos pelo header X-AI-Segments", () => {
  const body = Buffer.from("aaabbbbbc");
  assert.deepEqual(splitAudioSegments(body, undefined), [body], "sem header é um arquivo único");
  assert.deepEqual(splitAudioSegments(body, "3,5,1").map(String), ["aaa", "bbbbb", "c"]);
  assert.equal(splitAudioSegments(body, "3,5"), null, "soma diferente do body");
  assert.equal(splitAudioSegments(body, "3,0,6"), null, "trecho vazio");
  assert.equal(splitAudioSegments(body, "3,x,6"), null);
  assert.equal(splitAudioSegments(Buffer.alloc(101), Array(101).fill("1").join(",")), null, "limite de trechos");
});

test("junta a transcrição de todos os trechos na ordem", async () => {
  const fake = async segment => ({ text: `fala ${segment}`, durationSec: 60, hallucinated: false });
  const result = await transcribeSegments([Buffer.from("1"), Buffer.from("2"), Buffer.from("3")], fake);
  assert.equal(result.text, "fala 1\n\nfala 2\n\nfala 3");
  assert.equal(result.durationSec, 180);
  assert.equal(result.hallucinated, false);
});

test("trecho corrompido ou alucinado não derruba os outros", async () => {
  const fake = async segment => {
    const id = String(segment);
    if (id === "corrompido") throw new Error("ffmpeg failed");
    if (id === "ruido") return { text: "", durationSec: 5, hallucinated: true };
    return { text: `fala ${id}`, durationSec: 30, hallucinated: false };
  };
  const result = await transcribeSegments(["a", "corrompido", "ruido", "b"].map(s => Buffer.from(s)), fake);
  assert.equal(result.text, "fala a\n\nfala b");
  assert.equal(result.failedSegments, 1);
  assert.equal(result.hallucinatedSegments, 1);
  assert.equal(result.hallucinated, false);
});

test("falha quando nenhum trecho pôde ser transcrito", async () => {
  const fake = async () => { throw new Error("ffmpeg failed"); };
  await assert.rejects(transcribeSegments([Buffer.from("a"), Buffer.from("b")], fake), /ffmpeg failed/);
});

test("só ruído em todos os trechos continua marcado como alucinação", async () => {
  const fake = async () => ({ text: "", durationSec: 10, hallucinated: true });
  const result = await transcribeSegments([Buffer.from("a"), Buffer.from("b")], fake);
  assert.equal(result.hallucinated, true);
});
