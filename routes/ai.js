const express = require("express");
const { asyncHandler, sendError } = require("../utils");
const { requireGameAccess } = require("../services/auth");
const { evaluateCardResponse } = require("../game/cards");

const router = express.Router();

// POST /ai/evaluate-response — árbitro de IA que avalia se a resposta do jogador satisfaz o pedido da carta
router.post("/ai/evaluate-response", requireGameAccess, asyncHandler(async (req, res) => {
  const { cardText, playerMessage } = req.body || {};

  if (!cardText || !playerMessage) return sendError(res, 400, "CAMPOS_OBRIGATORIOS");

  const result = await evaluateCardResponse({
    cardText,
    playerMessage,
    requestId: req.requestId || ""
  });

  return res.json({ ok: true, valid: result.valid, confidence: result.confidence });
}));

module.exports = router;
