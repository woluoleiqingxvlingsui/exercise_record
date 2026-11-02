# 🏋️ 训练记录（手机端 App）

按自己的训练计划练、组间歇不用切到时钟 App、练完顺手记感受、日历上看清哪天练了什么。

基于 **Capacitor 7** 打包成安卓 APK 装在自己手机上用；界面是纯 ES modules + 原生 DOM（**零构建、零第三方运行时依赖**），也能直接在电脑浏览器里预览。

**全程离线、数据只存在自己手机上**：不声明联网权限、不联网上报、不开系统云备份。

---

## 功能

### 计划（预设计划）
- 三层结构：**计划 → 阶段（热身 / 正式 / 放松）→ 动作 → 组**
- 组的两种写法：**统一组**（3 组 × 8 次）或**逐组编辑**（金字塔式，每组不同次数/重量）
- **每个动作只有一个「组间歇」**：做完每一组（含最后一组）都按它休息。
  个别组想临时改长短，训练中的「灵活调整」当场改就行 —— 计划里不必预设四层间歇，
  层级一多就得猜"到底哪条在生效"（这是真踩过的坑，见下方踩坑表）
- **训练类别由你自己命名**（腿 / 推 / 拉 / 有氧…都行），填过的会自动记住，下次点一下就复用；
  **长按**某个类别标签可以把它删掉（内置的「力量/有氧」也能删，删的只是这个可选项，已有的计划不受影响）
- 力量（次数/重量）与有氧（时长/距离/配速）都支持；内置**引体日、推日、日常有氧跑、强度跑（1000m 间歇）、长距离跑**五个示例可直接改
- 每个计划都有**「查看」**（只读，怎么点都不会改动）与**「编辑」**两个入口

### 训练（核心）
- 每组流程：**完成本组 → 询问「按计划推进 / 灵活调整」→ 选完才进入组间歇倒计时**
- **通知栏常驻计时卡**：组间歇是**倒计时**，走字由 SystemUI 绘制（`setChronometerCountDown`），**App 进程被冻结甚至被杀也照样走字，不需要 WakeLock**
- 结束训练有两个选择：**结束并保存**（已完成的组存进记录，未完成的标注提前结束），
  或**结束，并不保存**（整次丢弃，会再二次确认防误触）
- 休息结束**长时间震动**提醒（约 2.8 秒、连震 5 下），刻意**不再另发「休息结束」通知**：
  休息一结束紧接着就是下一组的「训练中 · 第 x/x 组」常驻卡，再发一条独立通知纯属重复信息
- 点常驻通知**直接回到训练页**（而不是唤回"上次待着的那个页面"）；若训练还在进行，直接接着练
- 「灵活调整」可以**自己定本组间歇**，并且**始终把原计划时长显示在旁边当参考**（快捷档位里也高亮"计划"那一档，实时显示与计划的差值）
- 另可临时：加组 / 减组 / 跳过下一组 / 结束本动作 —— 每次调整都留痕，日后能回看当时改了什么
- **杀进程可恢复**：进行中的训练单独存在 `ex.ongoing`；**重开 App 会立刻弹出「上次训练还没结束」**，
  直接选继续 / 结束并保存 / 结束并不保存，不用自己去训练页找那张卡片
- 询问时若锁屏/切走，**原生服务会在超时后自动按计划推进并标注「自动」**，避免"放下手机结果根本没在计时"

### 反馈、日程与统计
- 练完记录：**本次训练时长（自己填，统计以它为准）**、RPE、体感、不适部位、备注、下次想调整什么
- **训练日程**：月视图默认折叠，每格只在日期下点一个**同色圆点**（只回答"这天练没练"，不再按类别分色）；
  **在日历上向下滑**就展开、当天格子下面直接列出练了什么，**向上滑**收起（**纯手势，没有按钮**）
  - 拖动时**每格高度实时跟着手指走**，两端带橡皮筋阻尼；松手按**位移 + 速度**吸附到展开或收起，并给一点震动确认
  - 快速轻扫一下就能切换，不必真拖过半程
  - **日历这块区域里的滑动只管展开/收起，不会带动页面滚动**（否则两套逻辑抢同一根手指，手感发涩）
  点某天看详情；训练完成**自动写入**日程，也**可以自己加计划、标休息日**。这一页**只放日程不放统计**
- ⚠ **记录训练**：按着计划练了但没走 App（或只是想记一句「今天有氧 30 分钟」），在那天点「记录训练」：
  - **按计划记录** —— 选今天练的那套计划 + 填实际练了多少分钟
  - **简单记一笔** —— 只填**训练类别 + 时长**，几十秒搞定

  不用再把计划里的组挨个点一遍"完成/跳过"才能留下记录（那样既麻烦，又会造出一堆假的"偏离"）
- **训练时长由用户自己记录**（正式组按容量控制时间、有氧在 Keep 之类的软件里计时，App 秒表的流逝时间不等于真实训练时间）：
  训练结束的详情面板里**已预填**计时结果，改成实际时间即可；**统计页的总时长、分类时长、柱状图全部以它为准**，
  老记录没记过的会回落用自动计时，不影响老数据
- **统计**：按 **周 / 月 / 年** 三种粒度看训练**总时长**与**次数**（含平均每次），
  用 ‹ › 翻看任意一周 / 一月 / 一年；另有**按类别**分项 —— 每个类别各多少时长、各几次
- **JSON 导出/导入**：数据只在手机上（卸载即清空），这是唯一的备份手段

---

## 打 APK 并装到手机

**只需要 Windows + PowerShell。** JDK 21、Android SDK、Gradle、Node.js 缺什么脚本自动装（装在 `%USERPROFILE%\tools\` 下，可重复运行，已装则复用），国内网络走镜像。

```
powershell -ExecutionPolicy Bypass -File app\build-apk.ps1            # debug 包（日常用）
powershell -ExecutionPolicy Bypass -File app\build-apk.ps1 -Install   # 打完直接装到已连线的手机
powershell -ExecutionPolicy Bypass -File app\build-apk.ps1 -Release   # release 包（首次自动生成签名）
```

产物：原始的在 `app\android\app\build\outputs\apk\...`，脚本会**再复制一份带版本号的到 `_out\apk\`**：

```
_out\apk\exercise-record-0.7.0-debug.apk      # 日常验收用
_out\apk\exercise-record-0.7.0-release.apk    # 正式用（体积更小）
```

两个包都已用 `apksigner` 验签通过（v1 + v2 方案）：debug 用 Android 默认调试证书，release 用脚本在本机生成的 `CN=ExerciseRecord` 证书。

装到手机的两种方式：

1. 把 `_out\apk\*.apk` 传过去点击安装（首次需允许「未知来源」）；
2. 手机开 USB 调试并连线后：`powershell -ExecutionPolicy Bypass -File app\install-to-phone.ps1`

应用 ID 为 `app.exercise.record`。

> ⚠ **debug 与 release 签名不同，不能互相覆盖安装。**
> 建议：验收阶段统一用 **debug** 包；等验收通过了再决定要不要换 release —— 换的话必须先卸载（**会丢掉已有记录**，换之前先在设置里导出备份）。
>
> ⚠ **release 签名密钥务必自己备份**：`app\android\exercise-release.keystore` 与 `app\android\keystore.properties`（含随机口令）。
> 这两个文件已在 `.gitignore` 里，**不在版本控制中**；丢了以后就无法覆盖安装升级，只能卸载重装。

装完请按 **[`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md)** 逐条验收。

---

## 在电脑上预览

```
powershell -ExecutionPolicy Bypass -File app\preview-web.ps1
```

或双击 `preview-web.bat`（起本地服务 + 开浏览器，F12 → Ctrl+Shift+M 切手机视口）。

> 浏览器预览里**没有通知栏计时卡**（那是原生能力），组间歇只在页面内计时；要验通知栏必须装 APK。
> 预览的数据存在浏览器 origin 下，和手机 App 里的数据不互通。

## 跑测试

```
node tests/run.js                                                     # 纯逻辑，82 项，秒级
powershell -ExecutionPolicy Bypass -File tests\browser\run-views.ps1   # 前端集成，40 项，无头浏览器
```

- **纯逻辑**（模型 / 存储 / 日期 / 示例数据 / 导入导出往返 / 模块导入导出匹配 / 回归守卫）：不需要浏览器也不需要手机。
- **前端集成**：用无头 Edge/Chrome 真实加载页面，把计划编辑器、训练主流程（完成本组 → 询问 → 灵活调整 → 倒计时 → 下一组）、日历、统计、反馈表单都点一遍，并断言「灵活调整里**原计划间歇**确实显示出来、且记录里同时留下计划值与实际值」。加 `-Headed` 可以看着它跑。
- **回归守卫**（`tests/regress.test.js`）：2026-11-02 那次只读审计发现的缺陷（替换式导入会清库、`ex.meta` 损坏导致记录静默消失、写入顺序留下孤儿记录、最后一组选间歇被默默丢弃…）都补了断言 —— 那批问题原来 67 项测试一条都没覆盖，全绿也拦不住。

> 两个坑记一下：
> 1. 别用 `node --test tests/` —— 它会为每个测试文件 spawn 子进程并抓 stdio，受限沙箱里进程间管道不可用（spawn EPERM）。同进程跑结果一致，沙箱外两种都行。
> 2. 集成测试脚本里**必须**用 `Start-Process` 重定向到文件来收浏览器输出；直接 `& $browser @args`（数组 splat）在本机拿不到任何 stdout（长度 0、`$LASTEXITCODE` 为空，像是命令没执行）。
>
> 另外 Chromium 的进程间通信用命名管道，在受限沙箱里会启动失败（`platform_channel.cc: 拒绝访问`），跑集成测试时需要放宽进程/文件权限。

---

## 目录结构

```
exercise_record/
├── www/                        # 界面层（会被打进 APK）
│   ├── index.html              # 外壳 + Tab
│   ├── css/app.css             # 可爱卡通设计系统（令牌 + 组件类）
│   └── js/
│       ├── main.js             # 入口：Tab 路由、训练会话编排、设置/备份
│       ├── store.js            # 分桶持久化 + schema 版本 + 导出导入 + 配额保护
│       ├── model.js            # 领域模型 / 计划摊平 / 休息优先级 / 日程（纯函数）
│       ├── seed.js             # 内置示例计划
│       ├── native.js           # Capacitor 插件封装 + 浏览器降级
│       ├── ui.js               # 图标/吉祥物/底部弹层/轻提示
│       └── views/{plans,train,calendar,history}.js
├── app/                        # 安卓壳（Capacitor 7）
│   ├── build-apk.ps1           # 一键装工具链 + 打包（debug / release / -Install）
│   ├── install-to-phone.ps1    # adb 一键装机
│   ├── preview-web.ps1         # 本地起服务预览网页版
│   ├── package.json            # Capacitor 依赖清单
│   ├── package-lock.json       # 锁定的依赖版本（入库，保证别人 clone 下来装的是同一批）
│   └── android/                # 安卓工程
│       └── app/src/main/java/app/exercise/record/
│           ├── MainActivity.java       # edge-to-edge + 键盘 inset 修复
│           ├── RestTimerService.java   # 前台服务：通知栏倒计时 + 到点震动 + 询问兜底
│           └── RestTimerPlugin.java    # JS ↔ 原生桥
├── tests/                      # node tests/run.js
└── docs/ACCEPTANCE.md          # 装机验收清单 + 已知限制
```

---

## 数据与隐私

- 数据存在 App 私有 localStorage（键前缀 `ex.`），**只在本机**，卸载才清掉
- 会话按 `ex.sessions.YYYY-MM` **分月存**，避免单个大 key 每次写入都全量序列化；进行中的训练单独存 `ex.ongoing`
- 清单里**没有** `INTERNET` 权限：Capacitor 的 `https://localhost` 由原生 scheme handler 在内存里拦截、直接从 APK 资源读文件
- `android:allowBackup="false"`：明确关掉系统备份
- 没有账号、没有登录、没有埋点、没有第三方 SDK（`www/chart.umd.js` 是本地打包的 Chart.js，MIT）
- **备份只能靠 App 内「设置 → 导出为文本」**：复制那段 JSON 存到备忘录/电脑上。卸载或清数据即全部丢失

## 已知限制

- **通知栏计时的可见性依赖厂商 ROM**。小米/HyperOS 上如果锁屏看不到卡片，按验收清单里的四步放行；通知栏下拉一定能看到
- release 与 debug 包签名不同，不能互相覆盖安装，切换包型要先卸载（会丢记录）
- 有氧不采集 GPS 轨迹，距离/配速靠手填或看表
- 只有浅色主题

---

## 复用与踩坑记录

本项目沿用了同一个人的番茄钟（`tomato_clock`）的安卓打包流水线与前台服务机制。落地时又踩到几个坑，都已在代码/脚本里修掉，记在这里免得重犯：

| 坑 | 现象 | 处理 |
|---|---|---|
| **PowerShell 脚本 BOM** | `build-apk.ps1` 被改写后中文串乱码、报 `Unexpected token '}'` | Windows PowerShell 5.1 按 ANSI 读 `.ps1`，**必须存成 UTF-8 with BOM** |
| **npm 装不上** | 镜像把 `@types/node "*"` 解析成不存在的 `26.6.3`，`npm ci` 先把 `node_modules` 清空再失败 | 依赖已 vendored，`build-apk.ps1` 检测到 Capacitor CLI 在位就**跳过 npm**（要重装加 `-ForceDeps`）。`app/package-lock.json` 已入库，别人 clone 下来装的是同一批版本；本机若要强制重装，会先试 `npm ci`，失败再回退 `npm install` |
| **`init.gradle` 是全局的** | 原脚本每次都会重写 `~/.gradle/init.gradle`，会影响本机其它 Gradle 工程 | 内容一致就**完全不碰**，不一致才备份后覆盖 |
| **Gradle 缓存不在工作区** | 沙箱下构建被拒（Gradle 要写 `~/.gradle/caches`） | 构建时放宽文件访问；也正因如此，`node_modules` 才选择 vendored 以便离线 |
| **ES 模块导入不存在的名字** | 浏览器端 `SyntaxError: does not provide an export named ...`，**整页白屏**，`node --check` 查不出来 | 新增 `tests/imports.test.js` 静态校验所有具名导入/导出匹配 |
| **`export {}` 重复导出** | 同名导出会直接报语法错误 | 检查器覆盖 |
| **询问超时后没人管** | 完成一组后放下手机，JS 定时器被冻结，结果根本没在计时 | 由原生服务按 `confirmDeadline` 自动套用计划间歇并标注 `auto`，回 App 时对账 |
| **Capacitor 大整数过桥** | `getDouble` 对 Long 返回 null，导致计时归零 | 所有时间戳一律 `String(...)` 传桥，原生侧再 parse |
| **灵活调整里看不到"哪一档是计划"** | 档位只给固定预设（30/60/90…），计划若是 45 秒这种值就不在列表里，参考基准直接丢失 | `restOptions()` 把计划值并入档位并高亮；有单测 + 集成测试双重保护 |
| **`& $browser @args` 拿不到输出** | 数组 splat 调用浏览器时 stdout 长度为 0、退出码为空 | 集成测试脚本改用 `Start-Process` 重定向到文件 |
| **给未声明变量赋值** | ESM 严格模式下直接 `ReferenceError` | 集成测试真跑一遍才暴露 |
| **`confirmSheet` 点遮罩关闭** | Promise 永不 resolve，调用处的 `await` 永久挂起 | 确认框设为不可点遮罩关闭 |
| **`cap add android` 没有签名配置** | `-Release` 打出来的是 `app-release-unsigned.apk`，脚本按设计直接报错 | 把番茄钟里那段"`keystore.properties` 存在才声明 `signingConfig`"补进 `app/android/app/build.gradle`；注意 `storeFile` 要用 `rootProject.file()` 解析（密钥在 `app/android/`，不在模块目录） |
| **前台 JS 抢跑，到点提醒整个消失** | 休息到点**不震动、也没有「休息结束」通知**：JS 的 250ms 计时器比服务的 1 秒 tick 更早发现到点，立刻把状态推成 `set`，原生便永远等不到 `restEndTs`；而 WebView 里 `navigator.vibrate` 根本没实现，JS 那句震动等于空操作 | 到点改由 JS 主动调原生 `restDone()`（新增 `ACTION_ALERT`）；原生保留后台路径，服务侧用 `lastAlertedRestEndTs` 去重，保证一次休息只提醒一次 |
| **间歇设计过度：四层优先级没人猜得对** | 「组间 / 最后一组后 / 换动作过渡 / 阶段过渡」四个字段并存，结果"阶段过渡填了 120 秒、实际一直走 60 秒"，而且光看界面根本看不出来谁在生效；用户自己都要问"这两个什么区别" | **砍到只剩一个「组间歇」**：每个动作一个值，做完每一组都按它休息；个别组临时改长短交给训练中的「灵活调整」。模型对老数据里的废弃字段直接忽略，老计划一存就自动清干净 |
| **前台服务启动失败不自杀** | 服务是被 `startForegroundService()` 拉起来的，系统等它 5~10 秒进前台；进不去就抛 `ForegroundServiceDidNotStartInTimeException` **把整个 App 进程打死** | 所有失败分支都补 `stopSelf()`：进不去前台时撤通知 + 退场，但**不清**已落盘的状态（JS 还活着，会再推一次回来） |
| **插件无条件回 `ok:true`** | 通知其实没挂上（后台启动限制等），JS 却以为成功了，界面上什么都不提示 | `update()` / `restDone()` 投递失败时回 `{ok:false, reason}`，由 JS 判断 |
| **`autoApplied` 被每次更新抹掉** | 原生兜底自动推进后记的 `autoApplied=true` 被下一次 `update()` 写死的 `false` 覆盖，回 App 对账失效、这次自动推进被记成"用户自己选的" | 插件改为**从已落盘状态继承**这个标记（换训练时 sessionId 不同就不继承） |
| **询问阶段通知不走字** | 锁屏等选择时通知栏显示的是"这组已经过了多久"，不是"还剩多久自动推进" | confirm 阶段改用 `setChronometerCountDown` 倒计时到 `confirmDeadline`，与间歇同款 |
| **密钥文件丢了会被自动覆盖** | `keystore.properties` 在、`.keystore` 没了 —— 脚本若直接生成新密钥并覆盖口令文件，手机上用旧密钥签过的 App 就**再也盖不上**（只能先卸载，训练记录会丢） | 这种情况**直接停下报错**，把"恢复旧密钥 / 确定换新签名"两个解法交回给人决定，不自动换 |
| **挑包靠文件时间猜** | 把 `_out\apk` 和 gradle 原始产物混在一起按 mtime 排序，可能选中 debug 包、未签名包甚至 androidTest 的包，而且不告诉你装的是哪一种 | 改成按**版本号 → flavor → 时间**明确排序，排除 `*-unsigned*` 与 `androidTest/`，并打印"选中：release 包 · 版本 x.y.z · 来源 ..." |
| **curl 拿到 404 也算成功** | 镜像挂了返回 HTML 错误页，`curl` 照样退出 0，被当成 zip 存下来，后面解压时才炸、报错难懂 | 下载统一加 `--fail`，并在 `sdkmanager --licenses` 之后显式检查退出码 |

---

## 许可

本项目代码 MIT（见 [`LICENSE`](LICENSE)）。`www/chart.umd.js` 是 Chart.js v4.5.1，MIT。
