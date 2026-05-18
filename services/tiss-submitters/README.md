# TISS Submitters — Como adicionar um novo convênio

Este diretório contém implementações de auto-submit TISS por convênio.

## Arquitetura

```
_base.js     → TissSubmitterBase (interface abstrata)
_signer.js   → Assinatura XML-DSig com cert A1 ICP-Brasil
_mock.js     → Mock pra testes sem credenciais reais
<convenio>.js → Implementação específica (Bradesco, Unimed, etc.)
```

## Como funciona o registry

Em `routes/therapy.js`:

```js
const TISS_SUBMITTERS = {
  "bradesco":     require("./tiss-submitters/bradesco").TissBradescoSubmitter,
  "unimed-poa":   require("./tiss-submitters/unimed-poa").TissUnimedPoaSubmitter,
  // ...
};
```

A KEY (`"bradesco"`, `"unimed-poa"`) precisa bater EXATAMENTE com o `code` que o profissional cadastra em **Perfil → Convênios TISS** no frontend.

Quando o profissional clica **🚀 Enviar pro convênio** na página `tiss.html`,
o frontend chama `GET /tiss/submitters` que lista os codes com submitter
disponível. O botão só aparece se houver match entre convênios cadastrados
e submitters implementados.

## Pré-requisitos pra implementar um convênio real

Você precisa OBTER do convênio (após credenciamento como prestador):

1. **URL do WebService** — endpoint da API (sandbox + produção separados)
2. **Especificação técnica** — REST? SOAP? Autenticação? Headers?
3. **WSDL** (se SOAP) — define operações disponíveis
4. **Credenciais sandbox** — login/token de teste
5. **Versão TISS aceita** — 4.01.00 (atual) ou 3.05.00 (legado)
6. **A1 cert ICP-Brasil** — pessoal do profissional (não da plataforma)

## Template

```js
// services/tiss-submitters/bradesco.js
const { TissSubmitterBase } = require("./_base");

class TissBradescoSubmitter extends TissSubmitterBase {
  get displayName() { return "Bradesco Saúde"; }
  get tissVersion() { return "4.01.00"; }
  get requiresSignature() { return true; }

  validateConfig() {
    if (!this.config.certPfx) throw new Error("CERT_AUSENTE");
    if (!this.config.codigoPrestador) throw new Error("CODIGO_PRESTADOR_AUSENTE");
  }

  async submitLote({ xml, hash, totalGuias, numeroLote }) {
    const endpoint = this.config.sandboxMode
      ? "https://homolog.bradescosaude.com.br/api/tiss/loteGuias"
      : "https://prod.bradescosaude.com.br/api/tiss/loteGuias";

    // 1. Auth: OAuth2 ou cert-based (verificar doc real)
    // 2. POST do XML (multipart ou body direto)
    // 3. Parse da resposta XML pra extrair protocolo + numerosGuiaOperadora

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/xml",
        "X-Cnpj-Prestador": this.config.codigoPrestador,
        // Auth headers conforme doc Bradesco
      },
      body: xml
    });

    if (!response.ok) {
      return { ok: false, error: "HTTP_" + response.status, httpStatus: response.status };
    }

    const respXml = await response.text();
    // Parse de respXml pra extrair:
    //   - protocolo de retorno
    //   - mapeamento numeroGuiaPrestador → numeroGuiaOperadora
    const protocolo = (respXml.match(/<protocolo>([^<]+)<\/protocolo>/) || [])[1];

    return {
      ok: true,
      protocolo,
      mensagem: `Lote ${numeroLote} aceito pelo Bradesco`,
      numeroGuiaOperadoraMap: {} // preencher conforme parser
    };
  }

  async checkStatus(protocolo) {
    // GET /api/tiss/protocolo/{protocolo}
    // Parse → { status, guias: [...] }
  }
}

module.exports = { TissBradescoSubmitter };
```

## Onde editar quando adicionar novo convênio

1. Criar arquivo `services/tiss-submitters/<nome>.js`
2. Editar `routes/therapy.js`, adicionar no `TISS_SUBMITTERS`:
   ```js
   const { TissBradescoSubmitter } = require("../services/tiss-submitters/bradesco");
   TISS_SUBMITTERS["bradesco"] = TissBradescoSubmitter;
   ```
3. Push pro Railway → deploy automático
4. Frontend `tiss.html` automaticamente mostra botão "Enviar pro convênio"
   quando o profissional tem aquele convênio cadastrado.

## Testes sem credenciais reais

Habilite o mock setando env `TISS_MOCK_ENABLED=1` no Railway. Aí
o registry expõe `mock` como convênio disponível. Profissional cadastra
um convênio com `code = "mock"` em Perfil → Convênios TISS e pode usar
o fluxo completo sem precisar de cert ou credenciais reais.

## Compliance

- Certificado A1 NUNCA é persistido — recebido via API, usado pra assinar,
  descartado. Endpoint `POST /tiss/submeter` recebe `certPfxBase64` no body
  e nem loga.
- XML assinado e protocolo retornado SÃO persistidos pra audit/replay.
- LGPD: dados de paciente no XML são minimizados (TISS 4.01.00 removeu
  nome do beneficiário e CNS por padrão — só carteirinha).
