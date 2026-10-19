$ErrorActionPreference = 'Stop'
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Для запуска нужен Docker Desktop с Linux-контейнерами.'
}
Push-Location $PSScriptRoot
try {
    & docker compose -f compose.complete.yaml up --build -d
    if ($LASTEXITCODE -ne 0) { throw 'Запуск не завершён. Проверьте состояние Docker и журнал Compose.' }
    $sitePort = if ($env:BEEGO_HTTP_PORT) { $env:BEEGO_HTTP_PORT } else { '8787' }
    Write-Host "BeeGo!: http://127.0.0.1:$sitePort/"
    Write-Host 'Готовность расчёта: /api/runtime/readiness; первый запуск устанавливает ресурсы.'
}
finally {
    Pop-Location
}
