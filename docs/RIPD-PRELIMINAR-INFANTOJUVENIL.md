# RIPD preliminar — piloto municipal infantojuvenil

> Template para oficina conjunta. O RIPD definitivo depende do desenho da Prefeitura, dos tratamentos efetivos, contratos, sistemas integrados e decisão dos agentes de tratamento.

## 1. Escopo proposto

Piloto controlado de acesso remoto a cuidado psicológico para crianças e adolescentes vinculados a unidades municipais selecionadas. Exclui, inicialmente, gravação, resumo por IA, reconhecimento de emoção, diagnóstico automatizado, publicidade, pesquisa secundária e compartilhamento de conteúdo clínico com escolas.

## 2. Finalidades

- cadastrar e verificar elegibilidade no programa;
- informar criança/adolescente e responsável;
- avaliar viabilidade do remoto;
- agendar e realizar atendimento por profissional habilitado;
- registrar apenas o necessário para continuidade e dever profissional;
- encaminhar à rede quando indicado;
- produzir indicadores agregados para avaliação do piloto;
- prevenir fraude, incidente e acesso indevido.

Nova finalidade exige análise de compatibilidade, atualização deste RIPD e informação aos titulares.

## 3. Categorias de dados

| Etapa | Dados mínimos | Sensibilidade | Destinatários necessários |
|---|---|---|---|
| convite | nome, nascimento, unidade, contato do responsável | pessoal/infantil | equipe autorizada do programa |
| consentimento | versão, decisão, data, evidência técnica minimizada | pessoal | auditoria/DPO |
| avaliação | condições de privacidade, tecnologia e adequação | saúde/contexto | psicólogo |
| atendimento | agenda, presença, registro psicológico | saúde sensível | psicólogo/equipe autorizada por norma |
| encaminhamento | destino, urgência, confirmação | saúde/proteção | ponto competente da rede |
| avaliação pública | métricas agregadas | preferencialmente anônima | gestão/comissão/sociedade em resumo |

Não coletar CPF do responsável por padrão sem necessidade demonstrada. Não guardar texto livre quando um campo estruturado minimizado resolver. Não incluir conteúdo de sessão em telemetria.

## 4. Agentes e responsabilidades a definir

Para cada tratamento, registrar quem decide finalidade/meios essenciais e quem atua sob instruções. É provável que a Prefeitura controle a operação da política pública e que o fornecedor opere parte dos dados, mas a empresa pode ser controladora de tratamentos próprios, como segurança de sua conta ou faturamento. Profissionais possuem deveres e autonomia previstos nas normas de Psicologia. O contrato não pode contrariar os fatos.

## 5. Necessidade, proporcionalidade e alternativas

Documentar para cada campo: finalidade, base legal, necessidade, acesso, retenção, descarte e alternativa menos invasiva. Comparar remoto, presencial, ponto assistido e modalidade híbrida. Consentimento não deve ser usado como justificativa genérica para todo tratamento pelo Poder Público; selecionar base legal por operação e garantir transparência.

## 6. Direitos e participação infantojuvenil

- melhor interesse como consideração primordial;
- informação clara, acessível e adequada à idade;
- autorização de ao menos um responsável para atendimento psicológico remoto, sem apagar autonomia progressiva e escuta da criança/adolescente;
- mecanismo simples para dúvida, denúncia, revogação quando aplicável e exercício de direitos;
- configurações de máxima proteção por padrão;
- proibição de nudges que pressionem consentimento;
- alternativa presencial/assistida sem penalização;
- canal de reporte que não dependa exclusivamente do responsável em situações de violência.

## 7. Matriz inicial de riscos

| Evento | Consequência | Controle preventivo | Resposta |
|---|---|---|---|
| responsável incorreto consente | tratamento sem autoridade | token individual, expiração, confirmação explícita, verificação proporcional | suspender caso, investigar, apagar/corrigir conforme obrigação |
| escola acessa conteúdo clínico | quebra de sigilo e dano | separação de perfis e dados, testes negativos | revogar acesso, preservar evidência, notificar conforme risco |
| conversa ouvida em casa | exposição/retaliação | avaliação de ambiente, fones, palavra de segurança, alternativa presencial | interromper/realocar atendimento |
| crise durante sessão | dano à integridade | localização atual, contato e rede de urgência validados, treinamento | protocolo local e confirmação de recepção |
| reidentificação em painel | estigma/discriminação | agregação, limiar, supressão, sem ranking | retirar publicação e revisar método |
| vazamento por suboperador | dano massivo | diligência, contrato, minimização, criptografia | plano de incidente/ANPD/titulares conforme risco |
| modelo de IA infere condição | erro, estigma e opacidade | IA desativada no piloto | bloquear processamento e eliminar artefatos |
| exclusão por falta de dispositivo | desigualdade | ponto assistido e presencial | busca ativa por canal alternativo |

## 8. Segurança e ciclo de vida

- ambientes separados e inventariados;
- autenticação forte para equipe e menor privilégio;
- segredo em cofre, rotação e revogação;
- cifragem, backup e restauração testada;
- logging sem conteúdo clínico e alertas de abuso;
- análise de dependências, SBOM, correção e pentest;
- retenção configurada por categoria, legal hold excepcional e descarte verificável;
- exportação estruturada e plano de término do contrato;
- revisão contínua e resumo público do RIPD, preservados segredos e segurança.

## 9. Decisões pendentes

- unidades, população e linha de base;
- modelo operacional: fornecedor de tecnologia ou também prestador de saúde;
- bases legais por tratamento;
- sistemas municipais integrados;
- responsabilidades e contatos 24/7 para crise/incidente;
- região e cláusulas de cada suboperador;
- prazos de retenção por categoria;
- limiares de anonimização/agregação;
- critérios de suspensão e saída.

## 10. Aprovações antes do piloto

Assinaturas/aceites do responsável da política pública, responsável técnico, DPO municipal, DPO/privacidade do contratado, segurança da informação, Saúde, Educação e jurídico. Reavaliar em cada mudança material e ao fim de cada fase.
