"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isHallucinated, normalizeAudioExtension, _test } = require("../services/whisper");

test("cache do Transformers usa diretório gravável fora de node_modules", () => {
  const calls = [];
  const env = { cacheDir: "/app/node_modules/@huggingface/transformers/.cache", useFSCache: false };
  const cacheDir = _test.configureTransformersCache(env, {
    cacheDir: "/tmp/huggingface-transformers-test",
    mkdirSync: (dir, options) => calls.push(["mkdir", dir, options]),
    accessSync: (dir, mode) => calls.push(["access", dir, mode])
  });
  assert.equal(cacheDir, "/tmp/huggingface-transformers-test");
  assert.equal(env.cacheDir, "/tmp/huggingface-transformers-test");
  assert.equal(env.useFSCache, true);
  assert.equal(calls[0][0], "mkdir");
  assert.equal(calls[1][0], "access");
});

test("extensão de áudio é allowlisted contra path traversal", () => {
  assert.equal(normalizeAudioExtension(".WEBM"), "webm");
  assert.throws(() => normalizeAudioExtension("../../target"), /AUDIO_EXTENSAO_INVALIDA/);
  assert.throws(() => normalizeAudioExtension("webm;rm"), /AUDIO_EXTENSAO_INVALIDA/);
});

test("detector de alucinação rejeita repetição longa", () => {
  const repeated = Array.from({ length: 40 }, () => "que coisa").join(" ");
  assert.equal(isHallucinated(repeated), true);
  assert.equal(isHallucinated("fala curta e válida"), false);
});
