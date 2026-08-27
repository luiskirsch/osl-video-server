# Auditoria de aderência — Espaço Prelúdio / CPSI municipal

Data da revisão: 27 de agosto de 2026.

## Parecer resumido

**Situação: apto a ser apresentado como proponente potencial de um CPSI, mas não apto hoje a uma implantação municipal infantojuvenil em produção sem fase preparatória e correções.**

O produto possui base técnica relevante, porém o módulo municipal ainda não fecha a jornada do estudante até o atendimento, a rede de proteção e a mensuração de resultados. Essa lacuna não deve ser escondida: ela é parte legítima do desenvolvimento/teste do CPSI. Os bloqueadores de privacidade, segurança e governança abaixo precisam ser gates contratuais antes do uso de dados reais.

## Evidências encontradas

| Área | Evidência no produto | Leitura para o CPSI |
|---|---|---|
| Autenticação e autorização | Firebase Auth, middlewares, perfis e verificações | base aproveitável; exige RBAC municipal formal |
| Profissionais | verificação de cadastro e aprovação administrativa | positivo; precisa revalidação periódica e responsável técnico |
| Teleconsulta | salas LiveKit, tokens e E2EE de mídia | positivo; validar em dispositivos/conectividade reais |
| Registros | notas cifradas no cliente com AES-GCM | positivo, mas não cobre todos os metadados/transcrições |
| Auditoria | eventos administrativos e de consulta | positivo; definir completude, retenção e revisão |
| Agenda | criação e gestão de consultas | existe, mas não está ligada ao estudante/programa municipal |
| Cadastro escolar | estudante, escola, responsável e convite | protótipo; consentimento foi reforçado nesta revisão |
| Operação municipal | lista/atribuição administrativa | parcial; faltam tenant, quotas, fluxos, rede e indicadores |
| IA | transcrição e resumo de sessão | incompatível com piloto infantil até controles adicionais |

## Bloqueadores antes de dados reais

### B1 — jornada municipal incompleta

O cadastro em `therapy_estudantes` não comprova vínculo obrigatório com conta/paciente, consulta agendada, sessão realizada, profissional atribuído, encaminhamento ou desfecho. O endpoint público geral de agenda também não exige elegibilidade no programa.

**Gate:** implementar identificador pseudonimizado do caso, máquina de estados, autorização em cada transição e trilha cadastro → consentimento → avaliação → agenda → sessão → encaminhamento/encerramento.

### B2 — isolamento municipal e segregação de ambientes

Não há tenant municipal completo, escopo por secretaria/unidade nem segregação comprovada de staging e produção.

**Gate:** projeto/bases de produção separados, RBAC/ABAC por município e unidade, testes negativos de acesso, inventário de contas de serviço e processo de desligamento.

### B3 — resumo por IA e transcrição legível

O fluxo de resumo captura áudio, produz transcrição e envia texto clínico identificável a provedor externo; a transcrição/resumo permanece em formato legível no Firestore. Isso contradizia a política pública anterior de “nenhuma gravação/processamento” e o discurso geral de E2EE.

**Gate:** manter o recurso desligado no piloto infantojuvenil. Reavaliar apenas após RIPD específico, base legal/finalidade, informação adequada à idade, consentimento quando aplicável, contrato com operador, localização/transferência, minimização, retenção automática, controle de acesso e validação clínica. IA não deve diagnosticar, priorizar ou acionar proteção de forma autônoma.

### B4 — governança clínica e rede local

Não há fluxo implementado e comprovável para urgência, risco de morte, violência, inviabilidade do remoto, falha de privacidade doméstica ou encaminhamento confirmado.

**Gate:** protocolos aprovados pelo município, diretório local versionado, responsável por turno, registro mínimo do encaminhamento e simulações antes do piloto.

### B5 — RIPD e contratos de dados

Os papéis de controlador/operador não podem ser definidos apenas pelo nome no contrato; dependem das decisões reais. Faltam inventário completo, contratos com suboperadores, análise de transferências e avaliação específica do ECA Digital.

**Gate:** RIPD aprovado, mapa de dados, matriz de papéis, cláusulas de incidente/auditoria/subcontratação, relatório público resumido e canal de direitos.

### B6 — dependências e testes

O `npm audit --omit=dev` registrou 4 vulnerabilidades de severidade alta, sem correção automática disponível, na cadeia de `@huggingface/transformers`, `onnxruntime-node`, `sharp` e `adm-zip`. O projeto não possui script de testes e não há suíte específica para cadastro/consentimento municipal.

**Gate:** remover ou isolar dependências não necessárias ao piloto; análise de explorabilidade; SBOM; monitoramento; testes unitários, integração, autorização, carga e segurança; pentest independente antes da expansão.

### B7 — árvore `staging/` desatualizada

A cópia de frontend em `staging/` ainda contém textos regulatórios revogados, afirmação incorreta de residência obrigatória dos dados no Brasil e versões anteriores das telas de consentimento. Ela não foi sincronizada automaticamente porque diverge da produção e uma substituição cega poderia quebrar funcionalidades de teste.

**Gate:** impedir indexação/acesso público e uso em demonstrações com dados reais; definir fonte única de build e sincronizar por pipeline revisado antes de qualquer homologação municipal.

### B8 — modelo operacional contraditório

Os Termos públicos apresentam a empresa como plataforma de tecnologia, sem prestação clínica, enquanto a proposta informal a descreve como clínica virtual que oferecerá consultas. As duas arquiteturas contratuais são possíveis, mas geram responsabilidades diferentes e não podem coexistir de forma ambígua.

**Gate:** escolher antes do edital se o contratado fornecerá somente tecnologia para a rede/profissionais do município ou uma solução integrada com prestação de Psicologia. Na segunda hipótese, validar registro da pessoa jurídica no CRP, responsável técnico, composição/equipe, faturamento do serviço de saúde, vigilância sanitária quando aplicável, responsabilidade profissional, cobertura e supervisão.

## Correções realizadas nesta revisão

- data de nascimento passou a ter validação real e limites plausíveis;
- convite de consentimento usa token aleatório, armazenado como hash, validade de 72 horas e rotação no reenvio;
- abrir o link não registra consentimento; confirmação exige POST e manifestação expressa;
- scanner de e-mail/prefetch não consegue mais consentir automaticamente;
- consentimento ganhou versão, timestamp, hash de IP, user-agent e auditoria;
- administrador não pode conceder consentimento em nome do responsável nem ativar menor pendente;
- rate limit específico e escape de HTML foram adicionados ao fluxo público;
- páginas públicas passaram a citar Resolução CFP nº 9/2024 e guarda mínima de 5 anos da Resolução CFP nº 1/2009;
- alegações falsas de residência obrigatória de dados no Brasil e isolamento de ambientes foram removidas;
- política passou a revelar o processamento opcional de áudio/transcrição por IA e o provedor;
- página infantil ganhou explicação e confirmação explícita antes da manifestação.

## Riscos altos e tratamentos

| Risco | Probabilidade/impacto | Tratamento mínimo |
|---|---|---|
| acesso indevido entre unidades | médio/crítico | tenant, menor privilégio, testes negativos e auditoria |
| exposição de conteúdo clínico à escola | médio/crítico | painel agregado, barreira técnica e política |
| atendimento remoto inadequado | médio/crítico | avaliação humana prévia e rota presencial |
| crise sem resposta local | médio/crítico | protocolo, escala, simulação e confirmação do encaminhamento |
| consentimento sem compreensão | médio/alto | linguagem por idade, responsável, revogação e registro versionado |
| exclusão digital | alto/alto | ponto assistido, alternativa presencial e monitoramento de equidade |
| reidentificação em painel | médio/alto | agregação, limiar mínimo e supressão de células pequenas |
| transcrição/IA expor dado sensível | médio/crítico | desligar no piloto até novos controles |
| dependência de fornecedor | médio/alto | exportação, APIs, documentação e plano de saída |
| indisponibilidade/ataque | médio/alto | SLO, backup, resposta a incidente, teste de restauração |

## Pendências de produto priorizadas

### P0 — antes do piloto

1. tenant municipal e segregação produção/staging;
2. jornada de caso vinculada e autorização por estado;
3. avaliação de viabilidade do remoto e protocolo de crise/rede;
4. RIPD, contratos e política de retenção;
5. IA desligada para crianças/adolescentes;
6. testes automatizados e segurança de dependências;
7. painel agregado seguro e exportação para avaliação;
8. acessibilidade WCAG, testes móveis e alternativa assistida.

### P1 — durante o CPSI

1. interoperabilidade com sistemas municipais escolhidos;
2. gestão de capacidade, fila e no-show;
3. instrumentos de experiência e resultados;
4. portabilidade/encerramento e destruição verificável;
5. testes de escala e continuidade.

## Decisão go/no-go sugerida

Nenhum atendimento real de menor deve começar enquanto B1 a B8 não tiverem evidência aceita pelo comitê do piloto. A passagem entre fases deve exigir simultaneamente: zero risco crítico sem tratamento, fluxo de crise simulado, autorização testada, RIPD aprovado, profissional habilitado, consentimento verificável e alternativa presencial disponível.
