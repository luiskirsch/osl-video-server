# Central de apoio do colaborador

A central conecta um pedido de ajuda a um destinatário, um responsável e um próximo passo. O colaborador acompanha a resposta e confirma se o apoio ajudou ou se precisa continuar. Os relatos do diário não alimentam este módulo.

## Entradas

- Colaborador: `/app/apoio.html`, no menu lateral do portal (desktop) e num cartão da página inicial. O cartão só aparece quando alguma empresa vinculada tem um caminho ativo ou quando a pessoa já tem pedidos para acompanhar; convidar a pedir ajuda num canal desligado seria pior do que não mostrar. No celular o cartão é a porta de entrada (os itens secundários do menu ficam ocultos).
- Empresa: `/empresa-apoio.html`, a partir do painel da empresa.
- Acolhimento: `/admin-apoio.html`, com autenticação administrativa e segundo fator quando exigido pela conta.

## Operação

1. A equipe administrativa configura o acolhimento de cada empresa: responsável, contato e prazo de primeira resposta em horas corridas.
2. A empresa configura seu próprio canal de apoio, com responsável e prazo. Apenas o administrador pode habilitar a equipe de acolhimento.
3. O colaborador escolhe empresa, situação (sobrecarga, conversa com a liderança ou situação pessoal) e destinatário. Revisa o texto, a necessidade (opcional) e a identificação compartilhada antes de enviar.
4. A equipe destinatária recebe o pedido, atribui um responsável, informa próximo passo e prazo e responde pelo painel. A primeira atualização da equipe tira o pedido de "Recebido" e o coloca em acompanhamento; prazo e etapa só são enviados quando mudam, para um prazo vencido não travar outras edições.
5. A equipe pode propor uma resolução. O colaborador confirma que ajudou ou reabre o acompanhamento. Também pode cancelar um pedido.
6. A empresa registra ações coletivas com responsável, prazo e andamento; os colaboradores vinculados podem acompanhar essas ações.

Nenhum canal vem habilitado por padrão. O software não cria disponibilidade profissional nem agenda de plantão: a habilitação exige uma equipe capaz de cumprir o prazo informado. A página mostra o contato e as condições configuradas. Os pedidos são acompanhados no portal; não há envio automático de relatos por e-mail ou WhatsApp.

## Limites de acesso

- O colaborador acessa apenas os próprios pedidos e continua podendo consultá-los após perder o vínculo empresarial.
- A empresa acessa somente pedidos destinados explicitamente à equipe da própria empresa.
- A área administrativa de acolhimento acessa os pedidos dirigidos à equipe de acolhimento.
- Nome e e-mail acompanham o pedido para o destinatário escolhido; não se trata de um canal anônimo.
- Autorizar estatísticas é uma escolha separada do envio do pedido.
- O resumo da empresa usa períodos mensais encerrados, resultados congelados e supressão de grupos pequenos; não expõe relatos, identidade nem diagnósticos.
- Ações coletivas são comunicados visíveis aos colaboradores da empresa. Não devem conter identificação ou relatos pessoais.

## Persistência e consistência

O backend aplica autenticação, vínculo validado para novos pedidos, isolamento por empresa/destinatário, limites de entrada e criptografia autenticada dos relatos. A chave é derivada do segredo já utilizado na plataforma (`EMPRESA_JWT_SECRET`) em contexto exclusivo do módulo. A rotação desse segredo exige migração dos dados cifrados.

O identificador de criação permanece o mesmo durante uma nova tentativa após falha de rede. Atualizações exigem a versão atual do pedido e são transacionais, evitando sobrescrita silenciosa. A exclusão definitiva de conta limpa os pedidos antes de remover o login; falhas interrompem essa remoção para permitir nova tentativa. Backups seguem a política existente da plataforma.

## Verificação e publicação

Os testes do módulo cobrem fluxo dos pedidos, fronteiras de acesso, consentimento, criptografia, concorrência, estatísticas e exclusão. Os testes de navegador usam contas e respostas sintéticas locais; não enviam relatos a serviços reais.

Publicar o backend antes do frontend. As novas páginas dependem das rotas `/therapy/paciente/apoio`, `/therapy/admin/apoio` e `/empresa/apoio`. Após a publicação, configurar uma empresa de teste e validar com contas autorizadas o ciclo de solicitação, resposta, resolução e confirmação antes de habilitar as demais empresas.
