// Utilitário de retry-com-backoff pra chamadas que falham transientemente.
//
// Casos de uso típicos:
//   - Webhook MP fetch da API do Mercado Pago (network blip)
//   - Writes em Firestore (failure transitório do Google)
//   - Chamadas a Anthropic / ZAPI / Resend
//
// NÃO usar pra:
//   - Validação de input do usuário (não vai virar válido com retry)
//   - 4xx semânticos (NOT_FOUND, FORBIDDEN, etc.)

/**
 * Executa fn(), com retry exponencial em caso de erro transiente.
 *
 * @param {() => Promise<T>} fn
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts=3] — tentativas totais (1 = sem retry)
 * @param {number} [opts.baseDelayMs=200] — delay inicial; dobra a cada tentativa
 * @param {number} [opts.maxDelayMs=5000] — teto do backoff
 * @param {(err: Error, attempt: number) => boolean} [opts.shouldRetry] — predicate;
 *   default = retry em qualquer erro
 * @param {(err: Error, attempt: number, delayMs: number) => void} [opts.onRetry] — callback de log
 * @returns {Promise<T>}
 */
async function withRetry(fn, opts = {}) {
  const {
    maxAttempts = 3,
    baseDelayMs = 200,
    maxDelayMs = 5000,
    shouldRetry = () => true,
    onRetry = () => {}
  } = opts;

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts) break;
      if (!shouldRetry(err, attempt)) break;
      const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      // Adiciona jitter ±25% pra evitar thundering herd
      const jitter = delay * (0.75 + Math.random() * 0.5);
      onRetry(err, attempt, jitter);
      await new Promise(resolve => setTimeout(resolve, jitter));
    }
  }
  throw lastErr;
}

/**
 * Predicate auxiliar — retry em erros típicos de rede (não em 4xx).
 * Use com `shouldRetry: isTransientError`.
 */
function isTransientError(err) {
  if (!err) return false;
  const msg = String(err.message || err.code || "").toLowerCase();
  // Network / DNS / socket
  if (/etimedout|econnreset|econnrefused|enotfound|socket hang up|fetch failed|network/i.test(msg)) return true;
  // HTTP 5xx transitório (quando wrap manual com throw)
  if (/^http (5\d\d|429)/i.test(msg)) return true;
  return false;
}

module.exports = { withRetry, isTransientError };
