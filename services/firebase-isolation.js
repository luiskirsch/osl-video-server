"use strict";
function assertFirebaseIsolation(projectId, env = process.env) {
  const expected = env.FIREBASE_EXPECTED_PROJECT_ID;
  if (expected && projectId !== expected) throw new Error("FIREBASE_PROJECT_MISMATCH");
  if (env.SERVICE_PRODUCT === "preludio") {
    const stage = String(env.APP_ENV || "").toLowerCase() === "staging";
    const allowed = stage ? ["sextolugar-staging", "espaco-preludio-hml"] : ["osextolugar-game", "espaco-preludio-clinico"];
    if (!allowed.includes(projectId)) throw new Error("FIREBASE_PROJECT_NOT_ALLOWED_IN_ENVIRONMENT");
    if (env.GAME_ENABLED === "true") throw new Error("CLINICAL_SERVICE_CANNOT_ENABLE_GAME");
    if (projectId === "osextolugar-jogo") throw new Error("CLINICAL_SERVICE_CANNOT_USE_GAME_PROJECT");
  }
}
module.exports = { assertFirebaseIsolation };
