# Rodar Espaço Prelúdio LOCAL (notebook)

Fallback pra quando Railway cair. Backend roda no teu notebook, frontend
remoto aponta pra ele via tunnel HTTPS (ou tudo local se preferir 100% offline).

## TL;DR — 3 cenários

### Cenário A — Bare bones (só `/health` responde, sem secrets)
```powershell
.\scripts\local-start.ps1
```
Útil pra testar que infra sobe. Login não funciona.

### Cenário B — Login funciona (precisa FIREBASE_SERVICE_ACCOUNT_JSON)
1. Preenche `FIREBASE_SERVICE_ACCOUNT_JSON` no `.env` (instruções abaixo)
2. `.\scripts\local-start.ps1`
3. Em outro terminal: `.\scripts\local-tunnel.ps1`
4. Cloudflared imprime URL `https://random.trycloudflare.com`
5. Abre `https://espacopreludio.com.br/painel.html?backend=https://random.trycloudflare.com`
6. Login funciona, perfil carrega, dashboard idem

### Cenário C — Tudo offline (frontend também local)
1. Preenche `.env`
2. `.\scripts\local-start.ps1` (backend)
3. Em outro terminal: `.\scripts\local-frontend.ps1` (frontend estático)
4. Abre `http://localhost:8080/login.html?backend=http://localhost:3000`

---

## Pré-requisitos

- **Node 18+** — já tem (`node --version` mostra v24)
- **Cloudflared** — instalado via `winget install Cloudflare.cloudflared` (já feito)
- **Python 3** (apenas pro Cenário C) — vem com Windows 11 ou Store
- **`.env` preenchido** — já criado em `osl-video-server/.env`, falta colar secrets

---

## Como pegar os secrets pra preencher `.env`

### 1. `FIREBASE_SERVICE_ACCOUNT_JSON` (obrigatório pra login)

1. Abre [Firebase Console](https://console.firebase.google.com/project/sextolugar-staging)
2. Engrenagem (Settings) → **Project settings**
3. Aba **Service accounts**
4. Botão **Generate new private key** → confirma → baixa um JSON
5. Abre o JSON num editor de texto, **copia tudo**
6. No `.env`, na linha `FIREBASE_SERVICE_ACCOUNT_JSON=`, cola o JSON inteiro em uma linha só. Exemplo:
   ```
   FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"sextolugar-staging","private_key_id":"abc...","private_key":"-----BEGIN PRIVATE KEY-----\nMIIEvgIBADAN...\n-----END PRIVATE KEY-----\n","client_email":"firebase-adminsdk-xxxxx@sextolugar-staging.iam.gserviceaccount.com",...}
   ```
   **Importante:** `\n` dentro do `private_key` permanece como `\n` literal (não é newline real).

### 2. `LIVEKIT_API_KEY` + `LIVEKIT_API_SECRET` (vídeo)

1. [cloud.livekit.io](https://cloud.livekit.io) → projeto `osextolugar`
2. **Settings → API Keys** → existing ou create new
3. Cola `API Key` em `LIVEKIT_API_KEY=` e `Secret Key` em `LIVEKIT_API_SECRET=`

### 3. `ANTHROPIC_API_KEY` (Aurora chatbot)

1. [console.anthropic.com](https://console.anthropic.com) → **API Keys** → create key
2. Cola em `ANTHROPIC_API_KEY=`

### 4. `MP_ACCESS_TOKEN_THERAPY` (cobrança)

1. [mercadopago.com.br/developers/panel/app](https://www.mercadopago.com.br/developers/panel/app) → app do Espaço Prelúdio
2. **Credenciais de produção** → Access Token
3. Cola em `MP_ACCESS_TOKEN_THERAPY=`

### 5. `RESEND_API_KEY` (e-mails)

1. [resend.com/api-keys](https://resend.com/api-keys)
2. Create API Key → cola em `RESEND_API_KEY=`

### 6. Opcionais (pula se não precisa)

- `ZAPI_*` (WhatsApp) — z-api.io
- `TWILIO_*` (SMS) — twilio.com
- `S3_*` (uploads) — Cloudflare R2 ou AWS S3
- `NFEIO_*` (NFS-e) — nfe.io

---

## Como rodar

### Inicia o backend

Abre PowerShell na pasta `osl-video-server`:
```powershell
.\scripts\local-start.ps1
```

Verifica que respondeu:
```powershell
curl http://localhost:3000/health
```

### Expõe via tunnel HTTPS (pra usar com espacopreludio.com.br)

Em **outro terminal**:
```powershell
.\scripts\local-tunnel.ps1
```

Cloudflared imprime algo tipo:
```
2026-05-20T01:23:45Z INF +--------------------------------------------------------------------------------------------+
2026-05-20T01:23:45Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-05-20T01:23:45Z INF |  https://wave-banana-celebration-foo.trycloudflare.com                                     |
2026-05-20T01:23:45Z INF +--------------------------------------------------------------------------------------------+
```

Copia a URL. No navegador, abre:
```
https://espacopreludio.com.br/painel.html?backend=https://wave-banana-celebration-foo.trycloudflare.com
```

O frontend salva esse override em `localStorage` — sucessivas navegações
dentro do site mantêm apontando pro tunnel.

### Voltar pro Railway

Limpa o override em qualquer página, F12 (DevTools) → Console:
```js
localStorage.removeItem("ep_backend_url_override"); location.reload();
```

OU abre `?backend=https://osl-video-server-staging.up.railway.app` na URL.

---

## Limitações conhecidas

- **Notebook tem que estar acordado.** Se você fechar a tampa ou hibernar, backend cai. Cloudflared também.
- **URL do tunnel muda** a cada `.\scripts\local-tunnel.ps1`. Pra URL fixa, precisa
  Cloudflare Tunnel **nomeado** com domínio próprio — não coberto aqui (5min extra de setup,
  documentado em [developers.cloudflare.com/cloudflare-one/connections/connect-networks/](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)).
- **MP webhook não chega no localhost.** Se cliente paga via MP, a notificação tenta hitar
  Railway (URL configurada no MP dashboard). Pra testar webhook localmente, precisa
  reconfigurar URL no MP dashboard → tunnel temporário. Não vale a pena pra fallback curto.
- **Cron jobs (lembretes, reverificação anual)** rodam no servidor local — funcionam
  enquanto ele tiver up.

---

## Workflow recomendado pra outage Railway

1. Railway cai (você vê no `status.railway.com` ou pelo banner do painel)
2. Abre PowerShell, roda `.\scripts\local-start.ps1`
3. Em outro terminal, `.\scripts\local-tunnel.ps1` — copia a URL
4. Avisa users (WhatsApp, status page se tiver) com o link:
   `https://espacopreludio.com.br/painel.html?backend=<URL>`
5. Quando Railway volta, manda novo link sem `?backend=` (ou eles limpam localStorage).
