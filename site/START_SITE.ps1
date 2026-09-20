[CmdletBinding()]
param(
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectRoot

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  throw 'Node.js не найден. Установите Node.js 20 LTS или новее: https://nodejs.org/'
}

$nodeVersion = (& node --version).TrimStart('v')
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 20) {
  throw "Нужен Node.js 20 или новее. Сейчас установлен Node.js $nodeVersion."
}

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) {
  throw 'npm.cmd не найден. Переустановите Node.js вместе с npm.'
}

if (-not $SkipInstall -and -not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) {
  Write-Host 'Первый запуск: устанавливаю зафиксированные зависимости...' -ForegroundColor Yellow
  & npm.cmd ci
  if ($LASTEXITCODE -ne 0) {
    throw "npm ci завершился с кодом $LASTEXITCODE."
  }
}

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) {
  throw 'Папка node_modules отсутствует. Запустите START_SITE.ps1 без параметра -SkipInstall.'
}

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot '.dev.vars'))) {
  Write-Warning 'Geoapify не настроен: новые адреса не будут геокодироваться. Остальной сайт и готовые планы работают без ключа.'
}

$escapedProjectRoot = $projectRoot.Replace("'", "''")

$apiCommand = "`$Host.UI.RawUI.WindowTitle = 'BeeGo API'; Set-Location -LiteralPath '$escapedProjectRoot'; npm.cmd run dev:api"
$uiCommand = "`$Host.UI.RawUI.WindowTitle = 'BeeGo UI'; Set-Location -LiteralPath '$escapedProjectRoot'; npm.cmd run dev -- --host 127.0.0.1 --port 4174"

Start-Process -FilePath 'powershell.exe' -ArgumentList @(
  '-NoLogo',
  '-NoExit',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
  $apiCommand
) -WindowStyle Normal

Start-Process -FilePath 'powershell.exe' -ArgumentList @(
  '-NoLogo',
  '-NoExit',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
  $uiCommand
) -WindowStyle Normal

Write-Host 'BeeGo запускается: http://127.0.0.1:4174/' -ForegroundColor Green
Start-Sleep -Seconds 3
Start-Process -FilePath 'http://127.0.0.1:4174/'
