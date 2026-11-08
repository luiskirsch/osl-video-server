"use strict";
const BASE = ["Authorization", "Content-Type", "X-Locale", "X-Therapy-2FA", "X-Request-Id"];
function headersFor(req) {
  const path = req.path || "";
  if (/^\/public\/leads(?:\/|$)/.test(path)) return ["Content-Type", "X-Locale"];
  if (/^\/public\//.test(path)) return ["Authorization", "Content-Type", "X-Locale"];
  if (/^\/i18n\//.test(path)) return ["Content-Type", "X-I18N-Token", "X-Locale"];
  if (/^\/(?:therapy|institution|rt|empresa|conta)(?:\/|$)/.test(path)) {
    const result = [...BASE];
    if (/\/ai(?:\/|-)|\/audio|\/transcri|\/resumo/.test(path)) result.push("X-AI-Result-Key", "X-AI-Wrapped-Key", "X-AI-Wrapped-Key-IV", "X-AI-Segments", "X-AI-Piece-Key", "X-AI-Piece-Keys");
    if (/\/nfse(?:\/|$)/.test(path)) result.push("X-Nfse-Token");
    return result;
  }
  return ["Authorization", "Content-Type"];
}
module.exports = { headersFor };
