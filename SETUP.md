# Espaço Prelúdio — Setup do backend

Checklist pro Luís ativar todas as features. Em ordem de criticidade.

## ✅ Pré-requisito: deploy do Railway funcionando

Backend tem que estar com **build atual** do branch `luiskirsch.github.io`. Pra conferir:

```bash
curl https://osl-video-server-staging.up.railway.app/therapy/cid10?q=F32
```

- HTTP 401 (TOKEN_NAO_INFORMADO) = build atual ✓
- HTTP 404 (ROTA_NAO_ENCONTRADA) = build antigo ✗ — pushar commit novo + Railway "Redeploy without cache"

---

## 🔴 OBRIGATÓRIO (sem isso, app não sobe ou principal feature quebra)

### 1. Railway → Variables (cole tudo)

Os 4 secrets abaixo **já gerados** — só copiar/colar:

```
ACCESS_TOKEN_SECRET=GERE_UM_SEGREDO_FORTE_E_UNICO
LICENSE_SECRET=GERE_UM_SEGREDO_FORTE_E_UNICO
ADMIN_SECRET=GERE_UM_SEGREDO_FORTE_E_UNICO
THERAPY_ADMIN_EMAILS=luishenriquekirsch@hotmail.com
```

VAPID (push notifications) também já gerados:

```
VAPID_PUBLIC_KEY=xxxxxxxx
VAPID_PRIVATE_KEY=xxxxxxxxxx
VAPID_SUBJECT=mailto:contato@espacopreludio.com.br
```

### 2. Firebase Admin SDK

Console Firebase → `sextolugar-staging` → Project Settings → Service accounts → **Generate new private key** → baixa JSON.

Cola o JSON inteiro como UMA LINHA na env var:

```
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"sextolugar-staging",...}
```

### 3. LiveKit (já configurado se /health.livekitConfigured=true)

Confirma no `/health`:
```bash
curl https://osl-video-server-staging.up.railway.app/health | grep livekitConfigured
```

Se `false`, criar projeto em [cloud.livekit.io](https://cloud.livekit.io) e setar:

```
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
LIVEKIT_URL=wss://...livekit.cloud
```

---

## 🟡 IMPORTANTE (features adjacentes quebram silenciosamente)

### 4. Resend (e-mails)

Sem isso: e-mails de reset senha, lembrete de consulta, NPS pós-sessão, aniversariantes — **nada disso é enviado**, mas o app não quebra.

- [resend.com](https://resend.com) → criar conta (grátis até 3k emails/mês)
- Domínio espacopreludio.com: adicionar registros SPF + DKIM no DNS (Resend te dá)
- API Keys → criar key

```
RESEND_API_KEY=re_xxxxxxxxxxxxxx
EMAIL_FROM=Espaço Prelúdio <nao-responda@espacopreludio.com>
```

### 5. Mercado Pago (cobrança dos planos)

Sem isso: ninguém paga, todos ficam em trial pra sempre.

- [mercadopago.com.br/developers](https://www.mercadopago.com.br/developers) → suas aplicações → criar
- Access token de produção
- Configurar webhook: `https://osl-video-server-staging.up.railway.app/webhooks/mercadopago`
- Eventos: `payment` + `subscription_preapproval`

```
MP_ACCESS_TOKEN=APP_USR-xxxxxxxxxxxxxxxxx
MP_WEBHOOK_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
MP_WEBHOOK_REQUIRE_SIG=true
```

### 6. S3 ou Cloudflare R2 (uploads + recibos)

Pra: upload de comprovantes (estudante/recém-formado), recibos PDF, anexos.

Recomendo **Cloudflare R2** (sem egress fee, ~$0.015/GB).

- [dash.cloudflare.com](https://dash.cloudflare.com) → R2 → criar bucket `espacopreludio-uploads`
- Manage R2 API Tokens → criar com Edit acesso
- Copiar: Access Key ID, Secret Access Key, Account ID (vai no endpoint)

```
S3_ACCESS_KEY=xxxxxxxxxxxxxxxxxxxx
S3_SECRET_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
S3_BUCKET=espacopreludio-uploads
S3_REGION=auto
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_PUBLIC_URL=https://uploads.espacopreludio.com
```

### 7. Anthropic (validação automática de estudante)

Sem isso: comprovante de matrícula precisa aprovação manual sua a cada cadastro de estudante.

- [console.anthropic.com](https://console.anthropic.com) → API Keys → criar
- Modelo usado: claude-3-5-sonnet (vision)

```
ANTHROPIC_API_KEY=sk-ant-api03-xxxxxxxxxxxxxxxxxxxxx
```

---

## 🟢 OPCIONAL (features específicas, podem esperar)

### 8. Z-API (WhatsApp)

- [z-api.io](https://z-api.io) → instância → conectar WhatsApp

### 9. Validação automática de CFP/CRP

Sem isso: profissional cadastra qualquer número, validação fica manual.

- [idwall.co](https://idwall.co) ou Confiradoc → API key
- `CFP_VALIDATOR_PROVIDER=idwall` (ou `confiradoc`)

### 10. NFS-e (nota fiscal)

- [nfe.io](https://nfe.io) → tokens API

---

## 🔧 Pós-config: verificar tudo

Depois de colar tudo no Railway, restart o serviço e roda:

```bash
cd c:/Users/luish/osl-video-server
export ADMIN_SECRET=GERE_UM_SEGREDO_FORTE_E_UNICO
bash scripts/health-check.sh
```

Vai mostrar quais env vars ainda faltam + se as rotas novas subiram.

---

## ⚠️ Última coisa: arrumar o auto-deploy

O webhook GitHub → Railway parou de funcionar em 2026-05-13. Pra não acontecer de novo:

1. Railway → projeto → Settings → Source
2. Desconectar GitHub
3. Reconectar (vai disparar uma re-autorização)
4. Confirmar que **Branch = luiskirsch.github.io** + **Auto Deploy = ON**

Próximo push pra esse branch deve disparar build automático.
