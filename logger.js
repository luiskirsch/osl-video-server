const fs = require("fs");

const APP_START_TIME = Date.now();
const LOG_FILE = "server.log";

function writeToFile(line) {
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (_) {}
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

module.exports = { APP_START_TIME, LOG_FILE, writeToFile, logInfo, logWarn, logError };
