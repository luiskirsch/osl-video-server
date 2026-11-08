# Assinatura de documentos e exportação TISS

## O que foi implementado

- A1: o profissional envia o PDF, o próprio e-CPF (.pfx/.p12) e a senha por HTTPS. Um processo isolado usa pyHanko para produzir PAdES/SHA-256, em memória. Certificado e senha não são salvos. O formulário limpa esses campos ao concluir a tentativa.
- Assinatura externa: o profissional assina o PDF em um serviço de sua escolha com e-CPF ICP-Brasil e envia o resultado. O mesmo validador é aplicado. Assinaturas avançadas gov.br não passam neste fluxo que exige ICP-Brasil.
- O servidor exige uma assinatura, cobertura integral do arquivo, integridade criptográfica, cadeia até uma raiz ICP-Brasil admitida, certificado dentro da validade, identidade correspondente ao nome/CPF do profissional e evidência atual de não revogação. Falha ou indisponibilidade mantém o rascunho.
- O CPF do primeiro certificado validado fica vinculado à conta. O registro profissional precisa estar verificado no fluxo administrativo existente. A verificação do certificado não substitui essa verificação do conselho.
- A transação preserva o PDF verificado, SHA-256 do PDF/certificado, data de verificação e dados do emitente. Documentos antigos sem essa evidência não recebem a indicação de conferência automática.
- O limite do PDF final em base64 é 850.000 caracteres, para respeitar o tamanho máximo do registro Firestore junto ao formulário cifrado.
- Exportação de consulta e SP/SADT em TISS 4.03.00. Todo XML exportado é validado com o XSD oficial da ANS, incluído no repositório. Hash MD5 calculado sobre valores dos elementos em ISO-8859-1. Um lote admite de 1 a 100 guias do mesmo tipo e operadora.
- O profissional informa CNES, código de prestador, registro ANS, UF e CBO em Perfil. Em TISS, prepara a guia de uma sessão realizada, com carteirinha, procedimento/valor contratado e, em SP/SADT, dados do solicitante conforme o encaminhamento.

## Dependências para o aceite em uso real

Ainda não houve teste com e-CPF de um profissional real disponível no projeto. Os testes criptográficos usam uma autoridade sintética, que o validador de produção rejeita. Não constituem aprovação pelo ITI. Antes de anunciar aceite externo comprovado: emitir um documento de teste sem dados de paciente com o profissional, baixar o PDF e conferir em https://validar.iti.gov.br/. Nunca compartilhar certificado ou senha em chamados, Git ou chat.

Nenhuma operadora possui conexão automática implementada/homologada neste momento. O caminho disponível é exportar XML validado e submetê-lo no portal da operadora pelo prestador credenciado. A configuração, regras contratuais e eventuais exigências de assinatura/versão de cada operadora precisam ser confirmadas com ela. Schema válido não garante autorização, cobertura ou pagamento.

Uma integração direta exige operadora/unidade identificada, prestador credenciado, manual técnico, endpoint e credenciais de homologação. “Unimed”, por exemplo, não representa um único endpoint nacional. O registro de conectores em produção permanece vazio; o conector de simulação só pode ser habilitado fora de produção. Não há protocolo simulado apresentado como aceite real.

Assinatura técnica não certifica, por si, conteúdo clínico, autorização sanitária ou habilitação para prescrever cada substância. Não há integração SNCR implementada por esta alteração.

## Instalação e manutenção

O Docker instala o Python/venv e `requirements-validation.txt`. Em desenvolvimento Windows:

```powershell
python -m venv .venv-validation
.\.venv-validation\Scripts\python -m pip install -r requirements-validation.txt
.\.venv-validation\Scripts\python test/validation_worker_test.py
node --test test/clinical-signatures.test.js test/tiss-xml.test.js
```

O Node encontra o venv local ou usa `VALIDATION_PYTHON`. Não existe opção de desativar a validação ICP em produção. A validação limita concorrência, tempo, resposta e acessos de rede a endereços públicos HTTP/HTTPS para revogação; documentos não são enviados a validadores externos. Certificado/senha passam temporariamente pela memória do backend: não configurar captura de corpo de requisição para essas rotas em proxies/APM.

As fontes e SHA-256 dos certificados públicos e schemas estão em `security-assets/manifest.json`. Para atualizar os arquivos oficiais, executar `python scripts/fetch-validation-assets.py`, revisar o diff e repetir os testes antes de publicar. A seleção de raízes fica em `services/validation_worker.py`; raízes revogadas ou destinadas exclusivamente a SSL/código não são aceitas. Não incorporar certificados de teste ao pacote de produção.

Fontes: [ANS — TISS setembro/2026](https://www.gov.br/ans/pt-br/assuntos/prestadores/padrao-para-troca-de-informacao-de-saude-suplementar-2013-tiss/padrao-tiss-setembro-2026), [ITI — repositório da AC Raiz](https://www.gov.br/iti/pt-br/assuntos/repositorio/repositorio-ac-raiz).
