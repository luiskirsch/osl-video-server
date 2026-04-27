const { logInfo, logWarn } = require("../logger");
const { httpFetch, sleep, sanitizeNextPath, normalizeUid, normalizeEmail, sendError } = require("../utils");
const { signPayload, verifySignedToken } = require("./auth");
const { getUserProfileByUid, getAffiliateProfileByUid } = require("./firestore");
const {
  DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN,
  DISCORD_GUILD_ID, DISCORD_REDIRECT_URI,
  DISCORD_ROLE_BUYER_ID, DISCORD_ROLE_AFFILIATE_ID,
  DISCORD_API_BASE, ACCESS_TOKEN_SECRET, BACKEND_BASE_URL
} = require("../config");

// --- Guard de configuração ---

function ensureDiscordConfigured(res) {
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID || !DISCORD_REDIRECT_URI) {
    sendError(res, 500, "DISCORD_NAO_CONFIGURADO");
    return false;
  }
  return true;
}

// --- HTTP clients Discord ---

async function discordApiFetch(url, options = {}) {
  const response = await httpFetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      "User-Agent": "O-SextoLugar/1.0",
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text || null; }

  return { response, data };
}

async function discordTokenFetch(bodyParams) {
  const body = new URLSearchParams(bodyParams);

  const response = await httpFetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "O-SextoLugar/1.0"
    },
    body: body.toString()
  });

  const rawText = await response.text();
  let data;
  try { data = rawText ? JSON.parse(rawText) : {}; } catch { data = { raw: rawText }; }

  logInfo("discord_token_response", {
    status: response.status,
    retryAfter: response.headers.get("retry-after") || null,
    resetAfter: response.headers.get("x-ratelimit-reset-after") || null
  });

  return { response, data, rawText };
}

// --- Serviço Discord ---

async function exchangeDiscordCode(code) {
  const payload = {
    client_id: DISCORD_CLIENT_ID,
    client_secret: DISCORD_CLIENT_SECRET,
    grant_type: "authorization_code",
    code: String(code || "").trim(),
    redirect_uri: DISCORD_REDIRECT_URI
  };

  let result = await discordTokenFetch(payload);

  if (result.response.status === 429) {
    const retryFromJson   = Number(result.data?.retry_after || 0);
    const retryFromHeader = Number(result.response.headers.get("retry-after") || 0);
    const waitSeconds     = Math.max(retryFromJson, retryFromHeader, 30);
    logWarn("discord_rate_limit_wait", { waitSeconds });
    await sleep(waitSeconds * 1000);
    result = await discordTokenFetch(payload);
  }

  return result;
}

async function getDiscordCurrentUser(userAccessToken) {
  return discordApiFetch(`${DISCORD_API_BASE}/users/@me`, {
    method: "GET",
    headers: { Authorization: `Bearer ${userAccessToken}` }
  });
}

async function addDiscordUserToGuild({ discordUserId, userAccessToken }) {
  return discordApiFetch(
    `${DISCORD_API_BASE}/guilds/${DISCORD_GUILD_ID}/members/${discordUserId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
      body: JSON.stringify({ access_token: userAccessToken })
    }
  );
}

async function addDiscordRoleToMember({ discordUserId, roleId }) {
  if (!roleId) return { response: { ok: true, status: 204 }, data: null };
  return discordApiFetch(
    `${DISCORD_API_BASE}/guilds/${DISCORD_GUILD_ID}/members/${discordUserId}/roles/${roleId}`,
    { method: "PUT", headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
  );
}

async function removeDiscordRoleFromMember({ discordUserId, roleId }) {
  if (!roleId) return { response: { ok: true, status: 204 }, data: null };
  return discordApiFetch(
    `${DISCORD_API_BASE}/guilds/${DISCORD_GUILD_ID}/members/${discordUserId}/roles/${roleId}`,
    { method: "DELETE", headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
  );
}

async function getDiscordGuildMember(discordUserId) {
  return discordApiFetch(
    `${DISCORD_API_BASE}/guilds/${DISCORD_GUILD_ID}/members/${discordUserId}`,
    { method: "GET", headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
  );
}

// --- Sync de roles ---

async function syncDiscordRolesForUid(uid) {
  const normalizedUid = normalizeUid(uid);
  if (!normalizedUid) return { ok: false, error: "UID_OBRIGATORIO" };

  const userProfile = await getUserProfileByUid(normalizedUid);
  if (!userProfile?.discordUserId) return { ok: false, error: "DISCORD_NAO_VINCULADO" };

  const affiliate    = await getAffiliateProfileByUid(normalizedUid);
  const discordUserId = String(userProfile.discordUserId || "").trim();

  const shouldHaveBuyerRole     = !!userProfile.licenseLinked || !!userProfile?.access?.active;
  const shouldHaveAffiliateRole = !!affiliate;

  const guildMemberRes = await getDiscordGuildMember(discordUserId);
  if (!guildMemberRes.response.ok) {
    return { ok: false, error: "MEMBRO_DISCORD_NAO_ENCONTRADO", details: guildMemberRes.data || null };
  }

  if (DISCORD_ROLE_BUYER_ID) {
    if (shouldHaveBuyerRole) {
      await addDiscordRoleToMember({ discordUserId, roleId: DISCORD_ROLE_BUYER_ID });
    } else {
      await removeDiscordRoleFromMember({ discordUserId, roleId: DISCORD_ROLE_BUYER_ID });
    }
  }

  if (DISCORD_ROLE_AFFILIATE_ID) {
    if (shouldHaveAffiliateRole) {
      await addDiscordRoleToMember({ discordUserId, roleId: DISCORD_ROLE_AFFILIATE_ID });
    } else {
      await removeDiscordRoleFromMember({ discordUserId, roleId: DISCORD_ROLE_AFFILIATE_ID });
    }
  }

  return { ok: true, discordUserId, buyerRoleApplied: !!shouldHaveBuyerRole, affiliateRoleApplied: !!shouldHaveAffiliateRole };
}

// --- Construtores de URL ---

function buildDiscordState(payload) {
  return signPayload(
    { ...payload, iat: Date.now(), exp: Date.now() + 10 * 60 * 1000 },
    ACCESS_TOKEN_SECRET
  );
}

function buildDiscordAuthorizeUrl({ uid, next = "/painel.html" }) {
  const state = buildDiscordState({ uid: normalizeUid(uid), next: sanitizeNextPath(next) });
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    response_type: "code",
    redirect_uri: DISCORD_REDIRECT_URI,
    scope: "identify guilds.join",
    prompt: "consent",
    state
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

module.exports = {
  ensureDiscordConfigured,
  discordApiFetch, discordTokenFetch,
  exchangeDiscordCode, getDiscordCurrentUser,
  addDiscordUserToGuild, addDiscordRoleToMember, removeDiscordRoleFromMember, getDiscordGuildMember,
  syncDiscordRolesForUid,
  buildDiscordState, buildDiscordAuthorizeUrl
};
