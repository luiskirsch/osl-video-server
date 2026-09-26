# Benefício corporativo de psicologia — critérios de lançamento

Este documento é um *gate de produção*, não uma declaração de que o serviço já esteja habilitado. O programa proposto oferece até duas sessões de psicologia cobertas por colaborador elegível e por mês de calendário em `America/Sao_Paulo`. Sessões adicionais dependem de pagamento confirmado; o preço ao colaborador deve preservar R$ 60 **líquidos** para a profissional ou o profissional pessoa física, após as retenções aplicáveis.

## Antes de divulgar ou vender

- [ ] RT contratada, responsabilidades clínicas e carga horária formalizadas, documentação da pessoa jurídica concluída e enquadramento/regularidade confirmados pelo CRP-MG. Uma cotação de RT não substitui esses passos. Não anunciar inscrição, habilitação ou cobertura de urgência sem comprovação.
- [ ] Contrato com a empresa define vidas elegíveis, confirmação e revogação de vínculo pelo RH, preço por vida, início/vigência, as duas sessões cobertas, extra pago pelo colaborador, reagendamento, faltas, cancelamento, reajuste e responsabilidades de cada parte.
- [ ] Rede de psicólogas(os) regular e suficiente para as duas unidades, com horários, continuidade terapêutica, substituições, tempo máximo de acesso e canal de suporte testados. Critérios de crise, encaminhamento e indisponibilidade devem ser aprovados pela RT.
- [ ] Contabilidade valida CNAE/segregação da receita, anexo e alíquota efetiva do Simples, tratamento do RPA de CPF, INSS, IRRF por competência, eventual CPP fora do DAS e emissão dos comprovantes. O cálculo da sessão extra não pode partir apenas dos R$ 60 líquidos.
- [ ] Taxa de Pix **da conta Mercado Pago usada em produção** e custos de repasse/reembolso confirmados. Configuração financeira homologada antes de habilitar a cobrança; não usar taxa pública ou estimada como verdade contratual.

O preço adicional é obtido por `ceil((ceil(6000/(1-retenções)) × (1+encargo patronal) + taxas fixas)/(1-DAS efetivo-taxa variável do gateway))`, em centavos. A retenção informada deve cobrir o cenário aplicável ao profissional CPF — INSS e eventual IRRF/ISS conforme orientação contábil, observando limites e apuração mensal. **Exemplo ilustrativo, não tarifa aprovada:** 11% de retenção, 0% de encargo externo ao DAS, 0,99% de Pix e nenhuma taxa fixa resultam em R$ 72,49 com DAS de 6% ou R$ 80,74 com DAS de 15,5%. O valor real fica indisponível até que a configuração seja homologada e ativada no painel administrativo.

## Critérios técnicos verificáveis

- [ ] Cadastro corporativo depende de identidade autenticada e elegibilidade aprovada pela empresa; conhecer o link/código não basta para ativar o benefício.
- [ ] A API, e não o navegador, determina se a sessão é coberta ou extra. Duas reservas concorrentes não excedem a franquia mensal; cancelamento/reembolso segue regra escrita e testada.
- [ ] Uma sessão extra só pode ser confirmada após pagamento aprovado, com referência, valor e estado reconciliados com a resposta do provedor. Webhook duplicado ou atrasado não libera duas sessões.
- [ ] Reembolsos por recusa, cancelamento ou pagamento tardio são tratados na fila administrativa: devolver no Mercado Pago, conferir o status integral pela API e impedir repasse indevido. Atualmente o processo exige ação humana; não anunciar reembolso automático.
- [ ] Valor mostrado ao colaborador coincide com o cobrado. O demonstrativo interno distingue líquido profissional, retenções, tributo sobre a receita, taxa do meio de pagamento e reserva operacional. A conciliação mensal verifica se os R$ 60 líquidos foram efetivamente entregues.
- [ ] O painel da empresa mostra apenas dados verdadeiros, completos e agregados. Não divulga profissional, motivo clínico, prontuário, conteúdo de mensagem ou subconjuntos que permitam identificar um colaborador. Dados insuficientes ou inconsistentes aparecem como indisponíveis, nunca como zero inventado.
- [ ] Fluxos web e mobile foram testados como colaborador coberto, colaborador com cota esgotada, desligado, não aprovado e pessoa externa. Testar também virada do mês em São Paulo, concorrência, erro de Pix, webhook, cancelamento, mudança de profissional e restituição.

## Decisão de lançamento

Somente marcar o programa como apto a contratos depois de evidenciar todos os itens acima, testar em homologação e obter aprovação da RT, da contabilidade e da operação. Uma funcionalidade no repositório, por si só, não demonstra atendimento clínico disponível ou regularidade profissional.

Referências oficiais: [CRP-MG — Pessoa Jurídica](https://crp04.org.br/servicos/pessoa-juridica/); [Receita Federal — CPP e Anexo IV](https://www.gov.br/receitafederal/pt-br/assuntos/orientacao-tributaria/declaracoes-e-demonstrativos/revisao-de-declaracao-malha/pj-parametro-40.001); [Mercado Pago — integração Pix](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/integration-configuration/integrate-pix).
