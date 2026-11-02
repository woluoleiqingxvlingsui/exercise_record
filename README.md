# 训练记录

离线使用的 Android 训练记录 App。预设训练计划、跟练与组间歇计时、训练后反馈、日程和统计均保存在本机。基于 Capacitor 7，界面使用原生 DOM 和 ES modules，无需前端编译；也可在电脑浏览器预览。

当前适合个人试用与开发。自动化测试覆盖主流程及数据恢复边界；手机上的通知权限、后台震动、锁屏显示和厂商省电策略仍需按 [装机验收清单](docs/ACCEPTANCE.md) 实机检查。

## 功能

- **计划**：计划 → 阶段 → 动作 → 组；支持次数/重量、时长、距离/配速；统一组或逐组编辑。提供只读查看和独立编辑入口。
- **示例**：引体日、推日、日常有氧跑、1000m 间歇跑、长距离跑，共五份可编辑模板。训练类别可自由命名，长按删除可选类别不会删除已有计划。
- **训练**：完成本组后选择按计划推进或灵活调整。每个动作只有一个组间歇；动作最后一组后仍可休息，**整次训练最后一组后不再安排间歇**。连续有氧段不弹选择框。
- **临时调整**：改变间歇、加组、减组、跳过下一组、结束本动作，保留调整记录。
- **通知计时**：Android 通知栏显示系统绘制的计时卡，休息结束震动。默认隐藏锁屏中的训练详情，解锁后可查看。系统允许的情况下，询问超时由原生服务自动推进。
- **恢复训练**：重开 App 可继续、结束保存或丢弃未结束的训练；已有训练不会被新计划静默覆盖。
- **记录与反馈**：训练结束填写时长、RPE、体感、不适部位和备注；未使用播放器也能在日程中按计划补记或简单记录类别与时长。
- **日程与统计**：月日程支持手势展开/收起、安排计划和休息日；统计按周/月/年查看总时长、次数、类别分布。填写过的训练时长优先于 App 自动计时。
- **备份**：设置中的文本 JSON 导出/导入，支持默认合并或全量替换。

## 先准备什么

| 目标 | 前置条件 |
|---|---|
| 浏览器预览 | Node.js 20+，现代浏览器；不需要 Python，也不需要安装 npm 依赖 |
| 纯逻辑测试 | Node.js 20+ |
| Windows 浏览器集成测试 | Node.js 20+、Windows PowerShell 5.1+、Edge 或 Chrome |
| Windows Android 一键构建 | Windows x64、PowerShell 5.1+、curl.exe、足够磁盘空间及可访问下载站点的网络 |
| USB 安装 | 已构建 APK、数据线、手机打开 USB 调试并授权；脚本会查找已安装的 adb |

构建脚本会下载缺少的 Node.js、JDK 21、Android SDK 和 Gradle 8.11.1，放在 `%USERPROFILE%\tools\`。首次运行需要联网并自动接受 Android SDK 许可，请先阅读并同意相应许可后使用。

Node 和 Gradle 有镜像备用源，Maven 配置了国内镜像；**JDK、Android 工具/SDK、npm 包仍可能需要访问官方站点**。不是完整离线安装包。`app/node_modules` 不入库，全新 clone 后由 `npm ci` 根据锁文件安装。

自动下载的工具仅加入构建进程的环境，不修改系统 PATH。预览脚本可以复用脚本下载的 Node；在新终端直接运行 `node`/`npm` 则需要自己安装并加入 PATH。

## 下载与预览

克隆仓库或下载 GitHub 源码 ZIP 后，先进入包含本文件的项目根目录。路径中含空格也可以使用。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File app\preview-web.ps1
```

或双击 `preview-web.bat`。服务就绪后自动打开浏览器，Ctrl+C 停止。脚本只监听 `127.0.0.1`，仅提供 `www` 下的资源，不回退到无法可靠加载模块的 `file://`。

已安装 Node 的其他系统也可以：

```sh
npm run preview
```

默认地址为 <http://127.0.0.1:8848>。F12 → 切换手机视口可模拟小屏。浏览器没有原生通知栏服务，数据也与手机 App 分开；同一浏览器不同端口的存储不互通。

## 构建与安装 Android APK

在项目根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File app\build-apk.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File app\build-apk.ps1 -Install
powershell -NoProfile -ExecutionPolicy Bypass -File app\build-apk.ps1 -Release
```

默认构建 debug；`-Install` 安装刚构建的确切产物；`-Release` 首次会生成本机发布签名。依赖指纹和依赖树一致时复用安装，`-ForceDeps` 强制执行 `npm ci`。安装失败会停下，不回退 `npm install` 改写锁文件。

镜像初始化文件写到项目 `_out/gradle/`，仅通过本次 Gradle 调用的 `--init-script` 加载，**不覆盖 `~/.gradle/init.gradle`**。本机原有全局 Gradle 配置仍可能影响构建，可自行检查。脚本生成的路径配置和构建产物均被 Git 忽略。

产物同时保留在 Gradle 输出目录和：

```text
_out/apk/exercise-record-0.7.0-debug.apk
_out/apk/exercise-record-0.7.0-release.apk
```

可以传到手机手动安装，或用：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File app\install-to-phone.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File app\install-to-phone.ps1 -Flavor release
powershell -NoProfile -ExecutionPolicy Bypass -File app\install-to-phone.ps1 -Apk "完整 APK 路径"
```

无参数只选 debug；`-Flavor release` 只选 release，不自动跨包型切换。多台手机时使用 `-Serial <设备号>`。首次连接需要在手机上允许 USB 调试。应用 ID：`app.exercise.record`。

**debug 与 release 签名不同，不能互相覆盖安装。** 日常验收建议一直用 debug。确需更换签名时先导出备份，再手动卸载重装，卸载会清空记录；脚本不会自动卸载。

**发布签名必须自己备份**：`app/android/exercise-release.keystore` 与 `app/android/keystore.properties`，后者包含口令。它们不入库。丢失原签名后无法给已安装的同签名应用覆盖升级。

## 测试与验收

```powershell
node tests/run.js
powershell -NoProfile -ExecutionPolicy Bypass -File tests\browser\run-views.ps1
```

双击 `run-tests.bat` 运行纯逻辑测试。可选 `npm test` 和 Windows 上的 `npm run test:browser`。

- 纯逻辑覆盖模型、日期、存储、示例、模块导入、备份往返、容量不足、导入恢复日志、坏结构校验与存储不可用提示。
- 浏览器脚本依次运行 `views.html`、`player-safety.html`、`shell-safety.html`：主流程、最后一组与连续计时、原生状态模拟、播放器销毁、数据替换/清空、待恢复训练保护。
- 浏览器测试使用隔离的临时 profile；测试日志在输出的临时目录。`-Headed` 用于可视调试，需要手动关闭窗口，不作为自动测试通过。
- 若受限沙箱禁止浏览器子进程，需在允许的执行环境运行。纯逻辑入口采用同进程执行，不要求 Node 测试运行器创建子进程。

这些测试不能替代手机验收。安装后按 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) 检查通知、锁屏、震动、后台恢复和键盘适配。

## 数据与隐私

- App 的 localStorage 存在应用私有空间，键前缀为 `ex.`；训练记录按月分桶。进行中训练另存 `ex.ongoing`。
- Android 清单不声明 `INTERNET` 权限，关闭系统备份；没有账号、服务端、埋点和数据上报。构建工具下载联网与 App 运行离线是两个阶段。
- 通知详情默认是 private，锁屏使用不含动作/组数的通用提示。系统及用户通知设置可能改变显示行为。
- 卸载、系统清除应用数据、浏览器清除站点数据都会丢失记录。**请定期在设置中导出 JSON 并另存到安全位置。** 复制到云端备忘录或聊天软件会由相应服务保存内容。
- 推荐备份命名为 `exercise-record-backup-日期.json` 或放在 `private-backups/`，这些路径被忽略；其他自定义文件名仍应自行检查后再提交。
- 全量替换先校验结构并保存旧数据恢复日志，需要额外存储空间；不足会拒绝导入。写入中断时下次启动尝试恢复，恢复失败则只读显示原数据供导出，并显示警告。日志本身损坏时保留原存储、停止写入并提示当前可读数据可能不完整。不要手动删除恢复日志。
- 存储不可读时显示临时内存模式警告；空间不足不会静默切成空数据库。警告出现后先备份并处理空间/存储设置。
- 导入、全量替换和清空建议只在一个页面操作；localStorage 不提供跨多个浏览器标签页的事务隔离。

`.gitignore` 排除了依赖、构建产物、本机配置、密钥和常见备份名。提交前仍应检查 Git 暂存内容。**不要直接压缩整个本地工作目录对外分享**，其中可能包含被忽略的密钥和私人备份。Git 作者的 noreply 邮箱和 LICENSE 署名仍可关联公开账号。

## 已知限制

- 通知数字由 Android SystemUI 绘制；到点逻辑由前台服务执行。设备深睡、厂商冻结或强制停止服务时，**不保证准时震动或自动推进**。当前未申请精确闹钟权限，也未持有 WakeLock。系统走字和准时回调不是同一保证。
- 锁屏展示与后台存活依赖系统权限和厂商省电策略，必要时按验收清单放行。开启锁屏全部内容前应自行权衡隐私。
- 无 GPS 轨迹采集，距离和配速需手填；只有浅色主题。
- 文本备份需要手动保存，尚无自动云同步。

## 目录

```text
www/                    界面、业务模型、本地存储、原生桥
app/android/            Android 工程与原生计时服务
app/*.ps1               Windows 构建、预览、安装入口
scripts/                无依赖本地 HTTP 服务与 Windows 进程辅助
tests/                  纯逻辑测试及浏览器回归页
docs/ACCEPTANCE.md       手机验收清单
```

## 许可

项目代码使用 [MIT License](LICENSE)。本地附带的 Chart.js v4.5.1 同为 MIT，许可见 [www/CHART.JS-LICENSE.md](www/CHART.JS-LICENSE.md)。
