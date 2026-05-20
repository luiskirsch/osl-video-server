# =============================================================================
# Espaço Prelúdio — tunnel cloudflared do backend local pra URL HTTPS pública.
#
# Uso (PowerShell, depois que .\scripts\local-start.ps1 já estiver rodando):
#   .\scripts\local-tunnel.ps1
#
# Output: URL https://random-name.trycloudflare.com — copie e use no frontend
# como override: https://espacopreludio.com.br/painel.html?backend=<URL>
#
# A URL muda toda vez que você (re)inicia o tunnel. Pra URL fixa, precisa
# named tunnel (login Cloudflare + DNS) — não coberto neste script.
# =============================================================================

$ErrorActionPreference = "Stop"

# Refresca PATH (cloudflared instalado via winget pode não estar na sessão atual)
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
            [System.Environment]::GetEnvironmentVariable("Path","User")

$cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cloudflared) {
  Write-Host "ERRO: cloudflared não encontrado." -ForegroundColor Red
  Write-Host "Instala via:  winget install --id Cloudflare.cloudflared -e" -ForegroundColor Yellow
  exit 1
}

# Default = porta 3000 (mesma do server). Aceita PORT como arg opcional.
$port = if ($args.Count -ge 1) { $args[0] } else { 3000 }

# Checa se o backend tá respondendo
try {
  $resp = Invoke-WebRequest -Uri "http://localhost:$port/health" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
  $statusOk = $resp.StatusCode -eq 200
} catch { $statusOk = $false }

if (-not $statusOk) {
  Write-Host ""
  Write-Host "AVISO: backend em http://localhost:$port não responde." -ForegroundColor Yellow
  Write-Host "Roda .\scripts\local-start.ps1 em outro terminal primeiro." -ForegroundColor Yellow
  Write-Host "(Tunnel sobe mesmo assim, mas vai ficar sem destino.)" -ForegroundColor Yellow
  Write-Host ""
  Start-Sleep -Seconds 2
}

Write-Host ""
Write-Host "─────────────────────────────────────────────────────" -ForegroundColor Green
Write-Host "  Cloudflared tunnel → backend local (porta $port)" -ForegroundColor Green
Write-Host "─────────────────────────────────────────────────────" -ForegroundColor Green
Write-Host ""
Write-Host "Tunnel subindo. URL pública vai aparecer abaixo." -ForegroundColor Cyan
Write-Host "Quando vir 'https://random-name.trycloudflare.com', copia esse link." -ForegroundColor Cyan
Write-Host ""
Write-Host "Pra usar no frontend, abre:" -ForegroundColor Yellow
Write-Host "  https://espacopreludio.com.br/painel.html?backend=<URL_DO_TUNNEL>" -ForegroundColor White
Write-Host ""
Write-Host "Ctrl+C pra parar o tunnel." -ForegroundColor Yellow
Write-Host ""

& $cloudflared tunnel --url "http://localhost:$port"
