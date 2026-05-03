// Backend i18n minimalista — sem dependência externa.
// Locale detection via Accept-Language header (pt-BR padrão).

const fs = require("fs");
const path = require("path");

const SUPPORTED = ["pt-BR", "en-US"];
const DEFAULT_LOCALE = "pt-BR";

const _cache = new Map();

function loadNamespace(locale, ns) {
  const cacheKey = `${locale}:${ns}`;
  if (_cache.has(cacheKey)) return _cache.get(cacheKey);
  const file = path.join(__dirname, "..", "i18n", "locales", locale, `${ns}.json`);
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    _cache.set(cacheKey, data);
    return data;
  } catch (_) {
    _cache.set(cacheKey, null);
    return null;
  }
}

// Resolve locale a partir de req. Prioridade: query ?lang=, X-Locale header, Accept-Language.
function detectLocale(req) {
  const fromQuery = req.query?.lang;
  if (fromQuery && SUPPORTED.includes(fromQuery)) return fromQuery;

  const fromHeader = req.headers?.["x-locale"];
  if (fromHeader && SUPPORTED.includes(fromHeader)) return fromHeader;

  const accept = String(req.headers?.["accept-language"] || "").toLowerCase();
  if (accept.startsWith("en")) return "en-US";
  return DEFAULT_LOCALE;
}

// Lookup nested key path (ex "products.osl_ritual_completo.title") em namespace
function _get(obj, dotPath) {
  return dotPath.split(".").reduce((a, k) => (a == null ? a : a[k]), obj);
}

// t(req, "namespace:key.path", fallback?)
function t(req, fullKey, fallback) {
  const locale = detectLocale(req);
  const [ns, ...rest] = fullKey.split(":");
  const dotPath = rest.join(":");
  const data = loadNamespace(locale, ns);
  const value = _get(data, dotPath);
  if (typeof value === "string") return value;

  // Fallback pra default locale
  if (locale !== DEFAULT_LOCALE) {
    const def = loadNamespace(DEFAULT_LOCALE, ns);
    const v = _get(def, dotPath);
    if (typeof v === "string") return v;
  }
  return fallback != null ? fallback : fullKey;
}

module.exports = { detectLocale, t, SUPPORTED, DEFAULT_LOCALE };
