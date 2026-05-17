const { httpFetch } = require("../utils");
const { MP_ACCESS_TOKEN_JOGO, MP_ACCESS_TOKEN_THERAPY } = require("../config");

// Fabrica uma fn fetch do MP atrelada a um token específico. Cada produto
// (jogo vs therapy) aponta pra uma aplicação MP distinta — dinheiro vai
// pra contas separadas. Veja config.js pra detalhes do fallback legado.
function makeMpFetch(token, label) {
  return async function mercadoPagoFetchImpl(url, options = {}) {
    if (!token) throw new Error(`MP_ACCESS_TOKEN_NAO_CONFIGURADO_${label}`);
    const response = await httpFetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(options.headers || {})
      }
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  };
}

const mercadoPagoFetchJogo    = makeMpFetch(MP_ACCESS_TOKEN_JOGO,    "JOGO");
const mercadoPagoFetchTherapy = makeMpFetch(MP_ACCESS_TOKEN_THERAPY, "THERAPY");

// Alias legado — aponta pro jogo. Mantido pra não quebrar imports de
// routes/payments.js e routes/license.js que ainda usam o nome antigo.
// Novos call sites devem importar Jogo/Therapy explicitamente.
const mercadoPagoFetch = mercadoPagoFetchJogo;

module.exports = { mercadoPagoFetch, mercadoPagoFetchJogo, mercadoPagoFetchTherapy };
