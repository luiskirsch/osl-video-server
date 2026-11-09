# Correções de exposição pública — 8 de novembro de 2026

## Perfis e recursos públicos

O diretório consulta `therapists` com `where("publicSchedulingEnabled", "==", true)`. O detalhe usa esse mesmo filtro e o slug público. Consentimento ausente, desativado ou com tipo diferente de booleano não publica o perfil. Assinatura paga e inclusão administrativa na rede não substituem essa escolha. O endpoint legado de verificação por UID aplica o filtro também.

Perfis não publicados e inexistentes retornam o mesmo `404`, sem dados profissionais. O payload do diretório/detalhe não contém UID, foto em base64 ou `pixConfigured`. As fotos são recursos separados, com URLs assinadas por finalidade, expiração e versão; a publicação é revalidada antes de servir conteúdo ou responder `304`. Revalidação HTTP evita conservar uma foto desativada em cache compartilhado.

`/`, `/health` e `/therapy/health` públicos retornam somente `{"ok":true}`. `/internal/health` exige sessão administrativa ou token de cinco minutos limitado a `health:read`. A publicação e os probes de CI usam credenciais próprias por ambiente para conferir o commit. Não enviar tokens em URLs.

Os contadores da API são separados pelo método/rota registrada e pelo UID de um token Firebase verificado com revogação. Sem identidade válida, usa-se o IP normalizado; nomes de UID inventados em JWTs não criam baldes. Identificadores de recurso diferentes compartilham o limite da mesma rota. Os limites específicos de login, criação e leads permanecem adicionais.

O CORS declara os headers da família de rotas. Leads aceitam conteúdo e idioma, sem expor headers administrativos/IA. O header `X-Admin-Secret` deixou de autenticar administração e acesso ao jogo. Tokens temporários continuam sujeitos à finalidade e expiração.

## Site e homologação

O site é publicado por artefato contendo somente arquivos públicos. Código de ferramentas, testes, configuração de infraestrutura e `package*.json` ficam fora do artefato. A borda também bloqueia essas rotas. Os headers CORS de origem são removidos dos arquivos estáticos. Os frames Firebase legados saíram da CSP; o cliente usa autenticação sem popup/redirect. O widget externo fica restrito à página inicial, com SRI e CORS, sem acesso aos portais.

`/staging/` exige autenticação de homologação. Após o login, um cookie Secure/HttpOnly com escopo `/staging/` e prazo de oito horas permite usar o portal. `/staging/api/` preserva a identidade Firebase e acrescenta a credencial interna do proxy no servidor. O acesso direto à API de staging exige essa credencial, inclusive no handshake do Socket.IO. A exceção de health é limitada ao loopback real do container, sem headers de encaminhamento.

Staging e produção usam credenciais Firebase e projetos diferentes. Credenciais compartilhadas de e-mail, IA, vídeo, armazenamento e integrações do jogo foram removidas/desativadas em staging. Essas funcionalidades exigem credenciais próprias de homologação antes de serem usadas lá. As credenciais legadas de Discord/jogo também foram desativadas no serviço clínico de produção. Os logins administrativos e dados clínicos de produção não foram migrados por esta correção.

## Isolamento Firebase: situação e trabalho restante

O projeto de produção em uso tem ID legado `osextolugar-game` e nome administrativo “Espaço Prelúdio Produção”. A auditoria de metadados encontrou coleções clínicas e histórico legado de streaming; o serviço está com `GAME_ENABLED=false`. Homologação usa `sextolugar-staging` e ainda contém coleções antigas de teste do jogo. O projeto `osextolugar-jogo` existe separadamente. Isso não constitui uma comprovação de migração completa de Auth, IAM, integrações ou clientes do jogo.

Foram adicionadas travas de ambiente: o backend só aceita a credencial do projeto esperado e o serviço clínico não pode ativar o jogo nem usar `osextolugar-jogo`. As regras publicadas de `config` negam acesso direto em ambos os projetos em uso. O acesso do backend por Admin SDK continua autorizado pela API.

Os projetos de destino `espaco-preludio-clinico` e `espaco-preludio-hml` já existem, com bancos e regras que negam acesso direto. A troca integral de produção **não está concluída**: requer backup cifrado com restauração comprovada, inventário completo de dependências, migração de Auth preservando UIDs e parâmetros originais de hash, cópia recursiva de dados/subcoleções/arquivos sem alterar cifras, conferência de integridade, atualização coordenada de clientes e backend e janela controlada de corte com rollback. O script antigo `migrate-firestore-split.js` não basta: ele omite auditoria, diversas coleções novas, Auth e arquivos.

A API do App Check estava desabilitada nos projetos em uso e o frontend não configurava um provedor. Não foi ativado enforcement sem registrar o provedor e validar o login real. App Check e rate limiting da API são controles distintos: limitar a API própria não protege, por si, o endpoint de criação de contas do Firebase Auth.

## Verificação

## Incidente na preparação da migração

Em 08/11, a leitura para backup encontrou `RESOURCE_EXHAUSTED` no projeto
gratuito de produção. A consulta pública passou a retornar erro de banco.
A cópia foi interrompida; não houve troca do projeto nem exclusão de dados.
O backup completo do Firestore **não foi concluído**. Apenas os arquivos
cifrados de configuração e Auth concluídos podem ser considerados disponíveis.

Foi acrescentado `CLINICAL_MAINTENANCE=true`: responde `503` com `Retry-After`,
interrompe as rotas antes de webhooks/auditoria e impede a inicialização dos
jobs e de conexões Socket.IO. Health permanece mínimo e o diagnóstico interno
autenticado informa a manutenção. Isso não recupera a cota do Firebase.

Todas as contas de faturamento acessíveis estavam encerradas. A retomada
depende de reativação/vinculação pelo titular ou da renovação da cota. Antes
de outra leitura em massa, conferir franquia restante e capacidade de escrita
do destino; o histórico supera a franquia diária gratuita de gravações.
Não publicar uma troca de Firebase com cópia parcial ou sem validar Auth.

## Testes

Os testes HTTP exercitam as rotas reais com transporte Firestore substituído: filtro obrigatório, ausência de UID/base64/configuração financeira, `404` consistente, assinatura de fotos e revogação antes de cache. Os testes de borda conferem desafio de homologação, cookie, proxy sem vazamento da chave e exclusão de arquivos privados. Conferir as mesmas condições após o deploy. Não interpretar controles client-side de redirecionamento/anti-clone como autorização da API.
