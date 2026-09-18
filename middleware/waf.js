const { logWarn } = require("../logger");
const { safeRequestPath } = require("../utils");

// Padrões compilados uma vez no boot — zero custo por requisição.
const SCANNER_UA = /\b(sqlmap|nikto|nmap|masscan|nessus|burpsuite|openvas|acunetix|appscan|dirbuster|gobuster|wfuzz|feroxbuster|hydra|medusa|metasploit|zgrab|havij|commix|nuclei|jaeles|curl\/7\.[0-2])\b/i;

// Clonadores e downloaders de site inteiro
const CLONER_UA = /\b(httrack|winhttrack|websave|sitesuck(er)?|teleport[\s\-.]pro|black[\s\-]widow|webcopier|webzip|webstrip(per)?|offline[\s\-.]explorer|surfoffline|netattach|webwhacker|wwwoffle|webdevil|linkwalker)\b/i;

const PATH_TRAVERSAL = /\.\.[/\\]|%2e%2e(?:%2f|%5c|[/\\])|%252e%252e(?:%252f|%255c|[/\\])/i;

// Cloud metadata endpoints (SSRF)
const SSRF_URL = /169\.254\.169\.254|metadata\.google\.internal|100\.100\.100\.200|metadata\.azure\.internal/;

module.exports = function waf(req, res, next) {
  const ua  = String(req.headers["user-agent"] || "").slice(0, 512);
  const url = String(req.originalUrl || "").slice(0, 8192);
  const ip  = req.ip || req.socket?.remoteAddress || "?";

  if (String(req.originalUrl || "").length > 8192) {
    return res.status(414).json({ ok: false, error: "URI_MUITO_LONGA" });
  }

  if (SCANNER_UA.test(ua)) {
    logWarn("waf_scanner_ua", { ip, ua: ua.slice(0, 120) });
    return res.status(403).json({ ok: false, error: "FORBIDDEN" });
  }

  if (CLONER_UA.test(ua)) {
    logWarn("waf_cloner_ua", { ip, ua: ua.slice(0, 120) });
    return res.status(403).json({ ok: false, error: "FORBIDDEN" });
  }

  if (PATH_TRAVERSAL.test(url)) {
    logWarn("waf_path_traversal", { ip, path: safeRequestPath(req).slice(0, 200) });
    return res.status(400).json({ ok: false, error: "BAD_REQUEST" });
  }

  if (SSRF_URL.test(url)) {
    logWarn("waf_ssrf_attempt", { ip, path: safeRequestPath(req).slice(0, 200) });
    return res.status(400).json({ ok: false, error: "BAD_REQUEST" });
  }

  next();
};
