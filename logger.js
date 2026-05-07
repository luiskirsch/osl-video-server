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

module.exports = {
  APP_START_TIME, LOG_FILE, MAX_LOG_SIZE_BYTES,
  writeToFile, logInfo, logWarn, logError
};
