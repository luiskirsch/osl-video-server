# Módulo de apoio à NR-1 — riscos psicossociais relacionados ao trabalho

## O que está implementado

- Ciclos por empresa e unidade. A abertura exige registrar metodologia, revisor técnico, qualificação e confirmação de revisão do instrumento.
- Lista de participantes independente do benefício clínico. A empresa informa e-mails, que são guardados apenas como HMAC para conferência com conta Firebase de e-mail verificado. Acesso pode ser revogado.
- Pesquisa exploratória original de 19 itens sobre **condições de trabalho** (não é escala clínica, HSE licenciada, diagnóstico de pessoas ou método oficial obrigatório). Uma resposta por conta e campanha; não são gravados nome, e-mail ou UID junto à resposta. O servidor usa identificador pseudônimo determinístico para impedir duplicidade. Unidade e respostas são cifradas com AES-256-GCM antes de gravar no Firestore.
- Resultados empresariais somente após encerrar a coleta e com no mínimo cinco respostas. Se qualquer unidade tiver de uma a quatro respostas, **todos** os recortes por unidade são ocultados para evitar identificação por subtração. Não existe API empresarial para respostas individuais.
- Registro de observações de trabalho e participação dos trabalhadores, inventário **preliminar** de riscos por atividade/unidade com evidências, controles e justificativa, revisão técnica nominal dos riscos, plano de ação com responsável, prazo, critério de verificação e andamento/evidência, além de registro da devolutiva coletiva à equipe.
- Trilhas de auditoria para abertura/fechamento, observações, riscos, revisões e ações. Visão imprimível de apoio à AEP/PGR.

## Fluxo operacional obrigatório antes de uso real

1. Definir escopo, unidades, grupos de trabalho, base legal/aviso de privacidade, retenção e responsáveis pelo tratamento com jurídico/DPO. Verificar representatividade; pequenos grupos podem exigir entrevistas ou observação em vez de questionário por unidade.
2. Profissional competente contextualiza o instrumento e a metodologia, define como combinar pesquisa, observação, relatos e outros dados e aprova a abertura no painel administrativo.
3. Empresa habilita trabalhadores, comunica voluntariedade e uso dos dados. Os colaboradores entram com e-mail verificado e respondem; o empregador não vê respostas nem placares durante a coleta.
4. Após o encerramento, equipe técnica analisa resultados **junto das condições reais de trabalho**. Percentual desfavorável não é automaticamente grau de risco.
5. Responsáveis registram riscos e medidas; revisor técnico avalia os registros. O responsável legal pela SST da empresa integra o conteúdo à AEP/inventário de riscos e ao plano de ação do PGR, quando aplicável. O PCMSO deve ser considerado na coordenação com saúde ocupacional.
6. Empresa executa e verifica as medidas, devolve os achados aos trabalhadores sem identificá-los e reavalia quando houver alterações relevantes e na periodicidade normativa. Novo ciclo pode ser criado para acompanhamento.

## Limites e pendências para implantação

- O software **não** emite ou atualiza PGR, AEP, PCMSO, laudo ou certificado de conformidade; não substitui inspeção das condições de trabalho nem profissional competente. A simples aplicação de pesquisa não comprova cumprimento da NR-1.
- O acesso de participantes ainda requer conta Firebase de paciente com e-mail verificado; para operação com 200 colaboradores, testar previamente onboarding, suporte, acessibilidade e adesão. Não há envio automático de convites/reminders.
- O pseudônimo de deduplicação e a chave de cifra derivada dependem de `EMPRESA_JWT_SECRET` estável, com pelo menos 16 caracteres. Rotacioná-lo sem recriptografar as respostas e migrar o roster **impossibilita ler as respostas antigas**, invalida habilitações e pode permitir segunda resposta na mesma campanha. Fazer backup seguro e planejar segredo dedicado/migração antes de operação extensa.
- Definir contratualmente retenção, exclusão, resposta a incidentes, papéis de controlador/operador, atendimento a titulares e política para risco de reidentificação antes de produção. Coleções `nr1_campaigns`, subcoleções e `nr1_participants` não possuem TTL automático; não apagar evidências regulatórias sem orientação jurídica.
- A qualificação do revisor é declarada e registrada, **não verificada automaticamente**. Antes de oferecer como serviço de avaliação técnica, conferir escopo da RT e requisitos éticos/regulatórios aplicáveis.
- Validar instrumento, linguagem e procedimento por local de trabalho; não afirmar equivalência ao HSE ou comparabilidade externa sem estudo apropriado.

## Referências oficiais

- [NR-1 vigente — MTE](https://www.gov.br/trabalho-e-emprego/pt-br/acesso-a-informacao/participacao-social/conselhos-e-orgaos-colegiados/comissao-tripartite-partitaria-permanente/normas-regulamentadora/normas-regulamentadoras-vigentes/nr-1)
- [Perguntas e respostas GRO/PGR — MTE](https://www.gov.br/trabalho-e-emprego/pt-br/assuntos/inspecao-do-trabalho/seguranca-e-saude-no-trabalho/canpat-2/canpat-2025/perguntas-e-respostas-gro-pgr-1a-rodada.pdf/)
- [Guia de fatores de riscos psicossociais — MTE](https://www.gov.br/trabalho-e-emprego/pt-br/acesso-a-informacao/participacao-social/conselhos-e-orgaos-colegiados/comissao-tripartite-partitaria-permanente/normas-regulamentadora/normas-regulamentadoras-vigentes/guia-nr-01-revisado.pdf)
- [Programa de Gerenciamento de Riscos — MTE](https://www.gov.br/trabalho-e-emprego/pt-br/assuntos/inspecao-do-trabalho/pgr)
