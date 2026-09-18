const express = require("express");
const { logError, logInfo } = require("../logger");
const { asyncHandler, sendError, normalizeUid, sanitizeNextPath } = require("../utils");
const { ensureDb, saveDiscordLinkToUser, getUserProfileByUid, requireFirebaseAuth } = require("../services/firestore");
const {
  ensureDiscordConfigured,
  exchangeDiscordCode, getDiscordCurrentUser, addDiscordUserToGuild,
  syncDiscordRolesForUid, buildDiscordAuthorizeUrl
} = require("../services/discord");
const { verifySignedToken } = require("../services/auth");
const { ACCESS_TOKEN_SECRET, FRONTEND_BASE_URL } = require("../config");

const router = express.Router();

async function beginDiscordConnect(req, res, returnJson) {
  if (!ensureDb(res) || !ensureDiscordConfigured(res)) return;

  const uid = normalizeUid(req.firebaseUser?.uid);
  const requestedUid = normalizeUid(req.query.uid || req.body?.uid);
  const next = sanitizeNextPath(req.query.next || req.body?.next || "/painel.html");

  if (!uid) return sendError(res, 400, "UID_OBRIGATORIO");
  if (requestedUid && requestedUid !== uid) return sendError(res, 403, "UID_NAO_CORRESPONDE");

  const authUrl = buildDiscordAuthorizeUrl({ uid, next });
  if (returnJson) return res.json({ ok: true, url: authUrl });
  return res.redirect(302, authUrl);
}

router.post("/discord/connect", requireFirebaseAuth, asyncHandler(async (req, res) => {
  return beginDiscordConnect(req, res, true);
}));

router.get("/discord/connect", requireFirebaseAuth, asyncHandler(async (req, res) => {
  return beginDiscordConnect(req, res, false);
}));

router.get("/discord/callback", asyncHandler(async (req, res) => {
  if (!ensureDb(res) || !ensureDiscordConfigured(res)) return;

  const code  = String(req.query.code  || "").trim();
  const state = String(req.query.state || "").trim();

  if (!code || !state) return res.status(400).send("Parâmetros do Discord ausentes.");

  const stateVerification = verifySignedToken(state, ACCESS_TOKEN_SECRET);
  if (!stateVerification.valid) return res.status(401).send("Estado OAuth inválido ou expirado.");

  const { uid, next, iat, exp } = stateVerification.payload || {};
  if (!Number.isFinite(iat) || !Number.isFinite(exp) || exp - iat > 10 * 60 * 1000) {
    return res.status(401).send("Estado OAuth invalido ou expirado.");
  }
  if (!normalizeUid(uid)) return res.status(400).send("UID inválido no fluxo do Discord.");

  const tokenRes = await exchangeDiscordCode(code);

  if (!tokenRes.response.ok || !tokenRes.data?.access_token) {
    logError("discord_token_failed", new Error("discord token fail"), {
      status: tokenRes.response.status,
      providerError: String(tokenRes.data?.error || "").slice(0, 80)
    });
    if (tokenRes.response.status === 429) {
      return res.status(429).send("Discord bloqueou temporariamente a autenticação. Aguarde e tente novamente.");
    }
    return res.status(500).send("Não foi possível autenticar com o Discord. Verifique os logs do servidor.");
  }

  const discordAccessToken = String(tokenRes.data.access_token || "").trim();
  const meRes = await getDiscordCurrentUser(discordAccessToken);

  if (!meRes.response.ok || !meRes.data?.id) {
    logError("discord_me_failed", new Error("discord me fail"), { status: meRes.response.status });
    return res.status(500).send("Não foi possível obter os dados do Discord.");
  }

  const discordUser = meRes.data;

  const joinRes = await addDiscordUserToGuild({
    discordUserId: String(discordUser.id || ""),
    userAccessToken: discordAccessToken
  });

  if (![201, 204].includes(Number(joinRes.response.status))) {
    logInfo("discord_join_guild_failed", { status: joinRes.response.status });
  }

  await saveDiscordLinkToUser({ uid: normalizeUid(uid), discordUser, discordAccessToken: "" });

  const syncResult = await syncDiscordRolesForUid(normalizeUid(uid));
  logInfo("discord_sync_result", syncResult);

  const redirectTarget = `${FRONTEND_BASE_URL}${sanitizeNextPath(next)}?discord=connected`;
  return res.redirect(302, redirectTarget);
}));

router.get("/discord/status/:uid", requireFirebaseAuth, asyncHandler(async (req, res) => {
  if (!ensureDb(res)) return;

  const uid = normalizeUid(req.params.uid);
  if (!uid) return sendError(res, 400, "UID_OBRIGATORIO");
  if (uid !== req.firebaseUser.uid) return sendError(res, 403, "UID_NAO_CORRESPONDE");

  const userProfile = await getUserProfileByUid(uid);

  return res.json({
    ok: true,
    discordLinked: !!userProfile?.discordLinked,
    discordUserId: userProfile?.discordUserId || "",
    discordUsername: userProfile?.discordUsername || "",
    discordGlobalName: userProfile?.discordGlobalName || "",
    discordAvatar: userProfile?.discordAvatar || ""
  });
}));

router.post("/discord/sync/:uid", requireFirebaseAuth, asyncHandler(async (req, res) => {
  if (!ensureDb(res) || !ensureDiscordConfigured(res)) return;

  const uid = normalizeUid(req.params.uid);
  if (!uid) return sendError(res, 400, "UID_OBRIGATORIO");
  if (uid !== req.firebaseUser.uid) return sendError(res, 403, "UID_NAO_CORRESPONDE");

  const result = await syncDiscordRolesForUid(uid);
  if (!result.ok) return sendError(res, 400, result.error, { details: result.details || null });

  return res.json({ ok: true, ...result });
}));

module.exports = router;
