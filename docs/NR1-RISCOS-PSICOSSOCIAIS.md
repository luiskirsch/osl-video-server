# Módulo de apoio à NR-1 — fatores de riscos psicossociais relacionados ao trabalho

## Finalidade e limite

O módulo organiza evidências para a Avaliação Ergonômica Preliminar (AEP), o Gerenciamento de Riscos Ocupacionais (GRO), o inventário de riscos e o plano de ação do PGR. Ele não gera conformidade sozinho e não substitui análise da atividade, inspeção do trabalho, AEP, PGR, PCMSO nem atuação de pessoa tecnicamente competente.

O questionário EP-WORK-19 é um instrumento exploratório original sobre **condições de trabalho**. Não é escala clínica, diagnóstico individual, instrumento oficial obrigatório ou reprodução do HSE Indicator Tool. O instrumento completo divulgado pelo HSE possui 35 itens; o HSE também orienta combinar a pesquisa com outras fontes de evidência. Não apresentar o EP-WORK-19 como “HSE de 19 perguntas”.

## Escopo técnico implementado

- Ciclos separados por empresa, unidade ou grupo de trabalho.
- Abertura somente após registro de revisor e qualificação, metodologia e limites, escopo, plano de participação dos trabalhadores, tratamento do remoto/híbrido, contato de privacidade, retenção e data planejada de fechamento.
- Lista de participantes específica para a NR-1. A empresa informa e-mails, mas o banco operacional guarda apenas HMAC para conferir contas verificadas. O sistema envia convite por e-mail e permite revogação.
- Uma resposta por conta e campanha. Nome, e-mail e UID não são associados à resposta. Unidade, aceite do aviso e respostas são cifrados com AES-256-GCM antes de serem gravados.
- Resultados liberados somente após o encerramento e com no mínimo cinco respostas. Se uma unidade pequena permitir inferência por diferença, todos os recortes por unidade são suprimidos. Empresa e responsável técnico recebem somente agregados.
- Registro de observação das atividades e condições reais, incluindo participação dos trabalhadores.
- Inventário preliminar com processo/ambiente, atividade, grupo exposto, fator de risco, exposição, possíveis agravos, evidência, controles existentes e justificativa.
- Critério documentado `EP-NR1-MATRIX-1.0`: severidade 1–5, probabilidade 1–5, matriz 5×5, níveis e decisão. Percentual da pesquisa nunca vira grau de risco automaticamente.
- Revisão nominal de cada risco por responsável técnico, com registro/qualificação e parecer.
- Plano de ação vinculado ao risco, com hierarquia de controle, responsável, prazo, forma de verificar eficácia, andamento, evidência e verificador.
- Registro da devolutiva aos trabalhadores e das contribuições recebidas.
- Registro do vínculo com a AEP e da incorporação ao inventário/plano do PGR ou justificativa documentada de dispensa, com reavaliação em até dois anos.
- Finalização bloqueada enquanto houver unidade sem observação, risco sem revisão, risco relevante sem ação, devolutiva ausente ou integração AEP/PGR ausente.
- Conclusão técnica nominal, cronologia, trilha de auditoria e relatório imprimível para composição do dossiê da organização.

## Fluxo operacional obrigatório

1. A organização define escopo, estabelecimentos, unidades, processos, atividades, população abrangida, remoto/híbrido, retenção, privacidade e responsáveis.
2. Pessoa tecnicamente competente contextualiza o instrumento e registra como serão combinados questionário, observação, diálogo com trabalhadores e outras evidências.
3. A empresa habilita os participantes e comunica objetivo, confidencialidade, uso e contato de privacidade. A plataforma não promete anonimato absoluto; aplica pseudonimização, segregação e supressão estatística.
4. Encerrada a coleta, empresa e responsável técnico analisam os agregados junto das condições reais de trabalho. Em grupos pequenos, devem privilegiar observação, análise da atividade e diálogo sem expor indivíduos.
5. A empresa registra as condições observadas e os riscos preliminares. O responsável técnico revisa cada risco usando critérios documentados.
6. Para cada risco relevante, a organização define medida seguindo a hierarquia de prevenção, responsável, prazo e verificação de eficácia.
7. A organização registra a devolutiva aos trabalhadores e integra os achados à AEP e, quando aplicável, ao inventário e plano de ação do PGR. O PCMSO deve permanecer coordenado com os achados de saúde ocupacional.
8. O responsável técnico registra conclusão fundamentada e finaliza o ciclo. A empresa executa, monitora e verifica as medidas; alterações relevantes, ineficácia ou eventos previstos na NR exigem revisão antecipada.

## Critérios de prontidão para operação comercial

- Contrato deve definir com precisão quem é controlador e operador, o papel da RT, escopo da entrega, retenção, exclusão, incidentes, titulares e suboperadores.
- A RT deve confirmar por escrito que sua habilitação e escopo profissional cobrem a análise oferecida. O sistema registra a declaração; não valida conselho profissional automaticamente.
- A organização contratante continua legalmente responsável pelo GRO/PGR/AEP e deve designar pessoa ou equipe competente.
- Antes do primeiro ciclo: teste de onboarding com contas verificadas, envio de e-mail, acessibilidade, suporte, exportação em PDF e restauração de backup.
- `EMPRESA_JWT_SECRET` deve ser estável e possuir ao menos 16 caracteres. Sua rotação exige migração: sem isso, respostas antigas tornam-se ilegíveis e habilitações deixam de conferir.
- Definir rotina de backup, continuidade, resposta a incidentes e eliminação ao término da retenção. Não apagar evidências regulatórias sem validação jurídica e técnica.

## O que não pode ser prometido ao cliente

- “Certificação NR-1”, “conformidade automática”, “laudo automático” ou substituição integral de SST.
- Que pesquisa ou dashboard, isoladamente, atualizam PGR, AEP ou PCMSO.
- Que o EP-WORK-19 é HSE, validado nacionalmente ou comparável a benchmarks externos.
- Que oferecer atendimento psicológico elimina o risco na organização do trabalho. Atendimento é suporte complementar; a prioridade é intervir na fonte e na organização do trabalho.

## Referências oficiais consultadas

- [NR-1 vigente — Ministério do Trabalho e Emprego](https://www.gov.br/trabalho-e-emprego/pt-br/acesso-a-informacao/participacao-social/conselhos-e-orga-colegiados/comissao-tripartite-partitaria-permanente/normas-regulamentadora/normas-regulamentadoras-vigentes/nr-1)
- [Perguntas e Respostas sobre GRO/PGR — MTE, maio de 2026](https://www.gov.br/trabalho-e-emprego/pt-br/acesso-a-informacao/participacao-social/conselhos-e-orga-colegiados/comissao-tripartite-partitaria-permanente/normas-regulamentadora/normas-regulamentadoras-vigentes/PerguntaseRespostasGROPGRMaio2026.pdf)
- [Manual de interpretação e aplicação do capítulo 1.5 da NR-1 — MTE, 2026](https://www.gov.br/trabalho-e-emprego/pt-br/assuntos/inspecao-do-trabalho/manuais-e-publicacoes/2026/manual_gro_pgr_da_nr_1.pdf)
- [Programa de Gerenciamento de Riscos — MTE](https://www.gov.br/trabalho-e-emprego/pt-br/assuntos/inspecao-do-trabalho/pgr)
- [HSE Management Standards: Indicator Tool](https://www.hse.gov.uk/stress/standards/step3/)
