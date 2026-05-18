// Espaço Prelúdio — Interface abstrata pra submitters TISS por convênio.
//
// Cada convênio (Bradesco, Unimed-XYZ, Amil, etc.) tem sua própria API
// — REST, SOAP, ou portal HTTP — e suas próprias credenciais. Esta classe
// base define o CONTRATO que todo submitter deve implementar.
//
// Como adicionar um novo convênio:
//   1. Crie services/tiss-submitters/<nome>.js extendendo TissSubmitterBase
//   2. Implemente submitLote() + checkStatus() (mínimo viável)
//   3. Registre em routes/therapy.js → TISS_SUBMITTERS["<convenio-code>"]
//   4. Frontend automaticamente mostra botão "Enviar pro convênio"
//
// O `convenio-code` é o `code` que o profissional cadastra em Convênios TISS
// (ex: "bradesco", "unimed-poa", "amil"). Match exato — slug lowercase.

class TissSubmitterBase {
  /**
   * @param {object} config — credenciais e settings do submitter.
   *   Estrutura específica de cada convênio. Comum: { endpoint, certPfx,
   *   certPassword, sandboxMode, codigoPrestador }.
   */
  constructor(config = {}) {
    this.config = config;
  }

  /**
   * Nome legível pra UI/logs. Override em cada subclasse.
   * @returns {string}
   */
  get displayName() {
    return "Submitter genérico (não configurado)";
  }

  /**
   * Versão TISS suportada por este submitter. Padrão atual ANS é 4.01.00,
   * mas algumas Unimeds antigas ainda exigem 3.05 ou 3.03.
   * @returns {string}
   */
  get tissVersion() {
    return "4.01.00";
  }

  /**
   * Validação síncrona da config antes de qualquer chamada. Throw se faltar
   * campo obrigatório. Override pra adicionar validações específicas.
   */
  validateConfig() {
    if (!this.config) throw new Error("CONFIG_AUSENTE");
  }

  /**
   * Submete um lote de guias TISS pra operadora.
   *
   * @param {object} params
   * @param {string} params.xml          — XML do lote (já assinado se this.requiresSignature)
   * @param {string} params.hash         — MD5 do XML (pra audit + dedup interno)
   * @param {number} params.totalGuias   — quantas guias no lote
   * @param {string} params.numeroLote   — identificador do lote (pro rastreio)
   *
   * @returns {Promise<{
   *   ok: boolean,
   *   protocolo?: string,       — número de protocolo da operadora (pra checkStatus depois)
   *   numeroGuiaOperadoraMap?: Record<string, string>,  — map numeroGuiaPrestador → numeroGuiaOperadora
   *   error?: string,           — código curto se falhou
   *   detail?: string,          — detalhe técnico (texto)
   *   httpStatus?: number       — status HTTP retornado
   * }>}
   */
  async submitLote(_params) {
    throw new Error("NAO_IMPLEMENTADO: submitLote()");
  }

  /**
   * Consulta status de um protocolo enviado anteriormente.
   *
   * @param {string} protocolo
   * @returns {Promise<{
   *   ok: boolean,
   *   status: "em_analise" | "paga" | "glosada" | "parcial" | "desconhecido",
   *   guias?: Array<{ numeroGuiaPrestador: string, status: string, valorPago?: number, motivoGlosa?: string }>,
   *   error?: string
   * }>}
   */
  async checkStatus(_protocolo) {
    throw new Error("NAO_IMPLEMENTADO: checkStatus()");
  }

  /**
   * Baixa o XML de Demonstrativo de Pagamento (DP) referente a um período.
   * Opcional — alguns convênios não expõem isso via API.
   *
   * @param {object} params
   * @param {number} params.ano
   * @param {number} params.mes
   * @returns {Promise<{ ok: boolean, xml?: string, error?: string }>}
   */
  async fetchDemonstrativo(_params) {
    return { ok: false, error: "NAO_SUPORTADO_POR_ESTE_CONVENIO" };
  }

  /**
   * Indica se este submitter exige XML assinado com A1 cert.
   * @returns {boolean}
   */
  get requiresSignature() {
    return true;
  }
}

module.exports = { TissSubmitterBase };
