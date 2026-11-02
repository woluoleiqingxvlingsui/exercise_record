# 训练记录 —— Windows 一键装工具并打 Android 包（默认 debug）
# 用法（仓库根目录或 app/ 下都行）：
#   powershell -ExecutionPolicy Bypass -File app\build-apk.ps1            # debug 包
#   powershell -ExecutionPolicy Bypass -File app\build-apk.ps1 -Release   # release 包（首次自动生成签名）
#   powershell -ExecutionPolicy Bypass -File app\build-apk.ps1 -Install   # 打完直接装到已连线的手机
# 幂等：已有 Node/JDK/SDK/Gradle 会复用（工具统一装在 %USERPROFILE%\tools\下），缺什么补什么。
# 产物：会复制一份到仓库根 _out\apk\ 下（带版本号的文件名），原始产物仍在
#   app\android\app\build\outputs\apk\debug\app-debug.apk 或 ...\release\app-release.apk
# 国内网络默认走镜像（Node 淘宝 / Gradle 腾讯 / Maven 阿里）。
# 装完手机后请按 docs\ACCEPTANCE.md 逐条验收。

param([switch]$Release, [switch]$Install, [switch]$ForceDeps)

$ErrorActionPreference = 'Stop'
$AppRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $AppRoot
$AndroidDir = Join-Path $AppRoot 'android'
$ToolsRoot = Join-Path $env:USERPROFILE 'tools'
$JdkDir = Join-Path $ToolsRoot 'jdk-21'
$SdkDir = Join-Path $ToolsRoot 'android-sdk'
$GradleDir = Join-Path $ToolsRoot 'gradle-8.11.1'
$InitGradle = Join-Path $RepoRoot '_out\gradle\mirrors.init.gradle'
$OutDir = Join-Path $RepoRoot '_out\apk'

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Warn2($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Get-File($url, $dest) {
  Write-Host "  download $url"
  # --fail 必须加：没有它，HTTP 4xx/5xx 时 curl 照样退出 0，
  # 会把服务器返回的 HTML 错误页当 zip 存下来（后面解压时才炸，且报错难懂）
  curl.exe -L --fail --retry 3 --connect-timeout 30 -o $dest $url
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $dest)) { throw "download failed: $url" }
}
function Get-FileOrNull($url, $dest, $minBytes) {
  # 镜像可能返回 HTML 错误页，按体积卡一道
  try {
    Get-File $url $dest
    if ((Get-Item $dest).Length -gt $minBytes) { return $true }
    Write-Warn2 "too small, treat as fail: $url"
  } catch { Write-Warn2 "mirror fail: $url" }
  return $false
}

# ---------------------------------------------------------------- Node.js
# 在首次下载前创建目录（全新机器没有 tools）。
New-Item -ItemType Directory -Force -Path $ToolsRoot | Out-Null
# 以前这一步完全靠系统自带 Node，新机器上最容易卡住；这里缺就自动装。
Write-Step 'Prepare Node.js (Capacitor CLI needs >= v20)'
$NodeVer = 'v22.20.0'
$NodeDir = Join-Path $ToolsRoot "node\$NodeVer"
$nodeOK = $false
$sysNode = Get-Command node -ErrorAction SilentlyContinue
if ($sysNode) {
  $v = (& node -v) 2>$null
  if ($v -match '^v(\d+)\.' -and [int]$Matches[1] -ge 20) {
    Write-Host "  reuse system node $v"; $nodeOK = $true
  } else {
    Write-Warn2 "system node ($v) too old, need >= v20"
  }
}
if (-not $nodeOK) {
  if (Test-Path (Join-Path $NodeDir 'node.exe')) {
    Write-Host "  reuse $NodeDir"
  } else {
    $zip = Join-Path $ToolsRoot "node-$NodeVer.zip"
    $got = $false
    foreach ($u in @(
        "https://npmmirror.com/mirrors/node/$NodeVer/node-$NodeVer-win-x64.zip",
        "https://nodejs.org/dist/$NodeVer/node-$NodeVer-win-x64.zip")) {
      if (Get-FileOrNull $u $zip 20MB) { $got = $true; break }
    }
    if (-not $got) { throw 'all Node mirrors failed' }
    $tmp = Join-Path $ToolsRoot 'node-extract'
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $src = Get-ChildItem $tmp -Directory | Select-Object -First 1
    if (-not $src) { throw "unexpected node zip layout: $zip" }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $NodeDir) | Out-Null
    if (Test-Path $NodeDir) { Remove-Item $NodeDir -Recurse -Force }
    Move-Item $src.FullName $NodeDir
    Remove-Item $tmp -Recurse -Force
    Remove-Item $zip -Force
    Write-Host "  installed -> $NodeDir"
  }
  $env:PATH = "$NodeDir;$env:PATH"
  $nodeOK = $true
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node still not found after install step' }

# ---------------------------------------------------------------- JDK 21
Write-Step 'Prepare JDK 21'
if (Test-Path (Join-Path $JdkDir 'bin\java.exe')) {
  Write-Host "  reuse $JdkDir"
} else {
  New-Item -ItemType Directory -Force -Path $ToolsRoot | Out-Null
  $zip = Join-Path $ToolsRoot 'temurin21.zip'
  Get-File 'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse' $zip
  $tmp = Join-Path $ToolsRoot 'jdk-extract'
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $dir = Get-ChildItem $tmp -Directory | Where-Object { $_.Name -like 'jdk*' } | Select-Object -First 1
  if (Test-Path $JdkDir) { Remove-Item $JdkDir -Recurse -Force }
  Move-Item $dir.FullName $JdkDir
  Remove-Item $tmp -Recurse -Force
  Remove-Item $zip -Force
}
$env:JAVA_HOME = $JdkDir

# ---------------------------------------------------------------- Android SDK
Write-Step 'Prepare Android SDK (cmdline-tools + platform 35 + build-tools)'
$sdkm = Join-Path $SdkDir 'cmdline-tools\latest\bin\sdkmanager.bat'
if (-not (Test-Path $sdkm)) {
  New-Item -ItemType Directory -Force -Path $ToolsRoot | Out-Null
  $zip = Join-Path $ToolsRoot 'cmdline-tools.zip'
  Get-File 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip' $zip
  $tmp = Join-Path $SdkDir 'cmdline-tools-temp'
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  New-Item -ItemType Directory -Force -Path (Join-Path $SdkDir 'cmdline-tools') | Out-Null
  Move-Item (Join-Path $tmp 'cmdline-tools') (Join-Path $SdkDir 'cmdline-tools\latest')
  Remove-Item $tmp -Recurse -Force
  Remove-Item $zip -Force
}
$env:ANDROID_HOME = $SdkDir
# 许可协议必须接受成功：失败了就静默往下走，SDK 会装成半截，
# 后面 gradle 报的错完全指不到真正的原因。这里显式检查退出码。
1..30 | ForEach-Object { 'y' } | & $sdkm --sdk_root=$SdkDir --licenses | Out-Null
if ($LASTEXITCODE -ne 0) { throw "sdkmanager --licenses failed (exit $LASTEXITCODE)：许可协议没接受成功，后面的 SDK 安装会连带失败" }
& $sdkm --sdk_root=$SdkDir 'platform-tools' 'platforms;android-35' 'build-tools;35.0.0' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'sdkmanager install failed' }

# ---------------------------------------------------------------- Gradle
Write-Step 'Prepare Gradle 8.11.1'
$gradleBin = Join-Path $GradleDir 'bin\gradle.bat'
if (Test-Path $gradleBin) {
  Write-Host "  reuse $GradleDir"
} else {
  $zip = Join-Path $ToolsRoot 'gradle-8.11.1-all.zip'
  $mirrors = @(
    'https://mirrors.cloud.tencent.com/gradle/gradle-8.11.1-all.zip',
    'https://mirrors.huaweicloud.com/gradle/gradle-8.11.1-all.zip',
    'https://services.gradle.org/distributions/gradle-8.11.1-all.zip'
  )
  $got = $false
  foreach ($u in $mirrors) {
    if (Get-FileOrNull $u $zip 10MB) { $got = $true; break }
  }
  if (-not $got) { throw 'all Gradle mirrors failed' }
  Expand-Archive -Path $zip -DestinationPath $ToolsRoot -Force
  Remove-Item $zip -Force
}

# ---------------------------------------------------------------- mirrors + local.properties
Write-Step 'Write project Gradle mirrors and local.properties'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $InitGradle) | Out-Null
$init = @"
// CN mirrors for Gradle deps
allprojects {
  buildscript {
    repositories {
      maven { url 'https://maven.aliyun.com/repository/google' }
      maven { url 'https://maven.aliyun.com/repository/public' }
      maven { url 'https://maven.aliyun.com/repository/gradle-plugin' }
    }
  }
  repositories {
    maven { url 'https://maven.aliyun.com/repository/google' }
    maven { url 'https://maven.aliyun.com/repository/public' }
    maven { url 'https://maven.aliyun.com/repository/gradle-plugin' }
  }
}
"@
# 只通过本次 Gradle 调用加载；不读取、备份或改写用户的全局 init.gradle。
[IO.File]::WriteAllText($InitGradle, $init, [Text.UTF8Encoding]::new($false))
$sdkProp = $SdkDir.Replace('\', '\\')
[IO.File]::WriteAllText((Join-Path $AndroidDir 'local.properties'), "sdk.dir=$sdkProp`n", [Text.UTF8Encoding]::new($false))

# ---------------------------------------------------------------- release keystore
if ($Release) {
  Write-Step 'Prepare release keystore'
  $ksFile = Join-Path $AndroidDir 'exercise-release.keystore'
  $ksProps = Join-Path $AndroidDir 'keystore.properties'
  $haveKs = Test-Path $ksFile
  $haveProps = Test-Path $ksProps
  if (-not $haveKs -and $haveProps) {
    # 口令文件在、密钥文件没了 —— 典型的「用户弄丢了 .keystore」现场。
    # 绝不能在这里生成新密钥并把 keystore.properties 覆盖掉：
    # 旧口令一旦被改写，手机上那个用旧密钥签过的 App 就再也盖不上了
    # （只能先卸载再装，训练记录会一起丢）。所以直接停下来，把选择权交回给人。
    throw ("keystore.properties 在、但密钥文件 $ksFile 不见了 —— 旧签名口令没法再用了，`n" +
      "覆盖 keystore.properties 生成新密钥会让手机上已装的旧 App 再也盖不上（须先卸载，训练记录会丢）。`n" +
      "解法一（推荐）：把原来的 $ksFile 从备份里恢复回来，与现有 keystore.properties 配对，然后重跑本脚本。`n" +
      "解法二（确定换新签名）：手动删掉 $ksProps 再重跑，本脚本会生成一套全新的密钥；`n" +
      "        但之后必须先卸载手机上的旧 App 再装新的。")
  }
  if (-not $haveKs) {
    # 首次：随机口令生成签名密钥；只留本机，丢了就无法覆盖安装升级
    $keytool = Join-Path $JdkDir 'bin\keytool.exe'
    $ksPwd = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
    & $keytool -genkeypair -v -keystore $ksFile -alias exercise -keyalg RSA -keysize 2048 -validity 10950 `
      -storepass $ksPwd -keypass $ksPwd -dname 'CN=ExerciseRecord, OU=Home, O=Exercise, L=Local, C=CN'
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $ksFile)) { throw 'keytool genkeypair failed' }
    $props = @(
      'storeFile=exercise-release.keystore',
      "storePassword=$ksPwd",
      'keyAlias=exercise',
      "keyPassword=$ksPwd"
    ) -join "`n"
    [IO.File]::WriteAllText($ksProps, "$props`n", [Text.UTF8Encoding]::new($false))
    Write-Host '  keystore 已生成；口令在 app\android\keystore.properties（请自行备份，两个文件都别提交）'
  } elseif (-not $haveProps) {
    throw "找到 $ksFile 但缺 keystore.properties（含口令），无法签名；请恢复该文件或删掉 $ksFile 重新生成"
  } else {
    Write-Host "  reuse $ksFile"
  }

  # build.gradle 只在 keystore.properties 存在时才声明 signingConfig，
  # 少一个字段就会静默退回未签名包 —— 这里先替 Gradle 查一遍，早失败好过装到手机上才发现
  $kv = @{}
  Get-Content $ksProps -Encoding UTF8 | ForEach-Object {
    if ($_ -match '^\s*([^=]+)=(.*)$') { $kv[$Matches[1].Trim()] = $Matches[2].Trim() }
  }
  foreach ($need in @('storeFile', 'storePassword', 'keyAlias', 'keyPassword')) {
    if (-not $kv.ContainsKey($need) -or -not $kv[$need]) { throw "keystore.properties 缺少字段：$need" }
  }
  if (-not (Test-Path (Join-Path $AndroidDir $kv['storeFile']))) {
    throw "keystore.properties 指向的密钥文件不存在：$($kv['storeFile'])"
  }
  Write-Host '  keystore.properties 校验通过'
}

# ---------------------------------------------------------------- npm deps
# 以前只看 node_modules 在不在，package.json 改了也不会重装；现在按 lockfile 指纹判断。
Write-Step 'Install app dependencies'
$pkgJson = Join-Path $AppRoot 'package.json'
$pkgLock = Join-Path $AppRoot 'package-lock.json'
$stamp = Join-Path $AppRoot 'node_modules\.deps-stamp'
if (-not (Test-Path $pkgJson) -or -not (Test-Path $pkgLock)) {
  throw '缺少 app/package.json 或 package-lock.json；请恢复入库的锁文件，不自动生成新锁文件。'
}
$hash = (Get-FileHash $pkgJson -Algorithm SHA256).Hash + ':' + (Get-FileHash $pkgLock -Algorithm SHA256).Hash
$previousHash = if (Test-Path $stamp) { [IO.File]::ReadAllText($stamp).Trim() } else { '' }
$depsOk = $true
foreach ($dependency in @('@capacitor\cli\bin\capacitor', '@capacitor\android\capacitor\build.gradle', '@capacitor\core\package.json', '.bin\cap.cmd')) {
  if (-not (Test-Path (Join-Path $AppRoot "node_modules\$dependency"))) { $depsOk = $false }
}
# npm ls 同时检查传递依赖、版本与缺失文件，不能只看 CLI 的一个 package.json。
if ($depsOk -and $previousHash -eq $hash -and -not $ForceDeps) {
  Push-Location $AppRoot
  try { npm ls --all --offline --no-audit --no-fund *> $null; $depsOk = ($LASTEXITCODE -eq 0) }
  finally { Pop-Location }
}
$needDeps = $ForceDeps -or (-not $depsOk) -or ($previousHash -ne $hash)
if ($needDeps) {
  Remove-Item -LiteralPath $stamp -Force -ErrorAction SilentlyContinue
  Push-Location $AppRoot
  try {
    npm ci --include=dev --prefer-offline --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm ci 失败；请检查网络、npm 源与锁文件一致性。不会回退 npm install 或改写锁文件。' }
    npm ls --all --offline --no-audit --no-fund *> $null
    if ($LASTEXITCODE -ne 0) { throw '安装后的依赖树不完整，未写入依赖 stamp。' }
  } finally { Pop-Location }
  [IO.File]::WriteAllText($stamp, "$hash`n", [Text.UTF8Encoding]::new($false))
} else {
  Write-Host '  package/lock 指纹及依赖树一致，复用 node_modules'
}

# ---------------------------------------------------------------- build
$gradleTask = if ($Release) { 'assembleRelease' } else { 'assembleDebug' }
Write-Step "Capacitor sync + $gradleTask"
Push-Location $AppRoot
try {
  & (Join-Path $AppRoot 'node_modules\.bin\cap.cmd') sync android
  if ($LASTEXITCODE -ne 0) { throw 'cap sync failed' }
} finally { Pop-Location }

Push-Location $AndroidDir
try {
  & $gradleBin $gradleTask --no-daemon --init-script $InitGradle
  if ($LASTEXITCODE -ne 0) { throw "$gradleTask failed ($LASTEXITCODE)" }
} finally { Pop-Location }

# ---------------------------------------------------------------- collect output
$apkDir = if ($Release) {
  Join-Path $AndroidDir 'app\build\outputs\apk\release'
} else {
  Join-Path $AndroidDir 'app\build\outputs\apk\debug'
}
$built = @(Get-ChildItem $apkDir -Filter '*.apk' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
if (-not $built.Count) { throw "APK not found in $apkDir" }
$srcApk = $built[0]
if ($Release -and $srcApk.Name -like '*-unsigned*') {
  throw "Gradle 只产出了未签名包 $($srcApk.Name)：签名配置没生效，请检查 app\android\keystore.properties"
}

$appVer = '1.0.0'
# 必须显式 UTF-8：package.json 无 BOM，PS 5.1 的 Get-Content 会按 GBK 读，
# 中文 description 被读坏后整个 JSON 解析失败
if (Test-Path $pkgJson) { $appVer = (Get-Content $pkgJson -Raw -Encoding UTF8 | ConvertFrom-Json).version }
$flavor = if ($Release) { 'release' } else { 'debug' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$outApk = Join-Path $OutDir "exercise-record-$appVer-$flavor.apk"
Copy-Item $srcApk.FullName $outApk -Force

Write-Step 'Done'
Write-Host "APK    : $outApk" -ForegroundColor Green
Write-Host "原始产物: $($srcApk.FullName)"
Write-Host "大小   : $([math]::Round((Get-Item $outApk).Length / 1MB, 2)) MB"

if ($Install) {
  & (Join-Path $AppRoot 'install-to-phone.ps1') -Apk $outApk
} else {
  Write-Host "`n装到手机：把上面这个 APK 传过去点击安装（首次需允许「未知来源」），"
  Write-Host "或手机开了 USB 调试后执行： powershell -ExecutionPolicy Bypass -File app\install-to-phone.ps1"
  Write-Host "或打包时直接加 -Install 一条龙。"
}
Write-Host "`n装完请按 docs\ACCEPTANCE.md 逐条验收（build-apk.ps1 末尾引用了这份清单）。"
