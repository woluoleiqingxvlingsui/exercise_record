# 训练记录 —— 本地 HTTP 预览（Node.js 20+，不需要 Python 或 npm install）
# powershell -ExecutionPolicy Bypass -File app\preview-web.ps1
# 关闭窗口 / Ctrl+C 停止服务；-NoBrowser 可用于自动检查。
param([int]$Port = 0, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$AppRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $AppRoot
$WwwDir = Join-Path $RepoRoot 'www'
. (Join-Path $RepoRoot 'scripts\windows-common.ps1')
if ($Port -eq 0) { $Port = Get-LocalPort 8848 8897 }
if ($Port -lt 1 -or $Port -gt 65535) { throw 'Port 必须在 1..65535 之间' }
$url = "http://127.0.0.1:$Port/"
$logPrefix = Join-Path $env:TEMP ("ex-preview-" + [guid]::NewGuid().ToString('N'))
$server = $null
try {
  $server = Start-LocalServer $RepoRoot $WwwDir $Port $logPrefix
  Wait-LocalServer $server $url $logPrefix
  Write-Host "`n训练记录网页预览：$url" -ForegroundColor Cyan
  Write-Host 'F12 → Ctrl+Shift+M 切手机视口；Ctrl+C 停止服务。'
  if (-not $NoBrowser) { Start-Process $url }
  while (-not $server.WaitForExit(500)) { }
  throw "HTTP 服务意外退出，请检查 $logPrefix.err.log"
} finally {
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
}
