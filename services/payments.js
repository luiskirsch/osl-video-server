const { httpFetch } = require("../utils");
const { MP_ACCESS_TOKEN } = require("../config");

async function mercadoPagoFetch(url, options = {}) {
  if (!MP_ACCESS_TOKEN) throw new Error("MP_ACCESS_TOKEN_NAO_CONFIGURADO");

  const response = await httpFetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));
  return { response, data };
}

module.exports = { mercadoPagoFetch };
