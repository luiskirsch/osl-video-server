# Separação Firestore staging ↔ prod

Procedimento operacional pra quando o volume justificar separar os dois
ambientes. Hoje compartilham o projeto `sextolugar-staging`.

## Pré-requisitos

- Conta de cobrança Firebase Blaze configurada (necessário pra Cloud
  Functions, autenticação de domínios customizados, etc).
- ~30 minutos.
- Sem usuários ativos no momento do switch (faça à noite).

## Passo a passo

### 1. Criar novo projeto Firebase

1. https://console.firebase.google.com → "Adicionar projeto"
2. Nome: `espaco-preludio-prod`
3. Plano: Blaze (pay-as-you-go)
4. Authentication → Sign-in method → habilite **E-mail/senha** + qualquer
   provedor que já usa em staging.
5. Firestore → Create database → modo Production → região `southamerica-east1`.
6. Storage → Get started (não usamos hoje, mas reserve a região).

### 2. Baixar credenciais de service account

**Source (staging atual):**
- Console → Project Settings → Service Accounts → "Generate new private key"
- Salve como `osl-video-server/service-account-source.json`

**Target (novo prod):**
- Mesma coisa no novo projeto
- Salve como `osl-video-server/service-account-target.json`

⚠️ Esses JSONs dão acesso TOTAL aos projetos. NUNCA commite. Já está implícito
no `.gitignore` via padrão geral (mas confirme).

### 3. Migrar Firestore

```bash
cd osl-video-server
node scripts/migrate-firestore-split.js --dry-run
# Confira a saída: cada collection lista quantos docs serão copiados.
# Se OK, rode sem --dry-run:
node scripts/migrate-firestore-split.js
```

O script copia ~20 collections terapia, pulando audit/email-log (começam
limpos no destino).

### 4. Migrar Firebase Auth (usuários)

```bash
# No source:
firebase use sextolugar-staging
firebase auth:export users.json --format=json

# No target:
firebase use espaco-preludio-prod
firebase auth:import users.json
```

Senhas são exportadas como hash bcrypt — válidas no destino sem reset.

### 5. Configurar Railway

No painel Railway:
1. Duplique o env `staging` → renomeie pra `production`.
2. Variables → substitua `GOOGLE_APPLICATION_CREDENTIALS_JSON` pelo conteúdo
   do `service-account-target.json`.
3. Deploy.

Anote a URL do novo env: provavelmente `osl-video-server-production.up.railway.app`.

### 6. Switch DNS

- `espacopreludio.com.br` → continua apontando pra GitHub Pages (frontend).
- Atualize `js/firebase-config.js` no repo frontend:
  - **Branch `main`** (produção): `BACKEND_BASE_URL` aponta pra Railway env
    `production`, `firebaseConfig` aponta pra projeto novo.
  - **Branch staging** (se for migrar pra subdomínio também): aponta pra
    Railway env `staging` (mantém o antigo).

### 7. Validação

1. Login em https://espacopreludio.com.br com user real.
2. Verifique `/me` retorna o perfil correto.
3. Liste pacientes — devem aparecer (vieram da migração).
4. Crie uma sessão de teste — verifique escreve no projeto NOVO.

### 8. Plano de rollback

Se algo der errado nas 24h pós-switch:
1. Reverte `js/firebase-config.js` pra apontar de volta pra projeto antigo.
2. Re-deploy frontend.
3. Investigue diff entre projeto novo (escritas pós-switch) e antigo. Re-rode
   `migrate-firestore-split.js` no sentido inverso se houver dados a recuperar.

### 9. Custos estimados (mensal)

- Firebase Blaze: ~US$ 5-15 (Firestore reads/writes baixos no início).
- Railway env extra: ~US$ 5-10.
- Resend (e-mail): se separar domínio, +US$ 0 (free tier).
- **Total: ~US$ 10-25/mês extras.**

Vale quando o projeto tiver >50 profissionais ativos pagando. Antes disso, o
risco/custo da separação supera o benefício de isolamento.

## Quando NÃO fazer

- Antes de ter receita recorrente (custo extra fixo sem ROI).
- Em pleno horário comercial (downtime potencial de 5-30 min).
- Sem backup completo do projeto antigo (rode `migrate-firestore-split.js`
  primeiro pra ter uma cópia espelho).
