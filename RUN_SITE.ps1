$ErrorActionPreference = 'Stop'

$handoffRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$siteRoot = Join-Path $handoffRoot 'site'
$nodeModules = Join-Path $siteRoot 'node_modules'

if (-not (Test-Path -LiteralPath $nodeModules)) {
    Push-Location $siteRoot
    try {
        npm install
    }
    finally {
        Pop-Location
    }
}

Push-Location $siteRoot
try {
    npm run preview -- --host 127.0.0.1 --port 4174
}
finally {
    Pop-Location
}

