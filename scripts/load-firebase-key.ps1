# =============================================================================
# Espaço Prelúdio — carrega a Firebase Admin SDK key direto do JSON pro .env
#
# Uso:
#   .\scripts\load-firebase-key.ps1 -JsonPath "C:\Users\luish\Downloads\sextolugar-staging-firebase-adminsdk-XXX.json"
#
# Ou sem arg (pede o caminho interativamente):
#   .\scripts\load-firebase-key.ps1
#
# O que faz:
#   1. Lê o JSON baixado do Firebase Console
#   2. Comprime pra uma linha (preserva \n escapado dentro de private_key)
#   3. Faz backup do .env atual em .env.bak
#   4. Substitui linha FIREBASE_SERVICE_ACCOUNT_JSON=... no .env
#   5. Pergunta se quer deletar o JSON baixado (recomendado)
# =============================================================================

param(
  [string]$JsonPath
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$EnvPath = Join-Path $RepoRoot ".env"

# Pede caminho se não veio como arg
if (-not $JsonPath) {
  Write-Host ""
  Write-Host "Cole o caminho do JSON que o Firebase Console baixou:" -ForegroundColor Cyan
  Write-Host "(ex: C:\Users\luish\Downloads\sextolugar-staging-firebase-adminsdk-xxx.json)" -ForegroundColor Gray
  $JsonPath = Read-Host "JSON path"
  $JsonPath = $JsonPath.Trim('"').Trim("'")
}

if (-not (Test-Path $JsonPath)) {
  Write-Host "ERRO: arquivo não encontrado: $JsonPath" -ForegroundColor Red
  exit 1
}
if (-not (Test-Path $EnvPath)) {
  Write-Host "ERRO: .env não existe em $EnvPath" -ForegroundColor Red
  exit 1
}

# Lê e valida JSON
Write-Host ""
Write-Host "Lendo: $JsonPath" -ForegroundColor Cyan
$rawJson = Get-Content $JsonPath -Raw -Encoding UTF8

# Valida que é JSON do Firebase
try {
  $parsed = $rawJson | ConvertFrom-Json
  if (-not $parsed.type -or $parsed.type -ne "service_account") {
    Write-Host "ERRO: o JSON não parece ser uma service account do Firebase (type != 'service_account')." -ForegroundColor Red
    exit 1
  }
  if (-not $parsed.project_id) {
    Write-Host "ERRO: project_id ausente no JSON." -ForegroundColor Red
    exit 1
  }
  Write-Host "OK — projeto: $($parsed.project_id), client_email: $($parsed.client_email)" -ForegroundColor Green
} catch {
  Write-Host "ERRO: JSON inválido. Detalhe: $_" -ForegroundColor Red
  exit 1
}

# Comprime: remove newlines REAIS (formatting) mas preserva \n escapado
# (que é literalmente 2 chars dentro do valor da string private_key).
# Resultado: JSON em uma linha só, válido pra dotenv.
$singleLine = ($rawJson -replace "`r`n", "" -replace "`n", "" -replace "`r", "").Trim()

# Backup do .env atual
$BackupPath = "$EnvPath.bak"
Copy-Item $EnvPath $BackupPath -Force
Write-Host "Backup salvo em: $BackupPath" -ForegroundColor Gray

# Lê .env, substitui a linha. Mantém todas as outras intactas.
$envLines = [System.IO.File]::ReadAllLines($EnvPath, [System.Text.UTF8Encoding]::new($false))
$replaced = $false
$newLines = foreach ($line in $envLines) {
  if ($line -match "^FIREBASE_SERVICE_ACCOUNT_JSON=") {
    $replaced = $true
    "FIREBASE_SERVICE_ACCOUNT_JSON=$singleLine"
  } else {
    $line
  }
}
if (-not $replaced) {
  # Linha não existe — appenda no fim
  $newLines = @($newLines) + "FIREBASE_SERVICE_ACCOUNT_JSON=$singleLine"
  Write-Host "Nota: linha FIREBASE_SERVICE_ACCOUNT_JSON= não existia, foi adicionada no fim." -ForegroundColor Yellow
}

# Escreve UTF8 sem BOM (evita corromper outras vars com acento)
[System.IO.File]::WriteAllLines($EnvPath, $newLines, [System.Text.UTF8Encoding]::new($false))

Write-Host ""
Write-Host "✓ .env atualizado." -ForegroundColor Green
Write-Host ""

# Validação final: tenta parsear de volta pra ver se ficou íntegro
$verifyContent = Get-Content $EnvPath -Raw -Encoding UTF8
if ($verifyContent -match "FIREBASE_SERVICE_ACCOUNT_JSON=(\{.+\})") {
  try {
    $reparsed = $matches[1] | ConvertFrom-Json
    if ($reparsed.project_id) {
      Write-Host "Validação OK — JSON pode ser parseado de volta." -ForegroundColor Green
    }
  } catch {
    Write-Host "AVISO: gravou mas não consegui reparsear. Verifica $EnvPath manualmente." -ForegroundColor Yellow
  }
}

Write-Host ""
Write-Host "Quer DELETAR o JSON baixado agora? (recomendado — chave dá acesso total ao Firestore)" -ForegroundColor Cyan
$resp = Read-Host "(s/n)"
if ($resp -match "^[sS]") {
  Remove-Item $JsonPath -Force
  Write-Host "Deletado: $JsonPath" -ForegroundColor Green
} else {
  Write-Host "Mantido: $JsonPath (lembra de deletar depois)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Próximo passo:" -ForegroundColor Cyan
Write-Host "  .\scripts\local-start.ps1" -ForegroundColor White
Write-Host ""
