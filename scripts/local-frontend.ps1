# =============================================================================
# Espaço Prelúdio — servidor estático local pra rodar o frontend.
#
# Uso (PowerShell, da pasta osl-video-server):
#   .\scripts\local-frontend.ps1
#
# Serve o frontend em http://localhost:8080 apontando pro backend em
# http://localhost:3000 (configura override via URL query). Use isso pra
# rodar Espaço Prelúdio 100% local sem depender de GitHub Pages nem tunnel.
#
# Requer: Python 3 (já vem no Windows 11 via Microsoft Store)
# =============================================================================

$ErrorActionPreference = "Stop"

$FrontendPath = "c:\Users\luish\Documents\Projetos\espaco-preludio-web"
if (-not (Test-Path $FrontendPath)) {
  Write-Host "ERRO: frontend não achado em $FrontendPath" -ForegroundColor Red
  exit 1
}

$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) {
  $python = (Get-Command py -ErrorAction SilentlyContinue).Source
}
if (-not $python) {
  Write-Host "ERRO: Python não encontrado. Instala via Microsoft Store." -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "─────────────────────────────────────────────────────" -ForegroundColor Green
Write-Host "  Frontend local — porta 8080" -ForegroundColor Green
Write-Host "─────────────────────────────────────────────────────" -ForegroundColor Green
Write-Host ""
Write-Host "Servindo:    $FrontendPath" -ForegroundColor Cyan
Write-Host "Acesso:      http://localhost:8080/login.html?backend=http://localhost:3000" -ForegroundColor White
Write-Host ""
Write-Host "Backend esperado em http://localhost:3000 — roda .\scripts\local-start.ps1" -ForegroundColor Yellow
Write-Host "em outro terminal antes de testar login." -ForegroundColor Yellow
Write-Host ""
Write-Host "Ctrl+C pra parar." -ForegroundColor Yellow
Write-Host ""

Set-Location $FrontendPath
& $python -m http.server 8080
