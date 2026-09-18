// Espaço Prelúdio — transcrição local via @huggingface/transformers (Whisper).
//
// Pipeline:
//   audio buffer (webm/mp3) → ffmpeg pra WAV 16kHz mono → wavefile decoda pra
//   Float32Array → Whisper transcreve → texto + timestamps.
//
// Modelo padrão: Xenova/whisper-base (~150MB, baixa primeira vez, cacheia em disco).
// Performance estimada em 1 vCPU (Railway Hobby):
//   50min audio → ~25min processamento (transformers.js é ~50% mais lento que
//   whisper.cpp puro, aceito pelo trade-off de simplicidade — sem build native).
//
// Chunking: Whisper modelo base aceita até 30s por vez. Pra audio longo, o
// pipeline da transformers.js usa "chunk_length_s" + "stride_length_s" pra
// processar em segmentos com overlap (evita cortar palavras nas bordas).

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

let _pipelineP = null;
let _WaveFile = null;
let _pipelineFactory = null;

const ALLOWED_AUDIO_EXTENSIONS = new Set(["webm", "mp3", "ogg", "oga", "wav", "m4a", "mp4", "aac", "flac"]);
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
const MAX_DURATION_SECONDS = boundedNumber(
  process.env.WHISPER_MAX_DURATION_SECONDS,
  2 * 60 * 60,
  60,
  4 * 60 * 60
);
const FFMPEG_TIMEOUT_MS = boundedNumber(
  process.env.WHISPER_FFMPEG_TIMEOUT_MS,
  2 * 60_000,
  10_000,
  10 * 60_000
);
const MAX_FFMPEG_ERROR_CHARS = 4_000;

// Lazy load — modelo grande (150MB) só carrega quando alguem chama transcribe()
async function getPipeline() {
  if (_pipelineP) return _pipelineP;
  _pipelineP = (async () => {
    const { pipeline } = await import("@huggingface/transformers");
    _pipelineFactory = pipeline;
    const wavefileMod = await import("wavefile");
    // wavefile exporta diferente dependendo da versao/ambiente (CJS vs ESM):
    // v8+ usa ESM default export; versoes anteriores tem named export .WaveFile
    _WaveFile = wavefileMod.WaveFile ?? wavefileMod.default?.WaveFile ?? wavefileMod.default;
    // Configuration:
    //   Xenova/whisper-base: ~150MB, multilingual, suporta PT-BR. Baseline de
    //   qualidade boa pra sessoes clinicas.
    //   Pra qualidade melhor (em troca de mais tempo): Xenova/whisper-small (~470MB)
    //   ou Xenova/whisper-medium (~1.5GB).
    //   Configuravel via env var WHISPER_MODEL.
    const modelName = process.env.WHISPER_MODEL || "Xenova/whisper-base";
    return pipeline("automatic-speech-recognition", modelName);
  })();
  try {
    return await _pipelineP;
  } catch (error) {
    // Falha transitória no download/cache não deve inutilizar o recurso até o
    // próximo deploy. A chamada seguinte pode tentar inicializar novamente.
    _pipelineP = null;
    throw error;
  }
}

function normalizeAudioExtension(value) {
  const ext = String(value || "webm").trim().toLowerCase().replace(/^\./, "");
  if (!ALLOWED_AUDIO_EXTENSIONS.has(ext)) throw new Error("AUDIO_EXTENSAO_INVALIDA");
  return ext;
}

/**
 * Converte audio buffer (webm/mp3/ogg/etc) pra WAV PCM 16kHz mono via ffmpeg.
 * Retorna o path do WAV temporário (caller responsabilidade limpar).
 */
function convertToWav(audioBuffer, srcExt = "webm") {
  return new Promise((resolve, reject) => {
    let safeExt;
    try {
      safeExt = normalizeAudioExtension(srcExt);
    } catch (error) {
      reject(error);
      return;
    }
    const tmpDir = os.tmpdir();
    const rand = crypto.randomBytes(8).toString("hex");
    const srcPath = path.join(tmpDir, `whisper-src-${rand}.${safeExt}`);
    const wavPath = path.join(tmpDir, `whisper-out-${rand}.wav`);

    fs.writeFileSync(srcPath, audioBuffer);

    // -ar 16000: 16kHz (Whisper native)
    // -ac 1: mono
    // -c:a pcm_s16le: 16-bit signed little-endian (PCM)
    // -y: overwrite
    // -loglevel error: só erros no stderr
    const ff = spawn("ffmpeg", [
      "-y",
      "-loglevel", "error",
      "-i", srcPath,
      "-t", String(MAX_DURATION_SECONDS),
      "-ar", "16000",
      "-ac", "1",
      "-c:a", "pcm_s16le",
      wavPath
    ]);

    let stderr = "";
    let settled = false;
    const cleanup = () => {
      try { fs.unlinkSync(srcPath); } catch (_) { /* empty */ }
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ff.kill("SIGKILL"); } catch (_) { /* process already gone */ }
      cleanup();
      try { fs.unlinkSync(wavPath); } catch (_) { /* empty */ }
      reject(new Error("FFMPEG_TIMEOUT"));
    }, FFMPEG_TIMEOUT_MS);
    timeout.unref?.();

    ff.stderr.on("data", (d) => {
      if (stderr.length < MAX_FFMPEG_ERROR_CHARS) {
        stderr += d.toString().slice(0, MAX_FFMPEG_ERROR_CHARS - stderr.length);
      }
    });

    ff.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      // Cleanup source regardless
      cleanup();
      if (code !== 0) {
        try { fs.unlinkSync(wavPath); } catch (_) { /* empty */ }
        return reject(new Error(`ffmpeg failed (code ${code}): ${stderr.slice(0, 300)}`));
      }
      resolve(wavPath);
    });

    ff.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cleanup();
      try { fs.unlinkSync(wavPath); } catch (_) { /* empty */ }
      reject(new Error(`ffmpeg spawn failed: ${err.message}`));
    });
  });
}

/**
 * Carrega WAV do disco como Float32Array pronto pro Whisper.
 */
function loadWavAsFloat32(wavPath) {
  const buf = fs.readFileSync(wavPath);
  const wav = new _WaveFile(buf);
  // Whisper aceita Float32 com samples em [-1, 1]
  wav.toBitDepth("32f");
  wav.toSampleRate(16000);
  let samples = wav.getSamples();
  // wav.getSamples() pode retornar array de canais [L, R] ou single channel
  if (Array.isArray(samples) && samples.length > 0 && Array.isArray(samples[0])) {
    // Mixdown estéreo → mono (caso a conversão tenha deixado canais separados)
    const left = samples[0];
    const right = samples[1] || samples[0];
    const mono = new Float32Array(left.length);
    for (let i = 0; i < left.length; i++) mono[i] = (left[i] + right[i]) / 2;
    samples = mono;
  } else if (!(samples instanceof Float32Array)) {
    samples = new Float32Array(samples);
  }
  return samples;
}

/**
 * Transcreve audio buffer. Retorna { text, chunks }.
 *
 * @param {Buffer} audioBuffer - audio em webm/mp3/ogg/wav
 * @param {object} opts
 * @param {string} [opts.language="portuguese"] - lingua do audio
 * @param {string} [opts.srcExt="webm"] - extensão pro tmp file (ffmpeg deduz)
 * @returns {Promise<{ text: string, chunks: Array<{timestamp: [number, number], text: string}>, durationSec: number }>}
 */
async function transcribe(audioBuffer, opts = {}) {
  const language = opts.language || "portuguese";
  const srcExt = normalizeAudioExtension(opts.srcExt || "webm");

  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    throw new Error("audioBuffer vazio ou invalido");
  }
  if (audioBuffer.length > MAX_AUDIO_BYTES) {
    throw new Error("AUDIO_MUITO_GRANDE");
  }

  const pipeline = await getPipeline();

  const wavPath = await convertToWav(audioBuffer, srcExt);
  let samples;
  try {
    samples = loadWavAsFloat32(wavPath);
  } finally {
    try { fs.unlinkSync(wavPath); } catch (_) { /* empty */ }
  }

  const durationSec = samples.length / 16000;

  // chunk_length_s: 30s é o limite nativo do Whisper
  // stride_length_s: overlap de 5s pra evitar cortes em palavras
  // return_timestamps: true pra ter timestamps por chunk (util pra audit)
  const result = await pipeline(samples, {
    language,
    task: "transcribe",
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: true
  });

  const rawText = String(result.text || "").trim();

  return {
    text: isHallucinated(rawText) ? "" : rawText,
    chunks: Array.isArray(result.chunks) ? result.chunks : [],
    durationSec,
    hallucinated: isHallucinated(rawText)
  };
}

// Detecta alucinação do Whisper: texto repetitivo gerado quando o áudio
// tem pouca fala ou ruído excessivo ("que é que é que é..." etc).
// Dois critérios independentes:
//   1. Razão palavras-únicas / total < 8% (vocabulário muito restrito)
//   2. Algum bigrama se repete em > 15% das posições do texto
function isHallucinated(text) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 20) return false; // texto curto — não analisa

  // Critério 1: unicidade de vocabulário
  const unique = new Set(words.map(w => w.toLowerCase().replace(/[^a-záéíóúàãõâêôüç]/g, "")));
  if (unique.size / words.length < 0.08) return true;

  // Critério 2: bigrama dominante
  const bigrams = {};
  for (let i = 0; i < words.length - 1; i++) {
    const bg = words[i].toLowerCase() + " " + words[i + 1].toLowerCase();
    bigrams[bg] = (bigrams[bg] || 0) + 1;
  }
  const maxCount = Math.max(...Object.values(bigrams));
  if (maxCount / words.length > 0.12) return true;

  return false;
}

module.exports = { transcribe, isHallucinated, normalizeAudioExtension };
