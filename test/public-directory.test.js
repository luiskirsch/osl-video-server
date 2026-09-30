"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isPublicDirectoryEligible } = require("../services/public-directory");

test("profissional verificado e com opt-in aparece na rede publica", () => {
  assert.equal(isPublicDirectoryEligible({
    verificationStatus: "verified",
    listPublicly: true
  }), true);
});

test("bloqueio administrativo sempre remove o profissional da rede publica", () => {
  assert.equal(isPublicDirectoryEligible({
    verificationStatus: "verified",
    publicSchedulingEnabled: true,
    listPublicly: true,
    adminDirectoryBlocked: true
  }), false);
});

test("perfil sem verificacao ou sem opt-in nao aparece", () => {
  assert.equal(isPublicDirectoryEligible({ listPublicly: true }), false);
  assert.equal(isPublicDirectoryEligible({ verificationStatus: "verified" }), false);
});
