"use strict";

/**
 * A visibilidade e controlada pelo admin. Durante a migracao, preservamos o
 * ultimo opt-in salvo, mas ele deixou de ser gravavel pelo profissional.
 */
function getPublicDirectoryVisibility(therapist = {}) {
  if (typeof therapist.adminDirectoryVisible === "boolean") {
    return therapist.adminDirectoryVisible;
  }
  if (typeof therapist.adminDirectoryBlocked === "boolean") {
    return !therapist.adminDirectoryBlocked;
  }
  return therapist.listPublicly === true;
}

function isPublicDirectoryEligible(therapist = {}) {
  return therapist.verificationStatus === "verified"
    && getPublicDirectoryVisibility(therapist);
}

module.exports = { getPublicDirectoryVisibility, isPublicDirectoryEligible };
