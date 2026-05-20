# =============================================================================
# Espaço Prelúdio — start LOCAL do backend.
#
# Uso (PowerShell, da pasta osl-video-server):
#   .\scripts\local-start.ps1
#
# Pré-requisitos:
#   - Node 18+ instalado
#   - .env preenchido (pelo menos FIREBASE_SERVICE_ACCOUNT_JSON pra login funcionar)
#   - npm install já rodou (verifica e roda se faltar node_modules)
# =============================================================================

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

Write-Host ""
Write-Host "─────────────────────────────────────────────────────" -ForegroundColor Green
Write-Host "  Espaço Prelúdio — backend local (notebook)" -ForegroundColor Green
Write-Host "─────────────────────────────────────────────────────" -ForegroundColor Green
Write-Host ""

# Checa Node
$nodeVersion = node --version 2>$null
if (-not $nodeVersion) {
  Write-Host "ERRO: Node.js não encontrado. Instala em nodejs.org (18+)." -ForegroundColor Red
  exit 1
}
Write-Host "Node:        $nodeVersion" -ForegroundColor Cyan

# Checa .env
if (-not (Test-Path ".env")) {
  Write-Host "ERRO: .env não existe. Veja LOCAL-SETUP.md." -ForegroundColor Red
  exit 1
}

# Checa secrets críticos
$envContent = Get-Content ".env" -Raw
$missingCritical = @()
if ($envContent -notmatch "FIREBASE_SERVICE_ACCOUNT_JSON=\S") { $missingCritical += "FIREBASE_SERVICE_ACCOUNT_JSON" }
if ($missingCritical.Count -gt 0) {
  Write-Host ""
  Write-Host "AVISO: secrets obrigatórios faltando no .env:" -ForegroundColor Yellow
  foreach ($s in $missingCritical) { Write-Host "  - $s" -ForegroundColor Yellow }
  Write-Host "Servidor sobe mas login/auth não funcionam. Veja LOCAL-SETUP.md." -ForegroundColor Yellow
  Write-Host ""
}

# Instala deps se preciso
if (-not (Test-Path "node_modules")) {
  Write-Host "node_modules não existe. Rodando npm install..." -ForegroundColor Yellow
  npm install
}

# Pega IP local pra mostrar como acessar de outros devices na mesma rede
$localIP = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias "Wi-Fi","Ethernet" -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -notlike "169.254.*" -and $_.PrefixOrigin -eq "Dhcp" } |
            Select-Object -First 1).IPAddress

$port = ($envContent | Select-String -Pattern "PORT=(\d+)" | ForEach-Object { $_.Matches[0].Groups[1].Value })
if (-not $port) { $port = "3000" }

Write-Host ""
Write-Host "Backend subindo em:" -ForegroundColor Green
Write-Host "  http://localhost:$port" -ForegroundColor White
if ($localIP) {
  Write-Host "  http://$($localIP):$port  (mesma rede local)" -ForegroundColor White
}
Write-Host ""
Write-Host "Health-check: http://localhost:$port/health" -ForegroundColor Cyan
Write-Host ""
Write-Host "Pra expor publicamente via tunnel HTTPS, em outro terminal:" -ForegroundColor Cyan
Write-Host "  .\scripts\local-tunnel.ps1" -ForegroundColor White
Write-Host ""
Write-Host "Ctrl+C pra parar o servidor." -ForegroundColor Yellow
Write-Host ""

node server.js
