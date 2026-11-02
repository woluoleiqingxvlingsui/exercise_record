# 前端集成冒烟测试 —— 用无头浏览器真实跑一遍各视图与训练主流程
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tests\browser\run-views.ps1
#   ... -Port 8905        # 指定端口（默认自动找空闲端口）
#   ... -Headed           # 显示浏览器窗口，方便肉眼看
#
# 为什么需要它：`node --check` 只看单文件语法，node 里的纯逻辑测试又碰不到 DOM。
# 像"导入了不存在的导出""点遮罩导致 await 永久挂起""间歇档位里没有计划值"
# 这类问题只有把页面真跑起来才会暴露。
#
# 注意：Chromium 的进程间通信用命名管道，在受限沙箱里会启动失败
# （platform_channel.cc: 拒绝访问）。若在沙箱内运行需要放宽文件/进程权限。

param([int]$Port = 0, [switch]$Headed)

$ErrorActionPreference = 'Stop'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$TestsDir = Split-Path -Parent $Here
$RepoRoot = Split-Path -Parent $TestsDir
$Page = Join-Path $Here 'views.html'

function Write-Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Write-Warn2($m) { Write-Host "  ! $m" -ForegroundColor Yellow }

if (-not (Test-Path $Page)) { throw "找不到测试页：$Page" }

# ---------------------------------------------------------------- 找浏览器
Write-Step 'Locate browser'
$browser = $null
foreach ($c in @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )) {
  if (Test-Path $c) { $browser = $c; break }
}
if (-not $browser) { throw '找不到 Edge/Chrome，无法跑无头测试' }
Write-Host "  $browser"

# ------------------------------------------------------------------ 找端口
function Get-FreePort {
  foreach ($p in 8902..8930) {
    try {
      $l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $p)
      $l.Start(); $l.Stop(); return $p
    } catch { }
  }
  throw '没有找到空闲端口'
}
if ($Port -le 0) { $Port = Get-FreePort }

# ---------------------------------------------------------------- 起静态服务
Write-Step "Serve repo root on 127.0.0.1:$Port"
$srv = $null
$outLog = Join-Path $env:TEMP "ex-views-$Port.out.log"
$errLog = Join-Path $env:TEMP "ex-views-$Port.err.log"

$py = (Get-Command python -ErrorAction SilentlyContinue)
if ($py) {
  $srv = Start-Process -FilePath $py.Source -ArgumentList '-m', 'http.server', $Port `
    -WorkingDirectory $RepoRoot -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog
} else {
  Write-Warn2 '没有 python，改用 node 起静态服务'
  $node = (Get-Command node -ErrorAction SilentlyContinue)
  if (-not $node) { throw 'python 和 node 都没有，无法起静态服务' }
  $js = @"
const http=require('http'),fs=require('fs'),path=require('path');
const root=process.argv[1];
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'};
http.createServer((req,res)=>{
  const p=path.join(root, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p,(e,d)=>{
    if(e){res.writeHead(404);res.end('nf');return;}
    res.writeHead(200,{'Content-Type':types[path.extname(p)]||'application/octet-stream'});
    res.end(d);
  });
}).listen(Number(process.argv[2]));
"@
  $srv = Start-Process -FilePath $node.Source -ArgumentList '-e', $js, $RepoRoot, $Port `
    -PassThru -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
}

# 等就绪（最多 15 秒）
$ready = $false
foreach ($i in 1..30) {
  Start-Sleep -Milliseconds 500
  try {
    $r = Invoke-WebRequest "http://127.0.0.1:$Port/tests/browser/views.html" -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) { $ready = $true; break }
  } catch { }
}
if (-not $ready) {
  if ($srv) { Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue }
  throw "静态服务没起来（$Port）"
}
Write-Host '  就绪'

# ------------------------------------------------------------- 跑无头浏览器
Write-Step 'Run headless browser'
$prof = Join-Path $env:TEMP "ex-views-prof-$Port"
Remove-Item $prof -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $prof | Out-Null

$browserArgs = @(
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-http-cache',
  "--user-data-dir=$prof", '--virtual-time-budget=25000', '--dump-dom',
  "http://127.0.0.1:$Port/tests/browser/views.html"
)
if ($Headed) { $browserArgs = $browserArgs | Where-Object { $_ -ne '--headless=new' } }

# 必须用 Start-Process + 重定向到文件来收输出。
# 实测：直接 `& $browser @browserArgs`（数组 splat）在本机拿不到任何 stdout
# —— 长度为 0、$LASTEXITCODE 甚至为空，看着像命令压根没执行；
# 而字面量参数、或重定向到文件，都正常。踩过的坑，别改回去。
$domFile = Join-Path $env:TEMP "ex-views-$Port.dom.html"
$browserErr = Join-Path $env:TEMP "ex-views-$Port.browser.log"
Remove-Item $domFile, $browserErr -Force -ErrorAction SilentlyContinue

$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$proc = Start-Process -FilePath $browser -ArgumentList $browserArgs -PassThru -Wait -NoNewWindow `
  -RedirectStandardOutput $domFile -RedirectStandardError $browserErr
$ErrorActionPreference = $prev

$log = if (Test-Path $domFile) { [IO.File]::ReadAllText($domFile) } else { '' }
$browserLog = if (Test-Path $browserErr) { [IO.File]::ReadAllText($browserErr) } else { '' }

if ($srv) { Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue }

# ------------------------------------------------------------------ 出结果
Write-Step 'Result'
$m = [regex]::Match($log, '(?s)<pre id="out">(.*?)</pre>')
if (-not $m.Success) {
  Write-Host '没取到测试输出（页面可能压根没跑起来）。报错线索：' -ForegroundColor Red
  (($log + "`n" + $browserLog) -split "`n") | Select-String -Pattern 'CONSOLE|Uncaught|Error|FAILED' |
    Select-Object -First 10 | ForEach-Object { $_.Line.Trim() }
  exit 1
}

$json = $m.Groups[1].Value -replace '&quot;', '"' -replace '&amp;', '&' -replace '&lt;', '<' -replace '&gt;', '>'
$r = $json | ConvertFrom-Json

$r.results | ForEach-Object {
  if ($_ -like 'FAIL*') { Write-Host $_ -ForegroundColor Red } else { Write-Host $_ }
}
if ($r.errors.Count) {
  Write-Host "`n页面级错误：" -ForegroundColor Yellow
  $r.errors | ForEach-Object { Write-Host "  $_" }
}

Write-Host "`n共 $($r.total) 项，失败 $($r.failed) 项" -ForegroundColor $(if ($r.failed -or $r.errors.Count) { 'Red' } else { 'Green' })
if ($r.failed -or $r.errors.Count) { exit 1 }
Write-Host '前端集成冒烟测试全部通过'
exit 0
