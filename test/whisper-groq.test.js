"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const whisper = require("../services/whisper");

const { transcribeViaGroq, groqEnabled } = whisper._test;

test("Groq: envia modelo, idioma ISO e formato detalhado; normaliza a resposta", async () => {
  process.env.GROQ_API_KEY = "gsk_test";
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      json: async () => ({
        text: " Bom dia, como você está hoje? ",
        duration: 42.5,
        segments: [{ start: 0, end: 3.2, text: " Bom dia," }, { start: 3.2, end: 42.5, text: " como você está hoje?" }]
      })
    };
  };
  const result = await transcribeViaGroq(Buffer.from("audio"), { language: "portuguese", srcExt: "webm", fetchImpl });
  assert.equal(captured.url, "https://api.groq.com/openai/v1/audio/transcriptions");
  assert.equal(captured.init.headers.Authorization, "Bearer gsk_test");
  assert.equal(captured.init.body.get("model"), "whisper-large-v3-turbo");
  assert.equal(captured.init.body.get("language"), "pt");
  assert.equal(captured.init.body.get("response_format"), "verbose_json");
  assert.equal(result.text, "Bom dia, como você está hoje?");
  assert.equal(result.durationSec, 42.5);
  assert.equal(result.chunks.length, 2);
  assert.equal(result.provider, "groq");
  assert.equal(result.hallucinated, false);
  delete process.env.GROQ_API_KEY;
});

test("Groq: erro HTTP vira exceção (o chamador cai na transcrição local)", async () => {
  process.env.GROQ_API_KEY = "gsk_test";
  const fetchImpl = async () => ({ ok: false, status: 413, text: async () => "Request Entity Too Large" });
  await assert.rejects(
    transcribeViaGroq(Buffer.from("audio"), { language: "portuguese", srcExt: "webm", fetchImpl }),
    /GROQ_HTTP_413/
  );
  delete process.env.GROQ_API_KEY;
});

test("Groq só é usado com chave e sem WHISPER_PROVIDER=local", () => {
  delete process.env.GROQ_API_KEY;
  assert.equal(groqEnabled(), false);
  process.env.GROQ_API_KEY = "gsk_test";
  assert.equal(groqEnabled(), true);
  process.env.WHISPER_PROVIDER = "local";
  assert.equal(groqEnabled(), false);
  delete process.env.WHISPER_PROVIDER;
  delete process.env.GROQ_API_KEY;
});
