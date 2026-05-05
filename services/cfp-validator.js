// services/cfp-validator.js
//
// Strategy pattern para validação automatizada de CRP/CRM.
// Hoje não existe API pública oficial do CFP/CFM — quem oferece esse
// serviço são vendors pagos (Idwall, ConfiraDoc, etc.). Este módulo
// abstrai o vendor: troca o provider via env CFP_VALIDATOR_PROVIDER
// e plugue novas implementações sem alterar o resto do código.
//
// Resposta uniforme:
//   { ok: bool, verified: bool, provider: string, confidence: 0-1, error?: string, raw?: any }
//
// Para ativar Idwall (exemplo):
//   CFP_VALIDATOR_PROVIDER=idwall
//   IDWALL_API_KEY=<token>
//   E completar IdwallValidator.validate() com a chamada real à API deles
//   conforme a documentação ativa no momento da contratação.

const { httpFetch } = require("../utils");
const { logError, logInfo } = require("../logger");

class BaseValidator {
  constructor(name) { this.name = name; }
  async validate(_input) {
    throw new Error("NOT_IMPLEMENTED");
  }
}

// Default: nenhuma validação real. Devolve "not_configured" pra o admin saber
// que precisa configurar o provider antes de usar o botão automatizado.
class MockValidator extends BaseValidator {
  constructor() { super("mock"); }
  async validate({ tipo, numero, nome }) {
    return {
      ok: true,
      verified: false,
      provider: "mock",
      confidence: 0,
      error: "PROVIDER_NAO_CONFIGURADO",
      raw: {
        message: "Configure CFP_VALIDATOR_PROVIDER e as credenciais no Railway. Por ora, faça revisão manual.",
        input: { tipo, numero, nome }
      }
    };
  }
}

// Stub Idwall — plugue a implementação real quando contratar.
// Endpoint provável: POST https://api-v3.idwall.co/profiles (usar SDK oficial é melhor)
class IdwallValidator extends BaseValidator {
  constructor(apiKey) {
    super("idwall");
    this.apiKey = apiKey;
  }
  async validate({ tipo, numero, nome }) {
    if (!this.apiKey) {
      return {
        ok: false, verified: false, provider: "idwall",
        error: "IDWALL_API_KEY_AUSENTE",
        raw: { message: "Setar IDWALL_API_KEY no Railway." }
      };
    }
    // TODO: integrar com a API Idwall.
    // Padrão típico:
    //   1. POST /profiles  → cria perfil com CPF/dados, retorna profile_id
    //   2. POST /profiles/{id}/reports → solicita relatório CRP/CRM
    //   3. GET /reports/{id} → polling até status === "VALID"
    //   4. Mapear validation_status → verified bool
    // Conferir docs atuais (2026): https://developers.idwall.co
    logInfo("idwall_validate_called_stub", { tipo, numero, nome });
    return {
      ok: false, verified: false, provider: "idwall",
      error: "IDWALL_NAO_INTEGRADO",
      raw: {
        message: "Adapter Idwall em modo stub. Implementar chamada real à API conforme docs vigentes.",
        suggested_steps: [
          "1. Cadastrar conta empresarial em developers.idwall.co",
          "2. Obter API Key e configurar IDWALL_API_KEY no Railway",
          "3. Substituir este return pela chamada real (POST /profiles + GET /reports)",
          "4. Mapear o resultado para { verified, confidence }"
        ]
      }
    };
  }
}

// Stub ConfiraDoc — outro vendor possível.
class ConfiraDocValidator extends BaseValidator {
  constructor(apiKey) { super("confiradoc"); this.apiKey = apiKey; }
  async validate({ tipo, numero, nome }) {
    return {
      ok: false, verified: false, provider: "confiradoc",
      error: "CONFIRADOC_NAO_INTEGRADO",
      raw: { message: "Adapter ConfiraDoc em modo stub. Documentação: https://confiradoc.com.br" }
    };
  }
}

function getValidator() {
  const provider = String(process.env.CFP_VALIDATOR_PROVIDER || "mock").toLowerCase();
  switch (provider) {
    case "idwall":     return new IdwallValidator(process.env.IDWALL_API_KEY || "");
    case "confiradoc": return new ConfiraDocValidator(process.env.CONFIRADOC_API_KEY || "");
    case "mock":
    default:           return new MockValidator();
  }
}

module.exports = { getValidator, MockValidator, IdwallValidator, ConfiraDocValidator };
