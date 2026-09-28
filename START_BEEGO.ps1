$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$site = Join-Path $root 'site'
$node = Join-Path $root 'offline-assets/node/node.exe'
$python = Join-Path $root '.venv/Scripts/python.exe'
$wheels = Join-Path $root 'offline-assets/python-wheels'
$image = 'ghcr.io/valhalla/valhalla-scripted:latest'
$expectedImageId = 'sha256:bc7c22f054c26effa5222a55a9d7a840369f254d314989f9040505342dc7ab84'
$container = 'beego-handoff-valhalla'

function Test-Port([int]$Port) {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $result = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $result.AsyncWaitHandle.WaitOne(1500)) { return $false }
        $client.EndConnect($result)
        return $true
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Test-Valhalla {
    try {
        $status = Invoke-RestMethod -Uri 'http://127.0.0.1:8002/status' -TimeoutSec 3
        return $null -ne $status
    } catch {
        return $false
    }
}

if (-not (Test-Path -LiteralPath $node)) { throw "Не найден встроенный Node.js: $node" }
if (-not (Test-Path -LiteralPath (Join-Path $site 'node_modules/vite/bin/vite.js'))) {
    throw 'Не найдены зависимости сайта. Архив распакован не полностью.'
}
if (-not (Test-Path -LiteralPath $python)) {
    $systemPython = Get-Command python -ErrorAction SilentlyContinue
    if ($systemPython) {
        & python -c 'import sys; assert sys.version_info[:2] == (3, 13) and sys.maxsize > 2**32' 2>$null
    }
    if ($systemPython -and $LASTEXITCODE -eq 0) {
        & python -m venv (Join-Path $root '.venv')
    } else {
        $launcher = Get-Command py -ErrorAction SilentlyContinue
        if (-not $launcher) { throw 'Нужен Python 3.13 x64. Установите его и повторите запуск.' }
        & py -3.13 -c 'import sys; assert sys.version_info[:2] == (3, 13) and sys.maxsize > 2**32' 2>$null
        if ($LASTEXITCODE -ne 0) { throw 'Нужен Python 3.13 x64. Установите его и повторите запуск.' }
        & py -3.13 -m venv (Join-Path $root '.venv')
    }
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось создать среду Python 3.13.' }
}
$importCheck = @'
import sys
try:
    import aiohttp, ortools, pandas, catboost
    assert sys.version_info[:2] == (3, 13) and sys.maxsize > 2**32
except Exception:
    sys.exit(1)
'@
& $python -c $importCheck
if ($LASTEXITCODE -ne 0) {
    & $python -m pip install --no-index --find-links $wheels -r (Join-Path $root 'algorithm/requirements-full.txt') -r (Join-Path $root 'site/requirements-ml.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось установить Python-зависимости из архива.' }
}
& $python -c 'import sys, aiohttp, ortools, pandas, catboost; assert sys.version_info[:2] == (3, 13) and sys.maxsize > 2**32'
if ($LASTEXITCODE -ne 0) { throw 'Нужен Python 3.13 x64 с зависимостями из wheelhouse.' }

$env:BEEGO_PYTHON = $python
$env:BEEGO_RASP_CREDENTIALS = Join-Path $root '.env.routing.local'
$env:PYTHONPATH = Join-Path $root 'algorithm/src'
$env:PATH = "$(Join-Path $root '.venv/Scripts');$env:PATH"
$env:PYTHONUTF8 = '1'

if (-not (Test-Valhalla)) {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'Для новых точных маршрутов нужен запущенный Docker Desktop.'
    }
    & docker info *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop установлен, но движок не запущен.' }
    $installedImageId = & docker image inspect $image --format '{{.Id}}' 2>$null
    if ($LASTEXITCODE -ne 0 -or $installedImageId -ne $expectedImageId) {
        & docker load -i (Join-Path $root 'offline-assets/docker/valhalla-scripted-3.8.3.tar')
        if ($LASTEXITCODE -ne 0) { throw 'Не удалось загрузить образ Valhalla из архива.' }
    }
    & docker container inspect $container *> $null
    if ($LASTEXITCODE -eq 0) {
        & docker start $container | Out-Null
    } else {
        $volume = "$(Join-Path $root 'valhalla-data'):/custom_files"
        & docker run -d --name $container -p '8002:8002' -v $volume `
            -e 'build_transit=False' -e 'build_elevation=False' `
            -e 'server_threads=4' -e 'use_tiles_ignore_pbf=True' `
            -e 'build_tar=True' -e 'serve_tiles=True' `
            -e 'update_existing_config=True' -e 'force_rebuild=False' `
            -e 'build_admins=True' -e 'build_time_zones=True' `
            -e 'use_default_speeds_config=True' $image build_tiles | Out-Null
    }
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось запустить контейнер Valhalla.' }
    for ($attempt = 0; $attempt -lt 60 -and -not (Test-Valhalla); $attempt++) {
        Start-Sleep -Seconds 2
    }
    if (-not (Test-Valhalla)) { throw 'Valhalla не ответила на /status за две минуты. Проверьте docker logs beego-handoff-valhalla.' }
}

$runtime = Join-Path $root 'runtime'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$processes = @{}
if (-not (Test-Port 8787)) {
    $api = Start-Process -FilePath $node -ArgumentList 'scripts/dev-api.mjs' `
        -WorkingDirectory $site -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $runtime 'portable-api.stdout.log') `
        -RedirectStandardError (Join-Path $runtime 'portable-api.stderr.log')
    $processes.api = $api.Id
}
if (-not (Test-Port 5173)) {
    $web = Start-Process -FilePath $node `
        -ArgumentList @('node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5173', '--strictPort') `
        -WorkingDirectory $site -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $runtime 'portable-web.stdout.log') `
        -RedirectStandardError (Join-Path $runtime 'portable-web.stderr.log')
    $processes.web = $web.Id
}
for ($attempt = 0; $attempt -lt 20 -and (-not (Test-Port 8787) -or -not (Test-Port 5173)); $attempt++) {
    Start-Sleep -Seconds 1
}
if (-not (Test-Port 8787) -or -not (Test-Port 5173)) {
    throw "Сайт/API не запустились. Смотрите журналы в $runtime."
}
$processes | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtime 'portable-processes.json') -Encoding utf8
Write-Host 'BeeGo запущен: http://127.0.0.1:5173/'
