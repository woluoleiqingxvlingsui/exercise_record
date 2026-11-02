# 训练记录 —— 把打好的 APK 装到已连线的安卓手机（adb install -r，保留已有训练记录）
# 用法：
#   powershell -ExecutionPolicy Bypass -File app\install-to-phone.ps1            # 自动挑 _out\apk 里最新的包
#   powershell -ExecutionPolicy Bypass -File app\install-to-phone.ps1 -Apk <路径> # 指定包
#   powershell -ExecutionPolicy Bypass -File app\install-to-phone.ps1 -Serial <设备号>  # 多台设备时指定
# 前置：手机「设置 → 关于手机 → 连点版本号 7 次」开开发者选项 → 打开 USB 调试，首次连线在手机上点「允许」。

param(
  [string]$Apk,
  [string]$Serial,
  [ValidateSet('debug', 'release')][string]$Flavor = 'debug'
)

$ErrorActionPreference = 'Stop'
$AppRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $AppRoot

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Warn2($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }

# ---------------------------------------------------------------- locate adb
Write-Step 'Locate adb'
$adb = $null
$c = Get-Command adb -ErrorAction SilentlyContinue
if ($c) { $adb = $c.Source }
else {
  $bundled = Join-Path $env:USERPROFILE 'tools\android-sdk\platform-tools\adb.exe'
  if (Test-Path $bundled) { $adb = $bundled }
}
if (-not $adb) {
  throw "找不到 adb。先跑一次 build-apk.ps1（会装 platform-tools），或把 adb 目录加进 PATH。"
}
Write-Host "  $adb"

# ---------------------------------------------------------------- device
Write-Step 'Check device'
$raw = & $adb devices
$lines = @($raw | Select-Object -Skip 1 | Where-Object { $_.Trim() })
$devices = @()
foreach ($l in $lines) {
  $parts = $l -split '\s+'
  if ($parts.Count -ge 2) { $devices += [PSCustomObject]@{ Serial = $parts[0]; State = $parts[1] } }
}
if (-not $devices.Count) {
  Write-Host ($raw -join "`n")
  throw '没有检测到设备。用数据线连手机并确认「USB 调试」已打开、手机上点了「允许」。'
}
foreach ($d in $devices) { Write-Host "  $($d.Serial)  [$($d.State)]" }

if ($Serial) {
  if (-not ($devices | Where-Object { $_.Serial -eq $Serial })) { throw "指定设备 $Serial 不在列表里" }
}
else {
  $ready = @($devices | Where-Object { $_.State -eq 'device' })
  if ($ready.Count -eq 0) {
    $bad = ($devices | ForEach-Object { "$($_.Serial)=$($_.State)" }) -join ', '
    throw "设备状态不对（$bad）。unauthorized = 手机上还没点「允许」；offline = 重插数据线。"
  }
  if ($ready.Count -gt 1) { throw "连了多台设备，请用 -Serial <设备号> 指定其中一台" }
  $Serial = $ready[0].Serial
}

# ---------------------------------------------------------------- pick apk
Write-Step 'Pick APK'

# 选包规则（要确定，不能靠 mtime 猜）：
#   1. 优先 _out\apk —— 那是 build-apk.ps1 拷出来的、文件名带版本号的成品
#   2. 只选 -Flavor 指定的包型（默认 debug），再取版本号最高的包
#   3. 排除 *-unsigned*.apk 与 androidTest 下的包（都不是能装的成品）
# 原来是把两个目录的包混在一起按 mtime 排序取最新：会选中 debug 包、
# 未签名包，甚至 androidTest 的包，而且不告诉你装的是哪一种。

function Get-UsableApk([string]$dir) {
  if (-not (Test-Path -LiteralPath $dir)) { return @() }
  @(Get-ChildItem -LiteralPath $dir -Filter '*.apk' -Recurse -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -notlike '*-unsigned*' -and
      $_.FullName -notmatch '[\\/]androidTest[\\/]'
    })
}

function Get-ApkFlavor([System.IO.FileInfo]$f) {
  if ($f.Name -match '(?i)-(?<flavor>debug|release)\.apk$') { return $Matches['flavor'].ToLowerInvariant() }
  if ($f.Directory -and $f.Directory.Name -match '(?i)^(debug|release)$') { return $f.Directory.Name.ToLowerInvariant() }
  return ''
}

function Get-ApkVersion([System.IO.FileInfo]$f) {
  # build-apk.ps1 产出的命名：exercise-record-<版本>-<debug|release>.apk
  if ($f.Name -match '(?i)^exercise-record-(?<ver>\d+(?:\.\d+)*)-(?<flavor>debug|release)\.apk$') { return $Matches['ver'] }
  return ''
}

function ConvertTo-ApkVersionKey([string]$v) {
  if (-not $v) { return [version]'0.0' }
  $t = ($v -replace '[^0-9.]', '')
  if (-not $t) { return [version]'0.0' }
  try { return [version]$t } catch { return [version]'0.0' }
}

if ($Apk) {
  # 显式指定永远优先；路径不存在就报错，不许静默回退到自动挑包
  if (-not (Test-Path $Apk)) { throw "APK not found: $Apk" }
  $apkPath = (Resolve-Path $Apk).Path
  $chosen = Get-Item -LiteralPath $apkPath
  $chosenFlavor = Get-ApkFlavor $chosen
  $chosenVersion = Get-ApkVersion $chosen
  $chosenSource = '手动指定 (-Apk)'
} else {
  $outDir = Join-Path $RepoRoot '_out\apk'
  $cands = @(Get-UsableApk $outDir | Where-Object { (Get-ApkFlavor $_) -eq $Flavor })
  $chosenSource = '_out\apk'
  if (-not $cands.Count) {
    # _out\apk 里没有可用的（没打过包、或全被排除）才去看 gradle 原始产物
    $gradleOut = Join-Path $AppRoot 'android\app\build\outputs\apk'
    $cands = @(Get-UsableApk $gradleOut | Where-Object { (Get-ApkFlavor $_) -eq $Flavor })
    $chosenSource = 'android\app\build\outputs\apk'
  }
  if (-not $cands.Count) { throw "没有找到 $Flavor APK；请先构建此包型，或用 -Flavor release / -Apk 指定。不会自动切换签名。" }

  $scored = @($cands | ForEach-Object {
    $v = Get-ApkVersion $_
    $fl = Get-ApkFlavor $_
    [PSCustomObject]@{
      File = $_
      VKey = ConvertTo-ApkVersionKey $v
      FRank = if ($fl -eq 'release') { 2 } elseif ($fl -eq 'debug') { 1 } else { 0 }
    }
  })

  $best = $scored | Sort-Object -Property @(
    @{ Expression = { $_.VKey }; Descending = $true },
    @{ Expression = { $_.FRank }; Descending = $true },
    @{ Expression = { $_.File.LastWriteTimeUtc }; Descending = $true }
  ) | Select-Object -First 1

  $apkPath = $best.File.FullName
  $chosen = $best.File
  $chosenFlavor = Get-ApkFlavor $chosen
  $chosenVersion = Get-ApkVersion $chosen
}

Write-Host "  $apkPath  ($([math]::Round((Get-Item $apkPath).Length / 1MB, 2)) MB)"
Write-Host "  选中：$(if ($chosenFlavor) { $chosenFlavor } else { '未知口味' }) 包 · 版本 $(if ($chosenVersion) { $chosenVersion } else { '未知' }) · 来源 $chosenSource" -ForegroundColor Yellow

# ---------------------------------------------------------------- install
Write-Step 'Install'
# 必须把 adb 的输出接住：成败判断靠的是输出里的 Success / 失败码。
# 顺带 2>&1 收 stderr + 临时放开 EAP：adb 失败时写 stderr，
# 在 $ErrorActionPreference='Stop' 下会直接抛成看不懂的 NativeCommandError。
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$out = (@(& $adb -s $Serial install -r $apkPath 2>&1) | ForEach-Object { "$_" }) -join "`n"
$code = $LASTEXITCODE
$ErrorActionPreference = $prevEap

if ($code -eq 0 -and $out -match 'Success') {
  Write-Host "`n安装成功。手机上打开「训练记录」即可。" -ForegroundColor Green
  Write-Host '首次启动会请求通知权限（Android 13+），允许后锁屏/通知栏才有计时卡。'
  Write-Host '请按 docs\ACCEPTANCE.md 逐条验收。'
} else {
  Write-Host $out -ForegroundColor Red
  if ($out -match 'INSTALL_FAILED_UPDATE_INCOMPATIBLE') {
    Write-Warn2 '签名不一致：debug 与 release 包不能互相覆盖。'
    Write-Warn2 '请使用与手机现有应用相同的包型及原签名密钥；如确定更换签名，先导出备份，再手动卸载重装（卸载会丢记录）。'
  }
  throw 'adb install 失败'
}
