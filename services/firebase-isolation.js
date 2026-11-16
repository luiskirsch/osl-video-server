"use strict";
// Projetos Firebase de cada produto. Um serviço nunca pode abrir o projeto
// do outro — nem por variável trocada no painel do Railway.
const PRELUDIO_PROJECTS = {
  production: ["osextolugar-game", "espaco-preludio-clinico"],
  staging: ["sextolugar-staging", "espaco-preludio-hml"],
};
const GAME_PROJECT = "osextolugar-jogo";

function assertFirebaseIsolation(projectId, env = process.env) {
  const expected = env.FIREBASE_EXPECTED_PROJECT_ID;
  if (expected && projectId !== expected) throw new Error("FIREBASE_PROJECT_MISMATCH");
  const stage = String(env.APP_ENV || "").toLowerCase() === "staging";
  if (env.SERVICE_PRODUCT === "preludio") {
    const allowed = stage ? PRELUDIO_PROJECTS.staging : PRELUDIO_PROJECTS.production;
    if (!allowed.includes(projectId)) throw new Error("FIREBASE_PROJECT_NOT_ALLOWED_IN_ENVIRONMENT");
    if (env.GAME_ENABLED === "true") throw new Error("CLINICAL_SERVICE_CANNOT_ENABLE_GAME");
    if (projectId === GAME_PROJECT) throw new Error("CLINICAL_SERVICE_CANNOT_USE_GAME_PROJECT");
  }
  if (env.SERVICE_PRODUCT === "sextolugar") {
    const clinical = [...PRELUDIO_PROJECTS.production, ...PRELUDIO_PROJECTS.staging];
    if (clinical.includes(projectId)) throw new Error("GAME_SERVICE_CANNOT_USE_CLINICAL_PROJECT");
    // O jogo não tem homologação própria; produção só no projeto dele.
    if (!stage && projectId !== GAME_PROJECT) throw new Error("FIREBASE_PROJECT_NOT_ALLOWED_IN_ENVIRONMENT");
  }
}
module.exports = { assertFirebaseIsolation, GAME_PROJECT };
