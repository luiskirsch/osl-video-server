const { logWarn } = require("../logger");

// Padrões compilados uma vez no boot — zero custo por requisição.
const SCANNER_UA = /\b(sqlmap|nikto|nmap|masscan|nessus|burpsuite|openvas|acunetix|appscan|dirbuster|gobuster|wfuzz|feroxbuster|hydra|medusa|metasploit|zgrab|havij|commix|nuclei|jaeles|curl\/7\.[0-2])\b/i;

const PATH_TRAVERSAL = /\.\.[/\\]|%2e%2e[%/\\]/i;

// Cloud metadata endpoints (SSRF)
const SSRF_URL = /169\.254\.169\.254|metadata\.google\.internal|100\.100\.100\.200|metadata\.azure\.internal/;

module.exports = function waf(req, res, next) {
  const ua  = req.headers["user-agent"] || "";
  const url = req.originalUrl;
  const ip  = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "?";

  if (SCANNER_UA.test(ua)) {
    logWarn("waf_scanner_ua", { ip, ua: ua.slice(0, 120) });
    return res.status(403).json({ ok: false, error: "FORBIDDEN" });
  }

  if (PATH_TRAVERSAL.test(url)) {
    logWarn("waf_path_traversal", { ip, url: url.slice(0, 200) });
    return res.status(400).json({ ok: false, error: "BAD_REQUEST" });
  }

  if (SSRF_URL.test(url)) {
    logWarn("waf_ssrf_attempt", { ip, url: url.slice(0, 200) });
    return res.status(400).json({ ok: false, error: "BAD_REQUEST" });
  }

  next();
};
