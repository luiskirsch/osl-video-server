# Operação do programa público escolar

Este módulo trata o Espaço Prelúdio como prestador privado de atendimento psicológico online contratado por órgão público. Ele é separado do benefício corporativo B2B e do diretório público de profissionais.

## Preparação obrigatória

1. Em **Admin > Programa Público > Prestadora**, registrar razão social, CNPJ, registro da pessoa jurídica no CRP, responsável técnico, coordenação clínica, encarregado, canais de incidente, endereço e versões vigentes dos protocolos.
2. Cadastrar o contrato/programa com órgão e CNPJ contratante, processo, instrumento e base legal, desafio de inovação, hipótese, escopo experimental, métricas, marcos, vigência, público, limites, SLA, papéis de proteção de dados, gestor e encarregado públicos, referências locais de saúde/emergência, RIPD, termos e psicólogos CRP verificados.
3. Cadastrar cada escola com endereço, etapas, coordenação, referência de saúde, referência de proteção/garantia de direitos, contato de privacidade e capacidade.
4. Ativar o programa somente após a conferência documental. A API bloqueia ativação quando faltarem dados, escola ativa ou equipe habilitada.
5. Gerar o convite individual da escola. A rotação invalida imediatamente o convite anterior.

## Fluxo do estudante

`convite escolar -> cadastro -> consentimento do responsável -> atribuição -> triagem e assentimento -> atendimento ou encaminhamento -> alta`

- O formulário público só abre com programa, escola e código de convite válidos.
- A matrícula é identificada por código escolar próprio; o formulário orienta a não usar CPF.
- Menores aguardam manifestação expressa do responsável. Abrir o link não confirma nada.
- O consentimento coleta contato de emergência, residência para resposta local e necessidades de acessibilidade/comunicação.
- O responsável recebe um link separado para consultar ou retirar a autorização.
- Recusa ou retirada libera a vaga operacional sem apagar o registro auditável do caso.
- Nenhum estudante escolhe profissional no diretório. A coordenação atribui psicólogo integrante do contrato e com CRP verificado.
- A triagem documenta assentimento, riscos, privacidade, dispositivo, conexão, endereço de emergência e rede local.
- Emergência não pode ser aprovada como atendimento remoto; riscos críticos exigem condições reforçadas ou encaminhamento.
- Sessões do programa usam fonte `public_contract`, sem cobrança ao estudante, e respeitam vigência e cotas.
- Cotas são reservadas transacionalmente por aluno e mês; blocos de agenda de cinco minutos evitam dois agendamentos simultâneos para o mesmo psicólogo.
- Resumo por IA fica desativado nas sessões infantojuvenis do programa público.

## Separação de acesso

- Escola e contratante não recebem conteúdo clínico, endereço, contato de emergência ou notas de sessão.
- Admin interno acessa a operação identificada para coordenação e auditoria.
- Psicólogo acessa apenas casos atribuídos a ele e pertencentes à sua equipe contratual.
- Indicadores contratuais são administrativos e agregados por situação, viabilidade e escola.

## Estados principais

- `pending_guardian_consent`: convite do responsável pendente.
- `pending_triage`: consentimento confirmado e aguardando triagem.
- `assigned`: triagem favorável e psicólogo atribuído.
- `care_active`: acompanhamento com sessão agendada/iniciado.
- `referral_required`: triagem concluiu que a modalidade remota não é adequada; o caso só muda de estado após o psicólogo registrar destino, contato e motivo do encaminhamento.
- `referred_in_person` / `referred_network`: encaminhamento efetivamente registrado para atendimento presencial ou rede local.
- `discharged`: acompanhamento encerrado.
- `declined`, `consent_revoked`, `suspended`: participação recusada, retirada ou suspensa.

## Checklist antes de receber alunos reais

- Validar documentos e textos com assessoria jurídica, DPO e responsável técnico; o software não determina sozinho o enquadramento da contratação como CPSI.
- Publicar as versões referenciadas de aviso, consentimento, assentimento, protocolo clínico e protocolo de emergência.
- Validar lista e contatos da rede local de cada município/escola.
- Fazer ensaio ponta a ponta com dados fictícios: convite, menor e maior, recusa, consentimento, revogação, atribuição, triagem apta/não apta, cota, agenda, sessão, encaminhamento e alta.
- Confirmar e-mail, WhatsApp/SMS, videoconferência, backup, monitoramento, resposta a incidentes e suporte humano.
- Definir rotina de reconciliação dos indicadores com o fiscal do contrato sem exportar conteúdo clínico.

## Coleções Firestore

- `therapy_public_provider` (documento `config`)
- `therapy_public_programs`
- `therapy_schools`
- `therapy_estudantes`
- `therapy_student_cases`
- `therapy_student_events`
- `therapy_student_referrals`
- `therapy_student_registration_locks`
- `therapy_public_program_usage`
- `therapy_schedule_locks`
- `therapy_sessions` com `publicProgramId`, `publicSchoolId` e `studentId`

Tokens de convite, consentimento e gestão são persistidos apenas como hash. Eventos clínicos e administrativos são registrados separadamente para rastreabilidade.

## Demonstração integral para apresentação

O cenário sintético pode percorrer o mesmo fluxo operacional até uma sala técnica de vídeo:

`aluno fictício -> triagem demonstrativa -> aprovação remota -> agendamento -> portal do aluno -> sala de vídeo -> painel profissional -> encerramento`

- Todos os documentos permanecem com `syntheticData=true` e `clinicalUseAllowed=false`.
- A sala usa a infraestrutura real de videoconferência e E2EE, mas é identificada como demonstração e não constitui atendimento clínico.
- O agendamento não envia e-mail, WhatsApp, cobrança ou comunicação para terceiros.
- O portal do aluno recebe somente o código opaco da sessão pertencente à sua própria conta.
- O apresentador abre o painel profissional em um navegador e a entrada do aluno em outro navegador, perfil anônimo ou dispositivo.
- O encerramento atualiza o histórico e os indicadores do cenário sintético, permitindo demonstrar o ciclo completo.
