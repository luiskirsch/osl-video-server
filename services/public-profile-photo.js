"use strict";
const crypto = require("node:crypto");
const { signPayload, verifySignedToken } = require("./auth");
function photoVersion(profile) { return crypto.createHash("sha256").update(String(profile.photoBase64 || "")).digest("hex").slice(0, 24); }
function photoLink(profile, audience = "pacientes", secret = require("../config").ACCESS_TOKEN_SECRET) {
  if (!profile.photoBase64 || !profile.publicSchedulingSlug || !secret) return null;
  const slug = profile.publicSchedulingSlug;
  const token = signPayload({ token_type: "public_profile_photo", slug, audience, version: photoVersion(profile), exp: (Math.floor(Date.now() / 300_000) + 2) * 300_000 }, secret);
  return `/public/profissionais/${encodeURIComponent(slug)}/foto?t=${encodeURIComponent(token)}`;
}
function photoGrant(token, slug, secret = require("../config").ACCESS_TOKEN_SECRET) {
  const result = verifySignedToken(token, secret);
  return result.valid && result.payload.token_type === "public_profile_photo" && result.payload.slug === slug
    && ["pacientes", "programa"].includes(result.payload.audience) ? result.payload : null;
}
module.exports = { photoLink, photoGrant, photoVersion };
