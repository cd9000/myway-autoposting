Set-Location $PSScriptRoot

New-Item -ItemType Directory -Force -Path myway-worker | Out-Null
Set-Location myway-worker

npm init -y
npm install @neondatabase/serverless hono
npm install -D @cloudflare/workers-types typescript wrangler

New-Item -ItemType Directory -Force -Path src | Out-Null
