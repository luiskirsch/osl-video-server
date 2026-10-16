"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const firestore = require("../services/firestore");
const files = require("../services/private-files");

function fixture(t) {
  const rows = new Map();
  const stats = { reads: 0, commits: 0, fail: false };
  function doc(path) {
    return { path, collection: name => collection(path + "/" + name),
      get: async () => { stats.reads++; return { exists: rows.has(path), data: () => rows.get(path) }; } };
  }
  function collection(path) {
    let cap = Infinity;
    return { doc: id => doc(path + "/" + id), orderBy() { return this; },
      limit(value) { cap = value; return this; },
      async get() {
        stats.reads++;
        assert.ok(Number.isFinite(cap), "private chunk reads must be bounded");
        return { docs: [...rows.entries()].filter(([key]) => key.startsWith(path + "/") && !key.slice(path.length + 1).includes("/"))
          .sort((a, b) => a[1].i - b[1].i).slice(0, cap)
          .map(([key, value]) => ({ ref: doc(key), data: () => value })) };
      }
    };
  }
  t.mock.method(firestore, "getDb", () => ({ collection, batch() {
    const pending = [];
    return { create: (ref, value) => pending.push({ ref, value }), delete: ref => pending.push({ ref, remove: true }),
      async commit() {
        stats.commits++;
        if (stats.fail || pending.some(row => !row.remove && rows.has(row.ref.path))) throw new Error("WRITE_FAILED");
        for (const row of pending) { if (row.remove) rows.delete(row.ref.path); else rows.set(row.ref.path, row.value); }
      }
    };
  } }));
  return { rows, stats };
}

test("private files round-trip across chunks and delete atomically using the modular SDK database", async t => {
  const f = fixture(t);
  const bytes = Buffer.alloc(700_021, 123);
  const path = await files.savePrivateFile("synthetic-verification", bytes, { contentType: "application/pdf" });
  assert.match(path, /^fs:[a-f0-9]{64}$/);
  assert.equal(f.rows.size, 3);
  assert.deepEqual(await files.readPrivateFile(path), bytes);
  await files.deletePrivateFile(path);
  assert.equal(f.rows.size, 0);
  await assert.rejects(files.readPrivateFile(path), { code: "ARQUIVO_NAO_ENCONTRADO" });
});

test("new file identities do not collide after normalization or truncation and cannot overwrite", async t => {
  const f = fixture(t);
  const bytes = Buffer.from("synthetic");
  const paths = await Promise.all(["a/b", "a_b", "x".repeat(201) + "a", "x".repeat(201) + "b"]
    .map(key => files.savePrivateFile(key, bytes)));
  assert.equal(new Set(paths).size, paths.length);
  const before = [...f.rows.entries()];
  await assert.rejects(files.savePrivateFile("a/b", Buffer.from("replacement")), /WRITE_FAILED/);
  assert.deepEqual([...f.rows.entries()], before);
});

test("failed uploads or deletes leave no partial mutation", async t => {
  const f = fixture(t); f.stats.fail = true;
  await assert.rejects(files.savePrivateFile("synthetic", Buffer.from("test")), /WRITE_FAILED/);
  assert.equal(f.rows.size, 0);
  f.stats.fail = false;
  const path = await files.savePrivateFile("synthetic", Buffer.from("test"));
  f.stats.fail = true;
  await assert.rejects(files.deletePrivateFile(path), /WRITE_FAILED/);
  assert.equal(f.rows.size, 2);
});

test("invalid paths and upload bounds fail before any database operation", async t => {
  const f = fixture(t);
  for (const path of [null, "fs:", "fs:.", "fs:..", "fs:a/b", "fs:a?b", "gs:abc", "fs:" + "x".repeat(201)]) {
    await assert.rejects(files.readPrivateFile(path), { code: "CAMINHO_ARQUIVO_INVALIDO" });
    await assert.rejects(files.deletePrivateFile(path), { code: "CAMINHO_ARQUIVO_INVALIDO" });
  }
  for (const buffer of ["text", Buffer.alloc(0), Buffer.alloc(4 * 1024 * 1024 + 1)]) {
    await assert.rejects(files.savePrivateFile("valid", buffer), { code: "TAMANHO_ARQUIVO_INVALIDO" });
  }
  await assert.rejects(files.savePrivateFile("", Buffer.from("test")), { code: "CHAVE_ARQUIVO_INVALIDA" });
  await assert.rejects(files.savePrivateFile("valid", Buffer.from("test"), { contentType: "application/pdf\r\nInjected: yes" }), { code: "TIPO_ARQUIVO_INVALIDO" });
  assert.equal(f.stats.reads + f.stats.commits, 0);
});

test("legacy private references stay readable, but incomplete or malformed chunks fail closed", async t => {
  const f = fixture(t);
  const root = "private_files/verif_legacy.pdf";
  f.rows.set(root, { size: 4, chunks: 1, contentType: "application/pdf" });
  f.rows.set(root + "/chunks/000", { i: 0, data: Buffer.from("test").toString("base64") });
  assert.deepEqual(await files.readPrivateFile("fs:verif_legacy.pdf"), Buffer.from("test"));
  for (const change of [
    () => f.rows.set(root, { size: 4, chunks: 2 }),
    () => { f.rows.set(root, { size: 4, chunks: 1 }); f.rows.delete(root + "/chunks/000"); },
    () => f.rows.set(root + "/chunks/000", { i: 1, data: "dGVzdA==" }),
    () => f.rows.set(root + "/chunks/000", { i: 0, data: "dGVzdA=!" }),
    () => { f.rows.set(root + "/chunks/000", { i: 0, data: "dGVzdA==" }); f.rows.set(root + "/chunks/001", { i: 1, data: "AA==" }); }
  ]) {
    change();
    await assert.rejects(files.readPrivateFile("fs:verif_legacy.pdf"), { code: "ARQUIVO_INTEGRO_INVALIDO" });
  }
});

test("checksums reject same-size tampering; corrupt metadata cannot trigger unbounded reads", async t => {
  const f = fixture(t);
  const path = await files.savePrivateFile("synthetic", Buffer.from("test"));
  const root = "private_files/" + path.slice(3);
  f.rows.get(root + "/chunks/000").data = Buffer.from("evil").toString("base64");
  await assert.rejects(files.readPrivateFile(path), { code: "ARQUIVO_INTEGRO_INVALIDO" });
  for (const data of [{ size: Infinity, chunks: 1 }, { size: 9e9, chunks: 1 }, { size: 4, chunks: 1, sha256: 123 }]) {
    f.rows.set(root, data);
    const before = f.stats.reads;
    await assert.rejects(files.readPrivateFile(path), { code: "ARQUIVO_INTEGRO_INVALIDO" });
    assert.equal(f.stats.reads - before, 1);
  }
});
