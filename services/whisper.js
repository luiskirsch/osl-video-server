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
const { logWarn } = require("../logger");

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

// Transformers.js usa, por padrão, uma pasta .cache dentro do próprio pacote
// em node_modules. Em produção o container roda como usuário sem permissão de
// escrita nessa árvore. Direcionamos o modelo para um cache gravável.
function configureTransformersCache(transformersEnv, options = {}) {
  const cacheDir = options.cacheDir
    || process.env.TRANSFORMERS_CACHE_DIR
    || path.join(os.tmpdir(), "huggingface-transformers");
  const mkdirSync = options.mkdirSync || fs.mkdirSync;
  const accessSync = options.accessSync || fs.accessSync;
  mkdirSync(cacheDir, { recursive: true });
  accessSync(cacheDir, fs.constants.W_OK);
  transformersEnv.cacheDir = cacheDir;
  transformersEnv.useFSCache = true;
  return cacheDir;
}

// Lazy load — modelo grande (150MB) só carrega quando alguem chama transcribe()
async function getPipeline() {
  if (_pipelineP) return _pipelineP;
  _pipelineP = (async () => {
    const { pipeline, env } = await import("@huggingface/transformers");
    configureTransformersCache(env);
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
// ─── Groq (Whisper Large v3 Turbo) ────────────────────────────────────────
// Com GROQ_API_KEY configurada, a transcrição roda no Groq: ~15 s por hora de
// áudio (contra ~metade da duração da sessão na CPU daqui), US$ 0,04/hora.
// Contrato do Groq proíbe treino com os dados; ligar Zero Data Retention no
// console. Falha do Groq (rede, limite, 5xx) cai na transcrição local.
// WHISPER_PROVIDER=local força a local mesmo com a chave.
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = process.env.GROQ_WHISPER_MODEL || "whisper-large-v3-turbo";
const GROQ_MAX_BYTES = boundedNumber(process.env.GROQ_MAX_FILE_BYTES, 25 * 1024 * 1024, 1024 * 1024, 100 * 1024 * 1024);
const GROQ_TIMEOUT_MS = boundedNumber(process.env.GROQ_TIMEOUT_MS, 5 * 60_000, 30_000, 20 * 60_000);
const ISO_LANGUAGE = { portuguese: "pt", english: "en", spanish: "es" };

function groqEnabled() {
  return !!process.env.GROQ_API_KEY && process.env.WHISPER_PROVIDER !== "local";
}

async function transcribeViaGroq(audioBuffer, { language, srcExt, fetchImpl = fetch } = {}) {
  if (audioBuffer.length > GROQ_MAX_BYTES) throw new Error("GROQ_ARQUIVO_GRANDE");
  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: `audio/${srcExt}` }), `audio.${srcExt}`);
  form.append("model", GROQ_MODEL);
  form.append("language", ISO_LANGUAGE[language] || String(language || "pt").slice(0, 2));
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  const res = await fetchImpl(GROQ_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(GROQ_TIMEOUT_MS)
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    const error = new Error(`GROQ_HTTP_${res.status}`);
    error.detail = detail;
    throw error;
  }
  const data = await res.json();
  const segments = Array.isArray(data.segments) ? data.segments : [];
  const durationSec = Number(data.duration) || (segments.length ? Number(segments[segments.length - 1].end) || 0 : 0);
  const rawText = String(data.text || "").trim();
  return {
    text: isHallucinated(rawText) ? "" : rawText,
    chunks: segments.map(seg => ({ timestamp: [Number(seg.start) || 0, Number(seg.end) || 0], text: String(seg.text || "") })),
    durationSec,
    hallucinated: isHallucinated(rawText),
    provider: "groq"
  };
}

async function transcribe(audioBuffer, opts = {}) {
  const language = opts.language || "portuguese";
  const srcExt = normalizeAudioExtension(opts.srcExt || "webm");

  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    throw new Error("audioBuffer vazio ou invalido");
  }
  if (audioBuffer.length > MAX_AUDIO_BYTES) {
    throw new Error("AUDIO_MUITO_GRANDE");
  }

  if (groqEnabled()) {
    try {
      return await transcribeViaGroq(audioBuffer, { language, srcExt });
    } catch (error) {
      // Sem detalhes do conteúdo no log — só o motivo técnico.
      logWarn("whisper_groq_fallback_local", { error: error.message, detail: error.detail || null });
    }
  }

  // A transcrição local já ocupa toda a CPU: uma por vez, em fila.
  return runLocalExclusive(() => transcribeLocal(audioBuffer, { language, srcExt }));
}

let localChain = Promise.resolve();
let localDepth = 0;
function runLocalExclusive(task) {
  localDepth += 1;
  const run = localChain.then(task, task);
  localChain = run.catch(() => {}).finally(() => { localDepth -= 1; });
  return run;
}
/** Transcrições locais rodando ou esperando (0 = livre). */
function localQueueDepth() { return localDepth; }

async function transcribeLocal(audioBuffer, { language, srcExt }) {
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
    hallucinated: isHallucinated(rawText),
    provider: "local"
  };
}

// Detecta alucinação do Whisper: texto repetitivo gerado quando o áudio
// tem pouca fala ou ruído excessivo ("que é que é que é..." etc).
// Dois critérios independentes:
//   1. Razão palavras-únicas / total < 8% (vocabulário muito restrito)
//   2. Algum bigrama se repete em > 15% das posições do texto
// Frases que o Whisper inventa em trechos de silêncio (comum em pedaços de
// 90 s com pausa longa). Texto que é SÓ isso não é fala.
const SILENCE_PHRASES = /^(?:legendas?\b.*|obrigad[oa]s?|tchau|inscreva-se.*|e aí|\.+|…)[\s.!…]*$/i;

function isHallucinated(text) {
  if (SILENCE_PHRASES.test(String(text || "").trim())) return true;
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

module.exports = { transcribe, isHallucinated, normalizeAudioExtension, localQueueDepth, groqEnabled, _test: { configureTransformersCache, transcribeViaGroq, groqEnabled } };
