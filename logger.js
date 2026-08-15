// Logger estruturado JSON. Saída dupla: stdout/stderr (Railway captura) +
// arquivo local (útil em dev / restore após queda). Arquivo rotaciona por
// tamanho — sem rotação o disco enchia silenciosamente.
//
// #B2: trocada a engolida silenciosa de erros de escrita por log em stderr
// (uma vez por janela; rearmar quando voltar a funcionar) e adicionada
// rotação simples (LOG_FILE.1 = backup mais recente, sobrescrito).

const fs   = require("fs");
const path = require("path");

const APP_START_TIME = Date.now();
const LOG_FILE       = path.resolve(process.env.LOG_FILE || "server.log");
const LOG_FILE_BACKUP = LOG_FILE + ".1";
const MAX_LOG_SIZE_BYTES = Number(process.env.MAX_LOG_SIZE_BYTES || 10 * 1024 * 1024); // 10 MB

// Contador para checar rotação só a cada N escritas (custo de fs.statSync).
const ROTATE_CHECK_EVERY = 100;
let writeCounter = 0;
// Estado de "falha persistente" — evita spam de erro em stderr quando o disco
// encheu de vez. Logamos uma vez ao falhar; logamos uma vez ao recuperar.
let writeFailedSticky = false;

function rotateIfNeeded() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size < MAX_LOG_SIZE_BYTES) return;
    try {
      fs.renameSync(LOG_FILE, LOG_FILE_BACKUP);
    } catch (_) {
      // Filesystem read-only ou permissão — tenta truncar como fallback.
      try { fs.truncateSync(LOG_FILE, 0); } catch (_) { /* desiste */ }
    }
  } catch (_) {
    // arquivo ainda não existe — ok, primeira escrita cria.
  }
}

function writeToFile(line) {
  try {
    if (++writeCounter >= ROTATE_CHECK_EVERY) {
      writeCounter = 0;
      rotateIfNeeded();
    }
    fs.appendFileSync(LOG_FILE, line + "\n");
    if (writeFailedSticky) {
      writeFailedSticky = false;
      console.error(JSON.stringify({
        level: "info",
        time: new Date().toISOString(),
        message: "log_file_write_recovered"
      }));
    }
  } catch (err) {
    if (!writeFailedSticky) {
      writeFailedSticky = true;
      console.error(JSON.stringify({
        level: "error",
        time: new Date().toISOString(),
        message: "log_file_write_failed",
        error: { message: err?.message || String(err), code: err?.code || null }
      }));
    }
  }
}

function logInfo(message, meta = {}) {
  const line = JSON.stringify({
    level: "info",
    time: new Date().toISOString(),
    message,
    ...meta
  });
  console.log(line);
  writeToFile(line);
}

function logWarn(message, meta = {}) {
  const line = JSON.stringify({
    level: "warn",
    time: new Date().toISOString(),
    message,
    ...meta
  });
  console.warn(line);
  writeToFile(line);
}

function logError(message, error, meta = {}) {
  const line = JSON.stringify({
    level: "error",
    time: new Date().toISOString(),
    message,
    error: {
      name: error?.name || "Error",
      message: error?.message || String(error),
      stack: error?.stack || null
    },
    ...meta
  });
  console.error(line);
  writeToFile(line);
}

// Compatibilidade com os serviços mais novos, que usam a assinatura do Pino:
//   logger.info({ roomId }, "evento")
// O logger original do projeto expunha apenas logInfo("evento", { roomId }).
// Manter as duas formas evita que um único inicializador interrompa todo o
// ecossistema de eventos (reputação, social, mundo e notificações).
function normalizeCompatArgs(first, second, fallbackMessage) {
  if (typeof first === "string") {
    return {
      message: first || fallbackMessage,
      meta: second && typeof second === "object" && !(second instanceof Error) ? second : {}
    };
  }

  return {
    message: typeof second === "string" && second ? second : fallbackMessage,
    meta: first && typeof first === "object" ? first : {}
  };
}

function info(first, second) {
  const { message, meta } = normalizeCompatArgs(first, second, "info");
  logInfo(message, meta);
}

function warn(first, second) {
  const { message, meta } = normalizeCompatArgs(first, second, "warning");
  logWarn(message, meta);
}

function error(first, second, third) {
  const { message, meta: rawMeta } = normalizeCompatArgs(first, second, "error");
  const meta = { ...rawMeta };

  let cause = null;
  if (first instanceof Error) cause = first;
  if (second instanceof Error) cause = second;
  if (third instanceof Error) cause = third;
  if (!cause && rawMeta.err instanceof Error) cause = rawMeta.err;
  if (!cause && rawMeta.error instanceof Error) cause = rawMeta.error;
  if (!cause) {
    const detail = rawMeta.err || rawMeta.error || (typeof second === "string" ? null : second);
    cause = new Error(typeof detail === "string" ? detail : message);
  }

  delete meta.err;
  delete meta.error;
  if (third && typeof third === "object" && !(third instanceof Error)) Object.assign(meta, third);
  logError(message, cause, meta);
}

module.exports = {
  APP_START_TIME, LOG_FILE, MAX_LOG_SIZE_BYTES,
  writeToFile, logInfo, logWarn, logError,
  info, warn, error
};
