// Espaço Prelúdio — Submitter MOCK pra testes sem credenciais reais.
//
// Útil enquanto o profissional não tem credenciamento + A1 cert ainda.
// Simula o ciclo de vida completo:
//   submitLote → retorna protocolo fake
//   checkStatus → retorna "paga" após delay configurável
//
// IMPORTANTE: nunca usar em produção real. O registry só liga o mock se a
// env TISS_MOCK_ENABLED=1 estiver ativa. Em prod fica desabilitado por default.

const { TissSubmitterBase } = require("./_base");

class TissMockSubmitter extends TissSubmitterBase {
  get displayName() { return "Mock (apenas testes)"; }
  get requiresSignature() { return false; } // mock aceita XML não assinado

  validateConfig() {} // sem requisitos

  async submitLote({ totalGuias, numeroLote, hash }) {
    // Simula latência de rede da operadora
    await new Promise(r => setTimeout(r, 300));
    const protocolo = `MOCK-${Date.now().toString(36).toUpperCase()}`;
    return {
      ok: true,
      protocolo,
      mensagem: `Lote ${numeroLote} aceito (mock). ${totalGuias} guia(s) processada(s).`,
      hash
    };
  }

  async checkStatus(protocolo) {
    // Mock sempre retorna paga após 1s
    await new Promise(r => setTimeout(r, 100));
    return {
      ok: true,
      status: "paga",
      protocolo,
      mensagem: "Status simulado pelo mock — todas as guias do lote consideradas pagas."
    };
  }

  async fetchDemonstrativo() {
    return { ok: false, error: "MOCK_NAO_GERA_DEMONSTRATIVO" };
  }
}

module.exports = { TissMockSubmitter };
