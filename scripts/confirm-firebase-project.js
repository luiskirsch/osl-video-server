"use strict";

/**
 * Evita que scripts administrativos gravem no projeto Firebase errado.
 * O operador precisa confirmar explicitamente o project_id visto na credencial.
 */
function assertFirebaseProjectConfirmed(serviceAccount, operation = "mutação administrativa") {
  const projectId = String(serviceAccount?.project_id || "").trim();
  if (!projectId) {
    throw new Error(`[${operation}] project_id ausente na service account.`);
  }

  const confirmed = String(process.env.CONFIRM_FIREBASE_PROJECT || "").trim();
  if (confirmed !== projectId) {
    throw new Error(
      `[${operation}] projeto não confirmado. Revise o alvo e defina ` +
      `CONFIRM_FIREBASE_PROJECT=${projectId} para executar.`
    );
  }

  console.log(`[project-guard] Projeto confirmado: ${projectId}`);
  return projectId;
}

module.exports = { assertFirebaseProjectConfirmed };
