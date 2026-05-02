# Staging — osl-video-server

Backend tem dois deploys no Railway, lendo o **mesmo repo / mesma branch** (`master`), diferenciados apenas por **environment variables**.

| | Production | Staging |
|---|---|---|
| Service Railway | `osl-video-server` | `osl-video-server-staging` |
| URL pública | `https://osl-video-server-production.up.railway.app` | `https://osl-video-server-staging.up.railway.app` |
| `APP_ENV` | `production` | `staging` |
| Firebase Admin | service account de `osextolugar-game` | service account de `sextolugar-staging` |
| MercadoPago | token de produção | token **sandbox** (não cobra cartão real) |
| LiveKit | mesma instância (não duplicado) | mesma instância (não duplicado) |
| Secrets (`LICENSE_SECRET`, etc.) | produção | **diferentes** — geram tokens incompatíveis com prod |

`/health` retorna `appEnv`, `firebaseProjectId`, etc. — usa pra validar o ambiente em runtime.

## Setup do service Railway de staging

> Pré-requisito: tu já tem o service de produção no Railway. Vamos clonar o setup pra um novo service no mesmo project.

### 1. Cria o service

Railway dashboard → projeto que contém o `osl-video-server` atual → **+ New** (botão no canto superior direito do canvas) → **GitHub Repo** → seleciona o mesmo repo do backend.

Aceita os defaults (build automático, sem health-check específico).

### 2. Renomeia o service

Clica no service novo → **Settings** → **Service Name** → `osl-video-server-staging`. Salva.

### 3. Configura branch

**Settings → Source → Branch** → seleciona `master`.

> Se quiseres testar mudanças de código antes do prod, cria a branch `staging` no repo e aponta esse service pra ela. Por enquanto, a mesma branch é o caminho mais simples — só as env vars diferem.

### 4. Gera o service account do Firebase staging

Console Firebase do projeto `sextolugar-staging`:

**Configurações do projeto** (engrenagem) → aba **Service accounts** → botão **Generate new private key** → confirma.

Vai baixar um `sextolugar-staging-firebase-adminsdk-*.json`. Abre num editor de texto e copia **o JSON inteiro** (vai usar no próximo passo).

### 5. Configura as env vars

No service de staging do Railway → **Variables** → **+ New Variable** pra cada item da tabela abaixo:

#### Críticas (sem isso o backend nem inicia certo)

| Variable | Valor pra staging |
|---|---|
| `APP_ENV` | `staging` |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | (cola o JSON inteiro do passo 4) |
| `PORT` | (Railway preenche sozinho) |

#### URLs

| Variable | Valor pra staging |
|---|---|
| `BACKEND_BASE_URL` | `https://osl-video-server-staging.up.railway.app` (atualiza depois com a URL final do passo 7) |
| `FRONTEND_BASE_URL` | `https://preludiojogos.com/staging` |
| `RECORDING_LAYOUT_URL` | `https://preludiojogos.com/staging/recording-layout.html` |

#### LiveKit (mesma instância de prod — sem custo extra)

Copia das vars de produção:
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `LIVEKIT_URL`

#### MercadoPago — usa **sandbox** em staging

| Variable | Valor pra staging |
|---|---|
| `MP_ACCESS_TOKEN` | **token sandbox** do MercadoPago (não o de produção). Gera em https://www.mercadopago.com.br/developers → Suas integrações → tua aplicação → Credenciais de teste. |

#### Secrets — **gera novos** pra staging

> ⚠️ **Não reuses os de prod**. Se reusar, um token JWT criado em staging seria aceito em prod (e vice-versa) — buraco de segurança.

Roda no terminal pra gerar 3 secrets aleatórios e cola no Railway:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

| Variable | Valor pra staging |
|---|---|
| `LICENSE_SECRET` | (output 1 do comando acima) |
| `ACCESS_TOKEN_SECRET` | (output 2) |
| `ADMIN_SECRET` | (output 3) |

#### S3 (gravações) — opcional pra staging

Se quiseres testar gravações em staging, copia as vars de prod:
- `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_PUBLIC_URL`

Pra evitar mistura, idealmente cria um bucket separado (`osl-recordings-staging`) e aponta as vars pra ele. Pra começar, pode pular — staging vai falhar em gravar mas o resto funciona.

#### Anthropic AI — opcional

Se queres que detecção de áudio funcione em staging, copia `ANTHROPIC_API_KEY` de prod.

#### Discord — opcional

Em staging deixa vazio (`DISCORD_*`) a menos que tenhas um servidor Discord de teste. Cliente continua funcionando, só desabilita as integrações de cargo.

### 6. Deploy

Volta na aba **Deployments** do service. Railway vai começar o build automaticamente assim que detectar variáveis novas. Aguarda ~2-3min.

### 7. Gera URL pública

**Settings → Networking → Public Networking** → clica **Generate Domain**.

Vai gerar algo como `osl-video-server-staging-production.up.railway.app` (Railway anexa um sufixo — varia). **Copia a URL exata** que ele gerou e:

1. Volta em **Variables**, atualiza `BACKEND_BASE_URL` pra essa URL exata.
2. Me passa a URL — vou substituir o placeholder em [`app.config.js`](../sextolugar-app/app.config.js) (`API_URL_STAGING`).

### 8. Valida via /health

```bash
curl https://<tua-url-staging>.up.railway.app/health
```

Deve retornar JSON com:
```json
{
  "ok": true,
  "appEnv": "staging",
  "firebaseConfigured": true,
  "firebaseProjectId": "sextolugar-staging",
  ...
}
```

Se `appEnv` vier `production`: `APP_ENV` não foi setado certo.
Se `firebaseConfigured: false`: `FIREBASE_SERVICE_ACCOUNT_JSON` está malformado ou ausente.
Se `firebaseProjectId` vier `osextolugar-game`: tu colou o service account de prod por engano.

## Hand-off pra mim

Quando o /health vier ok com `appEnv: "staging"` e `firebaseProjectId: "sextolugar-staging"`, me manda:
1. A URL pública final
2. Print do output do /health

Eu atualizo o `API_URL_STAGING` no app, faço commit + push, e aí builds EAS staging vão consumir esse backend isolado.
