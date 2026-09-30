"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { getPublicDirectoryVisibility, isPublicDirectoryEligible } = require("../services/public-directory");

test("admin pode exibir profissional verificado mesmo sem opt-in ou agendamento", () => {
  assert.equal(isPublicDirectoryEligible({
    verificationStatus: "verified",
    adminDirectoryVisible: true,
    publicSchedulingEnabled: false,
    listPublicly: false
  }), true);
});

test("admin pode ocultar profissional mesmo que o opt-in legado esteja ativo", () => {
  assert.equal(isPublicDirectoryEligible({
    verificationStatus: "verified",
    listPublicly: true,
    adminDirectoryVisible: false
  }), false);
});

test("perfil continua exigindo verificacao para aparecer", () => {
  assert.equal(isPublicDirectoryEligible({ adminDirectoryVisible: true }), false);
  assert.equal(isPublicDirectoryEligible({ verificationStatus: "verified" }), false);
});

test("migracao preserva escolha antiga sem permitir novo auto-opt-in", () => {
  assert.equal(getPublicDirectoryVisibility({ listPublicly: true }), true);
  assert.equal(getPublicDirectoryVisibility({ listPublicly: false }), false);
  assert.equal(getPublicDirectoryVisibility({ listPublicly: true, adminDirectoryBlocked: true }), false);
  assert.equal(getPublicDirectoryVisibility({ listPublicly: false, adminDirectoryBlocked: false }), true);
});

test("rota de perfil nao permite que profissional altere a propria visibilidade", () => {
  const route = readFileSync(resolve(__dirname, "../routes/therapy.js"), "utf8");
  assert.doesNotMatch(route, /updates\.listPublicly\s*=/);
  assert.match(route, /body\.setAdminDirectoryVisible/);
});
