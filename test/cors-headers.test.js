const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { CORS_ALLOWED_HEADERS } = require("../config");

// Inseridos pelo proxy do Railway, nunca enviados pelo navegador.
const PROXY_HEADERS = new Set(["x-forwarded-for", "x-forwarded-proto"]);

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".js") ? [full] : [];
  });
}

function headersReadByBackend() {
  const root = path.join(__dirname, "..");
  const files = [
    path.join(root, "server.js"),
    ...["routes", "services", "middleware"].flatMap(dir => sourceFiles(path.join(root, dir)))
  ];
  const pattern = /req\.(?:headers\[\s*["'](x-[a-z0-9-]+)["']\s*\]|(?:get|header)\(\s*["'](x-[a-z0-9-]+)["']\s*\))/gi;
  const found = new Map();
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(pattern)) {
      const header = (match[1] || match[2]).toLowerCase();
      if (!PROXY_HEADERS.has(header)) found.set(header, path.relative(root, file));
    }
  }
  return found;
}

test("todo header X- lido pelo backend está liberado no CORS", () => {
  const allowed = new Set(CORS_ALLOWED_HEADERS.map(h => h.toLowerCase()));
  const read = headersReadByBackend();
  assert.ok(read.size > 0, "a varredura deveria encontrar headers");
  const missing = [...read].filter(([header]) => !allowed.has(header)).map(([h, f]) => `${h} (${f})`);
  assert.deepEqual(missing, [], "o navegador bloqueia em silêncio requests com esses headers");
});

test("headers do upload cifrado do resumo IA e da NFS-e estão liberados", () => {
  const allowed = new Set(CORS_ALLOWED_HEADERS.map(h => h.toLowerCase()));
  for (const header of ["x-ai-result-key", "x-ai-wrapped-key", "x-ai-wrapped-key-iv", "x-nfse-token"]) {
    assert.ok(allowed.has(header), header);
  }
});
