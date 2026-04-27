const Anthropic = require("@anthropic-ai/sdk");
const { logInfo } = require("../logger");
const { ANTHROPIC_API_KEY } = require("../config");

// Avalia se a resposta do jogador atende ao pedido da carta usando Claude Haiku.
// Retorna { valid: boolean, confidence: number }
async function evaluateCardResponse({ cardText, playerMessage, requestId = "" }) {
  if (!ANTHROPIC_API_KEY) {
    return { valid: true, confidence: 50 };
  }

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 120,
    messages: [
      {
        role: "user",
        content: `Você é árbitro do jogo "O SextoLugar". Avalie objetivamente se a resposta do jogador atende ao pedido da carta.
Pedido da carta: "${cardText.slice(0, 400)}"
Resposta do jogador: "${playerMessage.slice(0, 600)}"
Responda APENAS com JSON válido, sem markdown: {"valid": true, "confidence": 85}`
      }
    ]
  });

  let result = { valid: true, confidence: 70 };
  try {
    const text = msg.content[0]?.text || "{}";
    const match = text.match(/\{[^}]+\}/);
    if (match) result = JSON.parse(match[0]);
  } catch (_) {}

  logInfo("ai_evaluate_response", {
    valid: result.valid,
    confidence: result.confidence,
    requestId
  });

  return { valid: !!result.valid, confidence: result.confidence ?? 70 };
}

module.exports = { evaluateCardResponse };
