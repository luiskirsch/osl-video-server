"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isHallucinated, normalizeAudioExtension } = require("../services/whisper");

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
