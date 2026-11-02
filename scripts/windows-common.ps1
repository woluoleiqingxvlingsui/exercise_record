# Shared Windows process helpers for preview and browser tests.
function ConvertTo-WindowsArgument([string]$Value) {
  # CommandLineToArgvW quoting: double backslashes before quotes and closing quote.
  return '"' + ([regex]::Replace(([regex]::Replace($Value, '(\\*)"', '$1$1\"')), '(\\+)$', '$1$1')) + '"'
}

function Find-PreviewNode {
  $candidates = @()
  $command = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
  if ($command) { $candidates += $command.Source }
  $candidates += Join-Path $env:USERPROFILE 'tools\node\v22.20.0\node.exe'
  foreach ($candidate in $candidates) {
    if (-not (Test-Path -LiteralPath $candidate)) { continue }
    $version = & $candidate --version
    if ($LASTEXITCODE -eq 0 -and $version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 20) { return $candidate }
  }
  throw '需要 Node.js 20+：请安装并加入 PATH，或使用 build-apk.ps1 已下载的 tools\node\v22.20.0。无需 Python 或 npm install。'
}

function Get-LocalPort([int]$Start, [int]$End) {
  foreach ($candidate in $Start..$End) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $candidate)
    try { $listener.Start(); return $candidate } catch { } finally { $listener.Stop() }
  }
  throw "没有可用端口：$Start..$End"
}

function Start-LocalServer([string]$RepoRoot, [string]$Root, [int]$Port, [string]$LogPrefix) {
  $node = Find-PreviewNode
  $serverScript = Join-Path $RepoRoot 'scripts\serve.mjs'
  $arguments = @($serverScript, $Root, "$Port") | ForEach-Object { ConvertTo-WindowsArgument $_ }
  $process = Start-Process -FilePath $node -ArgumentList ($arguments -join ' ') -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput "$LogPrefix.out.log" -RedirectStandardError "$LogPrefix.err.log"
  return $process
}

function Wait-LocalServer($Process, [string]$Url, [string]$LogPrefix) {
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while ([DateTime]::UtcNow -lt $deadline) {
    $Process.Refresh()
    if ($Process.HasExited) { throw "HTTP 服务退出，请检查 $LogPrefix.err.log" }
    try {
      $response = Invoke-WebRequest $Url -UseBasicParsing -TimeoutSec 1
      if ($response.StatusCode -eq 200) { return }
    } catch { }
    Start-Sleep -Milliseconds 200
  }
  throw "HTTP 服务未就绪：$Url；请检查 $LogPrefix.err.log"
}
