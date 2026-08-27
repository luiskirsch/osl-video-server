# Espaço Prelúdio — estratégia de enquadramento em CPSI

> Documento de subsídio técnico. Não substitui a decisão motivada da Prefeitura, o parecer jurídico nem os documentos formais da licitação especial.

## 1. Conclusão executiva

O projeto é **defensável como candidato a um Contrato Público para Solução Inovadora (CPSI)** se for apresentado como experimento público destinado a resolver um problema municipal ainda não solucionado com segurança e eficácia comprovadas. O objeto não deve ser “comprar licenças do Espaço Prelúdio” nem “contratar uma clínica virtual pronta”. Deve ser descrito, de forma neutra, como:

> Testar, em ambiente municipal real e com risco tecnológico, soluções inovadoras capazes de ampliar o acesso seguro, oportuno e coordenado de crianças e adolescentes a cuidado psicológico remoto, integrado à educação, atenção primária, RAPS, assistência social e rede de proteção, produzindo evidências para decisão de escala.

O CPSI **não é contratação direta**. É a licitação especial dos arts. 12 a 15 da Lei Complementar nº 182/2021, com edital aberto, comissão especial, critérios legais e possibilidade de a Administração selecionar mais de uma solução. A empresa não deve pedir garantia de contratação ou desenhar o desafio para excluir concorrentes.

O art. 13 permite propostas de pessoas físicas ou jurídicas, isoladas ou em consórcio; portanto, ser formalmente enquadrada como startup **não é requisito exclusivo para concorrer ao CPSI**. Se a empresa quiser também usar a qualificação de startup do art. 4º, deverá comprovar separadamente receita bruta dentro do limite legal, até 10 anos de CNPJ e declaração de modelo inovador no ato constitutivo/alteração ou enquadramento no Inova Simples. Esses documentos societários e fiscais não estavam no repositório e não foram auditados aqui.

## 2. Por que há hipótese legítima de CPSI

Há componentes tecnológicos já implementados: autenticação, verificação profissional, agenda, teleconsulta com mídia cifrada, registros clínicos cifrados no cliente, trilhas de auditoria e fluxo inicial de cadastro escolar. A inovação a testar, porém, não é “videoconferência”. É a combinação ainda não validada de:

- jornada municipal infantojuvenil ponta a ponta, do convite/consentimento ao cuidado e encaminhamento;
- coordenação intersetorial sem quebra indevida do sigilo clínico;
- segurança e adequação por idade, contexto familiar, dispositivo e ambiente doméstico;
- integração operacional com APS, RAPS, assistência social, escolas e Conselho Tutelar, conforme competência de cada ator;
- gestão de fila, prioridade, disponibilidade profissional e continuidade do cuidado;
- indicadores anonimizados que demonstrem acesso, qualidade, segurança e equidade;
- arquitetura multiunidade/municipal, segregação de dados e governança de perfis;
- capacidade de operar com conectividade e equipamentos heterogêneos.

Esses pontos contêm risco tecnológico e de implementação mensurável. O piloto pode confirmar ou refutar hipóteses sem transformar insucesso técnico honesto em inadimplemento, desde que metas, método, pagamentos e matriz de riscos estejam definidos no CPSI.

## 3. O que não sustenta o enquadramento

- a empresa ser startup, isoladamente;
- o produto usar IA, nuvem, vídeo ou criptografia;
- a simples conveniência de evitar a licitação comum;
- um objeto fechado em assinatura SaaS, número de licenças ou contratação exclusiva da marca;
- chamar de inovação uma implantação rotineira sem hipótese, teste, risco ou decisão de continuidade;
- apresentar o produto como plenamente pronto e, ao mesmo tempo, pedir verba para desenvolvimento sem delimitar o que ainda será testado.

Se a necessidade municipal for apenas adquirir uma solução disponível e comparável no mercado, a via adequada tende a ser a contratação ordinária. A escolha do CPSI precisa estar motivada no processo administrativo.

## 4. Proposta de experimento

### Hipóteses

H1. Uma jornada digital assistida reduz o tempo entre identificação da demanda e primeiro acolhimento, sem aumentar eventos de segurança.

H2. Consentimento verificável, avaliação de viabilidade remota e rotas de encaminhamento permitem atender com proteção compatível à faixa etária.

H3. A coordenação por dados agregados melhora a gestão da fila sem expor conteúdo clínico a escolas ou gestores não autorizados.

H4. O modelo mantém adesão e continuidade em grupos com diferentes níveis de conectividade, idade, deficiência e vulnerabilidade.

### Fases sugeridas — 6 meses

1. **Preparação e linha de base (4 semanas):** governança, unidades participantes, fluxos da rede, RIPD, plano de segurança, capacitação, métricas e linha de base.
2. **Integração controlada (4 semanas):** tenant municipal, perfis, consentimento, triagem, agenda, encaminhamento e testes sem dados reais ou com casos simulados.
3. **Piloto restrito (8 semanas):** coorte pequena, unidades definidas, suporte intensivo, revisão semanal de incidentes e barreiras.
4. **Expansão controlada (6 semanas):** ampliação condicionada aos critérios de segurança da fase anterior.
5. **Avaliação e decisão (2 semanas):** relatório técnico, resultados, limitações, custos, riscos residuais e recomendação de encerrar, ajustar ou escalar.

As quantidades, localidades e metas numéricas devem ser fixadas pela Prefeitura após linha de base e consulta ao mercado; não devem ser inventadas pela empresa.

## 5. Indicadores e critérios de decisão

| Dimensão | Indicador sugerido | Evidência | Regra de avaliação |
|---|---|---|---|
| Acesso | tempo mediano cadastro–primeiro acolhimento | timestamps auditáveis | comparar com linha de base |
| Conversão | proporção elegível que inicia atendimento | funil agregado | analisar perdas por etapa |
| Continuidade | comparecimento e abandono | agenda/sessões | estratificar por idade/unidade |
| Segurança | incidentes, urgências e encaminhamentos executados | registro de ocorrência | tolerância e SLA definidos no edital |
| Adequação | casos considerados inviáveis para remoto e destino | avaliação profissional | nenhuma recusa sem orientação de rede |
| Equidade | acesso por território, deficiência e conectividade | dados minimizados/agregados | identificar disparidades, sem ranking clínico |
| Experiência | satisfação e compreensão de criança/responsável/profissional | instrumento breve | linguagem apropriada à idade |
| Desempenho | disponibilidade, falhas de mídia e suporte | telemetria sem conteúdo clínico | SLO acordado |
| Eficiência | custo por acolhimento e por cuidado iniciado | custos do piloto | comparação transparente |
| Proteção de dados | solicitações, acessos indevidos e tempo de resposta | auditoria/RIPD | gates eliminatórios de segurança |

Não se deve prometer cura, redução de diagnóstico ou eficácia clínica sem protocolo de pesquisa e desenho metodológico compatíveis. Métricas clínicas individuais não devem virar ranking escolar ou mecanismo automatizado de elegibilidade.

## 6. Entregáveis contratáveis no CPSI

- plano do experimento, arquitetura e mapa de integrações;
- matriz de responsabilidade clínica, administrativa e de dados;
- jornada de consentimento, assentimento/informação adequada à idade e revogação;
- módulo municipal com segregação por tenant, unidade e perfil;
- triagem humana e avaliação documentada da viabilidade remota;
- agenda vinculada ao programa, profissional habilitado e regras de capacidade;
- protocolos de crise, violência, urgência, falha de conexão e encaminhamento;
- diretório versionado da rede local e confirmação de recebimento do encaminhamento;
- painel exclusivamente agregado, com limiares contra reidentificação;
- logs, gestão de incidentes, continuidade, backup e testes de segurança;
- evidências de cada fase e relatório final reproduzível;
- documentação de portabilidade e saída, sem aprisionamento tecnológico.

## 7. Modelo de remuneração

Sugestão: pagamentos por fase e evidência aceita, cobrindo o trabalho experimental mesmo quando uma hipótese técnica não se confirmar, salvo fraude, culpa ou descumprimento. Parcela variável pode ser associada a resultados objetivos, sem incentivar seleção de casos fáceis, excesso de atendimento ou ocultação de incidentes.

O valor deve ser justificado por orçamento analítico e pesquisa/consulta ao mercado. O teto legal aplicável precisa ser confirmado pela assessoria jurídica na data do edital, inclusive eventual atualização monetária.

## 8. Governança mínima

- patrocinador municipal e gestor/fiscal do contrato;
- responsáveis de Saúde, Educação, Assistência Social, RAPS e proteção;
- encarregados de dados e segurança da Prefeitura e do contratado;
- responsável técnico e psicólogos com CRP ativo;
- canal independente para criança/adolescente e responsável relatarem problema;
- comitê de segurança do piloto com reunião periódica e poder de suspender etapa;
- nenhuma escola acessa prontuário, transcrição, conteúdo de sessão ou inferência clínica;
- decisões clínicas permanecem humanas; automação não diagnostica nem define urgência sozinha.

## 9. Propriedade intelectual e saída

O edital e o CPSI devem distinguir: propriedade intelectual preexistente da empresa; desenvolvimentos específicos financiados; dados e documentos públicos; direito de uso durante o teste; portabilidade; destruição/devolução de dados; e condições econômicas de eventual fornecimento posterior. A Prefeitura precisa receber dados e relatórios em formato estruturado e interoperável, preservado o sigilo.

## 10. Caminho administrativo sugerido

1. formalizar o problema e a linha de base em Documento de Oficialização da Demanda;
2. realizar consulta pública/ao mercado, sem compromisso de contratação;
3. elaborar ETP comparando CPSI com alternativas e motivando a escolha;
4. elaborar matriz de riscos, RIPD preliminar e Termo de Referência orientado a resultados;
5. publicar edital da licitação especial pelo prazo legal mínimo;
6. constituir comissão especial e avaliar as propostas pelos critérios do art. 13;
7. contratar uma ou mais soluções, executar fases e publicar resultados não sigilosos;
8. decidir motivadamente sobre encerramento, novo teste ou eventual fornecimento do art. 15.

### Checklist documental da proponente

- contrato social e alterações, cartão CNPJ e certidões;
- demonstrações fiscais para eventual comprovação do art. 4º;
- comprovação da cláusula de inovação ou Inova Simples, se alegado;
- titularidade/licenças do código, marca e componentes de terceiros;
- currículos, equipe disponível, CRPs e eventual registro de pessoa jurídica/responsável técnico;
- demonstrações financeiras e capacidade de executar cada fase;
- arquitetura, inventário de dados, suboperadores e contratos essenciais;
- políticas de segurança, privacidade, incidente, continuidade e saída;
- relatório de vulnerabilidades, SBOM, testes e plano de tratamento;
- referências e métricas reais, sempre distinguindo produção, teste e hipótese.

## 11. Mensagem recomendada para a reunião

> “Não proponho que a Prefeitura compre uma plataforma por marca ou contorne a competição. Proponho que formalize um desafio público e mensurável: ampliar, com segurança, o acesso de crianças e adolescentes ao cuidado psicológico e à rede municipal. O Espaço Prelúdio quer competir no CPSI e demonstrar, em piloto controlado, se sua solução resolve esse desafio. A continuidade só deve ocorrer se as evidências justificarem.”

Evitar as expressões “passar como CPSI”, “dispensar licitação”, “garantir contrato” ou “contratar a startup”. Usar “avaliar tecnicamente a adequação do CPSI”, “licitação especial”, “teste competitivo” e “decisão baseada em evidências”.

## 12. Bases oficiais

- Lei Complementar nº 182/2021, arts. 12 a 15: https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp182.htm
- Página e Manual do CPSI da AGU: https://www.gov.br/agu/pt-br/assuntos-1/labori/cpsi
- Jornada de CPSI do TCU: https://sites.tcu.gov.br/cpsi/
- Lei nº 14.510/2022 (telessaúde): https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2022/lei/l14510.htm
- Lei nº 13.709/2018 (LGPD): https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm
- Lei nº 15.211/2025 (ECA Digital): https://www.planalto.gov.br/ccivil_03/_ato2023-2026/2025/lei/l15211.htm
- Lei nº 14.819/2024 (Política de Atenção Psicossocial nas Comunidades Escolares): https://www.planalto.gov.br/ccivil_03/_ato2023-2026/2024/lei/l14819.htm
- Lei nº 13.935/2019 (Psicologia e Serviço Social nas redes públicas de educação básica): https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2019/lei/l13935.htm
