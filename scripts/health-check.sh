#!/usr/bin/env bash
# Health-check completo do backend deployado.
# Testa: backend up, rotas novas presentes, env vars críticos configurados.
#
# Uso:  bash scripts/health-check.sh [URL_BASE]
# Default URL: https://osl-video-server-staging.up.railway.app

BASE="${1:-https://osl-video-server-staging.up.railway.app}"
RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; RESET=$'\033[0m'

echo "Health-check de $BASE"
echo

# --- 1. Backend up + config -----------------------------------------------
echo "${DIM}# 1. Backend up + config geral${RESET}"
HEALTH=$(curl -s "$BASE/health")
echo "$HEALTH" | grep -q '"ok":true' && echo "  ${GREEN}✓${RESET} backend respondendo (/health)" || { echo "  ${RED}✗${RESET} backend não respondeu"; exit 1; }
echo "$HEALTH" | grep -q '"firebaseConfigured":true' && echo "  ${GREEN}✓${RESET} Firebase configurado (FIREBASE_SERVICE_ACCOUNT_JSON)" || echo "  ${RED}✗${RESET} Firebase NÃO configurado — env var FIREBASE_SERVICE_ACCOUNT_JSON faltando"
echo "$HEALTH" | grep -q '"livekitConfigured":true' && echo "  ${GREEN}✓${RESET} LiveKit configurado (LIVEKIT_API_KEY/SECRET/URL)" || echo "  ${RED}✗${RESET} LiveKit NÃO configurado — env vars LIVEKIT_* faltando"
STARTED=$(echo "$HEALTH" | grep -oE '"startedAt":"[^"]+"' | sed 's/"startedAt":"\(.*\)"/\1/')
UPTIME=$(echo "$HEALTH"  | grep -oE '"uptimeSec":[0-9]+' | sed 's/"uptimeSec"://')
echo "  ${DIM}startedAt: $STARTED · uptime: ${UPTIME}s${RESET}"
echo

# --- 2. Rotas novas (deploy de 2026-05-13+) ------------------------------
echo "${DIM}# 2. Rotas novas (commits posteriores a 2026-05-05)${RESET}"
check_route() {
  local path="$1" label="$2"
  local code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE$path")
  case "$code" in
    404) echo "  ${RED}✗${RESET} $label — HTTP 404 (rota ausente, deploy stale)" ;;
    401|403) echo "  ${GREEN}✓${RESET} $label — HTTP $code (rota OK, exige auth)" ;;
    200) echo "  ${GREEN}✓${RESET} $label — HTTP 200" ;;
    5*) echo "  ${YELLOW}!${RESET} $label — HTTP $code (rota OK mas erro server, ver logs)" ;;
    *) echo "  ${YELLOW}?${RESET} $label — HTTP $code" ;;
  esac
}
check_route "/therapy/cid10?q=F32"           "/therapy/cid10                (CID-10)"
check_route "/therapy/chat/keypair"          "/therapy/chat/keypair         (Chat E2EE)"
check_route "/therapy/painel/hoje"           "/therapy/painel/hoje          (Dashboard Hoje)"
check_route "/public/profissionais?limit=1"  "/public/profissionais         (Diretório público)"
check_route "/therapy/scales/templates"      "/therapy/scales/templates     (PHQ-9 + GAD-7)"
check_route "/therapy/nfse/test"             "/therapy/nfse/test            (NFS-e)"
check_route "/therapy/paciente/notas"        "/therapy/paciente/notas       (Notas paciente)"
check_route "/therapy/profissional/me"       "/therapy/profissional/me      (Perfil — feature antiga)"
echo

# --- 3. Env vars (via /admin/env-check, requer ADMIN_SECRET) --------------
echo "${DIM}# 3. Env vars setadas (export ADMIN_SECRET=... antes de rodar)${RESET}"
if [ -n "$ADMIN_SECRET" ]; then
  ENV_JSON=$(curl -s -H "X-Admin-Secret: $ADMIN_SECRET" "$BASE/admin/env-check")
  if echo "$ENV_JSON" | grep -q '"ok":true'; then
    # parse manual pra evitar dep de jq
    echo "$ENV_JSON" | tr ',' '\n' | grep -oE '"[A-Z_]+":\{"set":(true|false)' | while read line; do
      var=$(echo "$line" | grep -oE '"[A-Z_]+"' | head -1 | tr -d '"')
      if echo "$line" | grep -q ':true'; then
        echo "  ${GREEN}✓${RESET} $var"
      else
        echo "  ${RED}✗${RESET} $var (não setada)"
      fi
    done
  else
    echo "  ${RED}!${RESET} ADMIN_SECRET inválido ou /admin/env-check ainda não deployado"
  fi
else
  echo "  ${YELLOW}!${RESET} ADMIN_SECRET não setado no shell — pulando."
  echo "    Pra rodar: ${DIM}export ADMIN_SECRET=<o secret do Railway>; bash scripts/health-check.sh${RESET}"
fi
echo

echo "Done. Re-rodar: bash scripts/health-check.sh"
