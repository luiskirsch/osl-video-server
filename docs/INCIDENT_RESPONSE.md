# Plano de Resposta a Incidentes

**Projeto:** O SextoLugar / Espaço Prelúdio  
**Responsável:** Luis Kirsch  
**Revisão:** Mensal (junto com a rotação de secrets)

---

## 1. Classificação de Severidade

| Nível | Critério | Tempo de resposta |
|-------|----------|-------------------|
| **P0 – Crítico** | Dados de usuários expostos, acesso não autorizado ao painel admin, breach confirmado | Imediato (< 1h) |
| **P1 – Alto** | Endpoint de pagamento comprometido, token de admin vazado, Railway down | < 4h |
| **P2 – Médio** | Abuso de rate limit, spam via webhook, usuário relatando acesso indevido | < 24h |
| **P3 – Baixo** | Alerta de auditoria suspeito, dependência com CVE, ZAP report | < 72h |

---

## 2. Runbook por Tipo de Incidente

### 2.1 Vazamento de Secret / Credencial

**Sinais:** Secret aparece em log público, GitHub commit, Sentry, Railway output.

```
1. Invalidar o secret IMEDIATAMENTE no painel de origem:
   - ACCESS_TOKEN_SECRET / LICENSE_SECRET / ADMIN_SECRET → Railway > Variables
   - MP_ACCESS_TOKEN_* → MercadoPago > Credenciais
   - LIVEKIT_API_KEY → LiveKit Cloud > Settings
   - S3_ACCESS_KEY → Cloudflare R2 > API Tokens

2. Gerar novo valor:
   openssl rand -hex 32           # para ACCESS_TOKEN_SECRET, LICENSE_SECRET
   openssl rand -base64 32        # para ADMIN_SECRET
   npx web-push generate-vapid-keys  # para VAPID_*

3. Atualizar no Railway (prod + staging).

4. Reiniciar o serviço no Railway (Deploy > Redeploy).

5. Verificar /health em prod.

6. Revogar sessões ativas se ACCESS_TOKEN_SECRET foi comprometido:
   - Reiniciar o servidor já invalida todos os hostTokens em memória.

7. Checar audit_logs no Firestore por ações suspeitas nas últimas 24-48h.

8. Registrar incidente em #security-log (data, secret afetado, ação tomada).
```

---

### 2.2 Acesso Não Autorizado ao Painel Admin

**Sinais:** Login no painel de IP desconhecido, ação em audit_logs sem autoria reconhecida.

```
1. Trocar ADMIN_SECRET imediatamente (ver 2.1).

2. Trocar PANEL_TOTP_SECRET e reconfigurar o autenticador:
   node -e "console.log(require('crypto').randomBytes(20).toString('base64url'))"
   # Converter para base32 e configurar novo QR code no Railway.

3. Verificar Railway > Deployments por deploys não autorizados.

4. Verificar GitHub > Settings > Security > Active sessions.

5. Se o acesso veio de um IP específico, adicionar ao WAF blocklist
   em middleware/waf.js (array BLOCKED_IPS).

6. Notificar usuários se dados foram acessados ou alterados.
```

---

### 2.3 Breach de Dados de Usuários (Firestore)

**Sinais:** Leitura massiva de documentos, export não autorizado, relatório de usuário.

```
1. Ir para Firebase Console > Firestore > Regras.
   Adicionar temporariamente:
   match /{document=**} { allow read, write: if false; }
   Isso bloqueia TUDO enquanto investiga (incluindo o app — aceitável).

2. Verificar Firebase Console > Autenticação > Usuários por contas suspeitas.
   Desativar contas comprometidas.

3. Checar audit_logs: quem leu o quê nas últimas 24-48h.

4. Identificar o vetor de acesso (regra mal configurada, token vazado, etc).

5. Corrigir a regra / vetor.

6. Restaurar regras normais do firestore.rules.

7. LGPD: se dados pessoais foram expostos, notificar usuários afetados
   em até 72h (Art. 48 da LGPD). Consultar assessoria jurídica se necessário.

8. Reportar à ANPD se afetou > 1.000 titulares ou dados sensíveis.
```

---

### 2.4 Endpoint de Pagamento Comprometido

**Sinais:** Cobranças indevidas no MercadoPago, webhook recebendo payloads não assinados.

```
1. Invalidar MP_ACCESS_TOKEN_JOGO e MP_ACCESS_TOKEN_THERAPY no painel MP.

2. Regenerar MP_WEBHOOK_SECRET_JOGO e MP_WEBHOOK_SECRET_THERAPY:
   MercadoPago > Suas integrações > Notificações > Webhook secret.

3. Atualizar no Railway e reiniciar.

4. Checar transações MP das últimas 24h por cobranças suspeitas.
   Estornar se necessário via painel MP.

5. Checar audit_logs por chamadas a /payments/* e /webhooks/*.
```

---

### 2.5 Dependência com CVE (npm audit)

**Sinais:** GitHub Dependabot alert, npm audit finding no CI, Semgrep report.

```
1. Verificar severidade no advisory (CVSS score).

2. Se CVSS >= 7.0 (high):
   npm audit fix              # tenta fix automático
   npm audit fix --force      # se necessário (pode quebrar API — testar antes)

3. Se não há fix disponível:
   - Verificar se o código afetado está em produção (não apenas devDependencies).
   - Adicionar mitigação no WAF ou validação de input se o vetor for externo.
   - Monitorar o advisory por patch.

4. Commitar, push, deixar CI passar, Railway redeploya automaticamente.
```

---

### 2.6 Railway Offline / Deploy Quebrado

```
1. Verificar status.railway.app.

2. Se Railway up mas app down:
   Railway > seu serviço > Deployments > ver logs do deploy com erro.
   Fazer rollback para o último deploy estável:
   Railway > Deployments > clique no deploy anterior > Redeploy.

3. Se rollback não resolver:
   git revert HEAD && git push
   Railway redeploya automaticamente.

4. Verificar /health após estabilizar.
```

---

## 3. Contatos de Emergência

| Serviço | Canal de suporte |
|---------|-----------------|
| Railway | railway.app/help |
| Firebase / Google | firebase.google.com/support |
| LiveKit | livekit.io/support |
| MercadoPago | mercadopago.com.br/developers |
| Cloudflare R2 | dash.cloudflare.com/support |

---

## 4. Post-Mortem

Após cada incidente P0 ou P1, documentar em `docs/postmortems/YYYY-MM-DD.md`:

- **O que aconteceu** — linha do tempo
- **Impacto** — usuários afetados, duração
- **Causa raiz**
- **O que foi feito para resolver**
- **O que muda** — ações preventivas implementadas

---

## 5. Checklist Pós-Incidente

- [ ] Secret comprometido rotacionado
- [ ] /health verificado em prod e staging
- [ ] audit_logs revisado
- [ ] Usuários notificados (se aplicável)
- [ ] Causa raiz identificada e documentada
- [ ] Ação preventiva implementada e no código
- [ ] Post-mortem escrito (se P0/P1)
