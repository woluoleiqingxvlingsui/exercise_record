# 前端集成冒烟测试：Node.js 20+ 与 Edge/Chrome；无需 Python 或 npm install。
# powershell -ExecutionPolicy Bypass -File tests\browser\run-views.ps1
# -Port 8905 指定端口；-Headed 仅供肉眼调试，关闭窗口后结束，不判定通过。
param([int]$Port = 0, [switch]$Headed)
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent (Split-Path -Parent $Here)
. (Join-Path $RepoRoot 'scripts\windows-common.ps1')
$browser = $null
foreach ($candidate in @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)) {
  if (Test-Path -LiteralPath $candidate) { $browser = $candidate; break }
}
if (-not $browser) { throw '找不到 Edge/Chrome，请先安装浏览器。' }
if ($Port -eq 0) { $Port = Get-LocalPort 8902 8930 }
if ($Port -lt 1 -or $Port -gt 65535) { throw 'Port 必须在 1..65535 之间' }
$url = "http://127.0.0.1:$Port/tests/browser/views.html"
$work = Join-Path $env:TEMP ("ex-views-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$logPrefix = Join-Path $work 'server'
$profile = Join-Path $work 'browser profile'
$domFile = Join-Path $work 'dom.html'
$browserErr = Join-Path $work 'browser.log'
$server = $null
$process = $null
try {
  $server = Start-LocalServer $RepoRoot $RepoRoot $Port $logPrefix
  Wait-LocalServer $server $url $logPrefix
  $failedPages = @()
  foreach ($pageName in @('views', 'player-safety', 'shell-safety')) {
  $url = "http://127.0.0.1:$Port/tests/browser/$pageName.html"
  Write-Host "`n==> $pageName" -ForegroundColor Cyan
  $domFile = Join-Path $work "$pageName.dom.html"
  $browserErr = Join-Path $work "$pageName.browser.log"
  $browserArguments = @('--no-first-run', '--disable-http-cache', "--user-data-dir=$profile")
  if ($Headed) {
    Write-Host '可视调试：在页面底部查看 JSON 结果；关闭此独立浏览器后脚本结束，不作为自动验收通过。'
    $browserArguments += @('--new-window', $url)
  } else {
    $browserArguments += @('--headless=new', '--disable-gpu', '--virtual-time-budget=25000', '--dump-dom', $url)
  }
  $quoted = $browserArguments | ForEach-Object { ConvertTo-WindowsArgument $_ }
  $process = Start-Process -FilePath $browser -ArgumentList ($quoted -join ' ') -PassThru -NoNewWindow `
    -RedirectStandardOutput $domFile -RedirectStandardError $browserErr
  if ($Headed) {
    while (-not $process.WaitForExit(500)) { }
    continue
  }
  if (-not $process.WaitForExit(60000)) { throw "浏览器测试超过 60 秒；日志：$work" }
  if ($process.ExitCode -ne 0) { throw "浏览器退出码 $($process.ExitCode)；日志：$work" }
  $log = [IO.File]::ReadAllText($domFile)
  $match = [regex]::Match($log, '(?s)<pre id="out">(.*?)</pre>')
  if (-not $match.Success) { throw "没取到测试输出；日志：$work" }
  $json = [Net.WebUtility]::HtmlDecode($match.Groups[1].Value)
  $result = $json | ConvertFrom-Json
  if ($null -eq $result.total -or $result.total -le 0 -or $null -eq $result.failed) {
    throw "测试结果未完成或格式无效；日志：$work"
  }
  $result.results | ForEach-Object { Write-Host $_ }
  $result.errors | ForEach-Object { Write-Host $_ -ForegroundColor Red }
  Write-Host "共 $($result.total) 项，失败 $($result.failed) 项；日志：$work"
  if ($result.failed -or $result.errors.Count) { $failedPages += $pageName }
  }
  if ($Headed) { return }
  if ($failedPages.Count) { throw "前端集成测试失败：$($failedPages -join ', ')" }
  Write-Host '三页前端集成冒烟测试全部通过' -ForegroundColor Green
} finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $profile -Recurse -Force -ErrorAction SilentlyContinue
}
