"use strict";

// Clima aproximado para o fundo do card da Home do colaborador, sem pedir
// permissão de localização. Cidade por IP (DB-IP Lite, CC BY 4.0) mantida em
// memória só para faixas do Brasil (~10 MB em vez de ~130 MB da base inteira);
// clima pelo MET Norway (CC BY 4.0, uso comercial permitido). IP e
// coordenadas nunca são persistidos nem logados.

const zlib = require("zlib");
const readline = require("readline");
const net = require("net");
const { Readable } = require("stream");
const { logInfo, logWarn } = require("../logger");

// IP de operadora móvel costuma geolocalizar na capital/SP (CGNAT), então o
// clima sairia errado. Nesses casos o card fica só com o fundo por horário.
const MOBILE_ONLY_ASNS = new Set([26615, 26599]); // TIM, Vivo móvel
const MIXED_MOBILE_ASNS = new Set([28573, 22085]); // Claro/NET: 4G e banda larga no mesmo ASN
const FLAGGED_ASNS = new Set([...MOBILE_ONLY_ASNS, ...MIXED_MOBILE_ASNS]);

const WEATHER_TTL_MS = 30 * 60 * 1000;
const WEATHER_CACHE_MAX = 5000;
const LOAD_RETRY_MS = 60 * 60 * 1000;
const MET_USER_AGENT = "EspacoPreludio/1.0 https://espacopreludio.com.br contato@espacopreludio.com.br";

let geo = null;
let geoMonth = null;
let loading = null;
let lastLoadFailure = 0;
const weatherCache = new Map();
const weatherPending = new Map();

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function candidateMonths(now = new Date()) {
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return [monthKey(now), monthKey(prev)];
}

function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

// Faixas IPv6 de geolocalização são /64 ou maiores, então os 64 bits altos
// bastam para a busca.
function ipv6High64(ip) {
  let addr = ip.split("%")[0];
  const lastColon = addr.lastIndexOf(":");
  if (addr.includes(".", lastColon)) {
    const v4 = ipv4ToInt(addr.slice(lastColon + 1));
    if (v4 === null) return null;
    addr = `${addr.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups = halves.length === 2
    ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail]
    : head;
  if (groups.length !== 8) return null;
  let value = 0n;
  for (let i = 0; i < 4; i++) {
    const n = parseInt(groups[i], 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
    value = (value << 16n) | BigInt(n);
  }
  return value;
}

function parseIp(raw) {
  let ip = String(raw || "").trim();
  if (ip.toLowerCase().startsWith("::ffff:") && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  if (net.isIPv4(ip)) return { v6: false, value: ipv4ToInt(ip) };
  if (net.isIPv6(ip)) {
    const value = ipv6High64(ip);
    return value === null ? null : { v6: true, value };
  }
  return null;
}

function findRange(starts, ends, value) {
  let lo = 0, hi = starts.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= value) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return idx >= 0 && value <= ends[idx] ? idx : -1;
}

function newTable() {
  return { v4: { starts: [], ends: [], a: [], b: [] }, v6: { starts: [], ends: [], a: [], b: [] } };
}

function pushRange(table, startRaw, endRaw, a, b) {
  const start = parseIp(startRaw);
  const end = parseIp(endRaw);
  if (!start || !end || start.v6 !== end.v6) return;
  const bucket = start.v6 ? table.v6 : table.v4;
  bucket.starts.push(start.value);
  bucket.ends.push(end.value);
  bucket.a.push(a);
  bucket.b.push(b);
}

function freeze(table, ArrayA, ArrayB) {
  return {
    v4: { starts: Float64Array.from(table.v4.starts), ends: Float64Array.from(table.v4.ends), a: ArrayA.from(table.v4.a), b: ArrayB.from(table.v4.b) },
    v6: { starts: BigUint64Array.from(table.v6.starts), ends: BigUint64Array.from(table.v6.ends), a: ArrayA.from(table.v6.a), b: ArrayB.from(table.v6.b) }
  };
}

// Linha: ip_start,ip_end,continente,país,estado,"cidade",lat,lon
function parseCityLine(line, table) {
  const c1 = line.indexOf(",");
  const c2 = line.indexOf(",", c1 + 1);
  const c3 = line.indexOf(",", c2 + 1);
  const c4 = line.indexOf(",", c3 + 1);
  if (c4 < 0 || line.slice(c3 + 1, c4) !== "BR") return;
  const l2 = line.lastIndexOf(",");
  const l1 = line.lastIndexOf(",", l2 - 1);
  const lat = Number(line.slice(l1 + 1, l2));
  const lon = Number(line.slice(l2 + 1));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return;
  pushRange(table, line.slice(0, c1), line.slice(c1 + 1, c2), lat, lon);
}

// Linha: ip_start,ip_end,asn,"organização"
function parseAsnLine(line, table) {
  const c1 = line.indexOf(",");
  const c2 = line.indexOf(",", c1 + 1);
  const c3 = line.indexOf(",", c2 + 1);
  if (c3 < 0) return;
  const asn = Number(line.slice(c2 + 1, c3));
  if (!FLAGGED_ASNS.has(asn)) return;
  pushRange(table, line.slice(0, c1), line.slice(c1 + 1, c2), asn, 0);
}

async function streamGzipLines(url, onLine) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5 * 60 * 1000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  const input = Readable.fromWeb(res.body).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) onLine(line);
}

async function loadGeo() {
  let lastError = null;
  for (const month of candidateMonths()) {
    try {
      const city = newTable();
      const asn = newTable();
      await streamGzipLines(`https://download.db-ip.com/free/dbip-city-lite-${month}.csv.gz`, line => parseCityLine(line, city));
      await streamGzipLines(`https://download.db-ip.com/free/dbip-asn-lite-${month}.csv.gz`, line => parseAsnLine(line, asn));
      if (!city.v4.starts.length) throw new Error("base de cidades vazia");
      return { month, city: freeze(city, Float32Array, Float32Array), asn: freeze(asn, Int32Array, Int32Array) };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

function ensureGeoLoaded() {
  const current = monthKey(new Date());
  if ((geo && geoMonth === current) || loading) return;
  if (Date.now() - lastLoadFailure < LOAD_RETRY_MS) return;
  const started = Date.now();
  loading = loadGeo()
    .then(result => {
      geo = result;
      geoMonth = current;
      logInfo("ambient_weather_geo_loaded", {
        month: result.month,
        v4: result.city.v4.starts.length,
        v6: result.city.v6.starts.length,
        ms: Date.now() - started
      });
    })
    .catch(err => {
      lastLoadFailure = Date.now();
      logWarn("ambient_weather_geo_failed", { error: err.message });
    })
    .finally(() => { loading = null; });
}

function lookup(rawIp, data = geo) {
  if (!data) return null;
  const ip = parseIp(rawIp);
  if (!ip) return null;
  const cityBucket = ip.v6 ? data.city.v6 : data.city.v4;
  const idx = findRange(cityBucket.starts, cityBucket.ends, ip.value);
  if (idx < 0) return null;
  const asnBucket = ip.v6 ? data.asn.v6 : data.asn.v4;
  const asnIdx = findRange(asnBucket.starts, asnBucket.ends, ip.value);
  return { lat: cityBucket.a[idx], lon: cityBucket.b[idx], asn: asnIdx >= 0 ? asnBucket.a[asnIdx] : null };
}

function isLocationReliable({ asn, connection, mobileDevice }) {
  if (connection === "cellular") return false;
  if (connection === "wifi" || connection === "ethernet") return true;
  if (asn != null && MOBILE_ONLY_ASNS.has(asn)) return false;
  if (asn != null && MIXED_MOBILE_ASNS.has(asn) && mobileDevice) return false;
  return true;
}

function classifySymbol(code) {
  const base = String(code || "").replace(/_(day|night|polartwilight)$/, "");
  if (!base) return null;
  if (base.includes("thunder")) return "storm";
  if (base.includes("snow")) return "snow";
  if (base.includes("rain") || base.includes("sleet")) return "rain";
  if (base === "fog") return "fog";
  if (base === "cloudy") return "cloudy";
  if (base === "partlycloudy") return "partly";
  if (base === "clearsky" || base === "fair") return "clear";
  return null;
}

async function fetchWeather(lat, lon) {
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lon}`;
  const res = await fetch(url, { headers: { "User-Agent": MET_USER_AGENT }, signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`MET HTTP ${res.status}`);
  const data = await res.json();
  const now = data?.properties?.timeseries?.[0]?.data;
  return classifySymbol(now?.next_1_hours?.summary?.symbol_code || now?.next_6_hours?.summary?.symbol_code);
}

async function weatherFor(lat, lon) {
  const rLat = Math.round(lat * 10) / 10;
  const rLon = Math.round(lon * 10) / 10;
  const key = `${rLat},${rLon}`;
  const hit = weatherCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  if (weatherPending.has(key)) return weatherPending.get(key);
  const pending = fetchWeather(rLat, rLon)
    .then(value => {
      weatherCache.delete(key);
      weatherCache.set(key, { value, expires: Date.now() + WEATHER_TTL_MS });
      if (weatherCache.size > WEATHER_CACHE_MAX) weatherCache.delete(weatherCache.keys().next().value);
      return value;
    })
    .finally(() => weatherPending.delete(key));
  weatherPending.set(key, pending);
  return pending;
}

async function getAmbientWeather({ ip, connection, mobileDevice }) {
  ensureGeoLoaded();
  const loc = lookup(ip);
  if (!loc || !isLocationReliable({ asn: loc.asn, connection, mobileDevice })) return null;
  try {
    return await weatherFor(loc.lat, loc.lon);
  } catch {
    return null;
  }
}

module.exports = {
  getAmbientWeather,
  warmUp: ensureGeoLoaded,
  _test: { parseIp, ipv6High64, parseCityLine, parseAsnLine, newTable, freeze, lookup, isLocationReliable, classifySymbol, candidateMonths }
};
