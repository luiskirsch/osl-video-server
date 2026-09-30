"use strict";

/**
 * A restricao administrativa tem precedencia sobre o opt-in feito pelo
 * profissional. Ela afeta somente a listagem na rede publica; links diretos e
 * o acesso do profissional continuam sendo tratados pelas rotas especificas.
 */
function isPublicDirectoryEligible(therapist = {}) {
  return therapist.verificationStatus === "verified"
    && (therapist.publicSchedulingEnabled === true || therapist.listPublicly === true)
    && therapist.adminDirectoryBlocked !== true;
}

module.exports = { isPublicDirectoryEligible };
