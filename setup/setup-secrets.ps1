Set-Location $PSScriptRoot\myway-worker

$env:CLOUDFLARE_API_TOKEN = [Environment]::GetEnvironmentVariable('CLOUDFLARE_API_TOKEN', 'User')
if (-not $env:CLOUDFLARE_API_TOKEN) {
    Write-Host 'CLOUDFLARE_API_TOKEN not found in user environment.' -ForegroundColor Red
    exit 1
}

Write-Host '=== 1/2 NEON_DATABASE_URL ===' -ForegroundColor Cyan
Write-Host 'Neon Console -> Dashboard -> Connection Details (starts with postgresql://)'
npx wrangler secret put NEON_DATABASE_URL

Write-Host '=== 2/2 AI_API_KEY ===' -ForegroundColor Cyan
npx wrangler secret put AI_API_KEY

Write-Host 'Done. Remaining secrets were already set by the assistant.' -ForegroundColor Green
Write-Host 'Send /start to @MyWayinfo2_bot in Telegram to test.' -ForegroundColor Green
