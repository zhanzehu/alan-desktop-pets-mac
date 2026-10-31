# Alan 桌宠 · macOS 版

邵艾伦、太对了、峰哥三只桌宠的 macOS 移植版，仿 [Alan-Desktop-Pets-Windows](https://github.com/wanzhijie1/Alan-Desktop-Pets-Windows)。

原版是三个独立的 .NET/WPF 进程，靠 Windows 命名管道互相通信。macOS 上没法直接跑，这里用 **Electron 单进程 + 三个无边框透明窗口** 重新实现，把跨进程管道换成了进程内的链式状态机——行为、音色、字幕、接话顺序全部照搬，安装却更简单。

## 运行

**直接双击 `三只桌宠.app`** —— 不需要终端、不需要 Node，运行时和素材都封在包里。

想放到启动台，把 `三只桌宠.app` 拖进 `/Applications` 即可。

如果系统提示"无法验证开发者"：右键点 `三只桌宠.app` → 打开 → 在弹窗里点"打开"，只需一次。

关闭：右键任意一只 →「退出桌宠」，或点菜单栏图标 →「退出」。

### 备选：命令行 / 开发模式

```bash
npm start                  # 开发模式，改代码即时生效
./启动三宠.command          # 等同于双击 .app，失败时回落到开发模式
```

### 已知环境坑

- **双击 `.command` 只弹出一行 `env: node: No such file or directory`**：`.bin/electron` 是个 `#!/usr/bin/env node` 脚本，而 macOS 自带没有 node。用 `.app` 启动就没这个问题；脚本也已改成直接调 Electron 二进制。
- **Electron 二进制下不下来**：GitHub Releases 常被墙。用镜像补装：
  `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`
- **报 `sandbox initialization failed`**：说明当前终端本身被限制（IDE 内置终端、远程会话常见），加 `--no-sandbox` 启动即可。
- **启动几十秒后自己消失**：日志里若有 `GPU process isn't usable`，说明当前会话拿不到正常显示服务，加 `--disable-gpu`。
- **排查启动问题看这里**：`~/Library/Logs/AlanDesktopPets.log`

## 功能

| 操作 | 效果 |
| --- | --- |
| 左键点一下 | 说一句 + 头顶字幕；说话时人物按 0.18s 节奏轻压 |
| 按住拖动 | 移动位置，松手自动记住 |
| 右键 | 播放方式 / 固定句 / 轮播筛选 / 联动 / 音量 / 大小 / 动态效果 / 退出 |
| 菜单栏图标 | 三只统一控制，可一键隐藏或移回右下角 |

三只的语音库与原版一致：邵艾伦 37 句（默认只开 8 句）、太对了 28 句、峰哥 11 句。

### 接话

- **点邵艾伦**：邵艾伦 → 太对了 → 峰哥 → 太对了（第四句后结束）
- **点峰哥**：峰哥 → 太对了（两句结束）
- **点太对了**：只播自己

接话不是等上一句完全播完才开始。程序会分析每段音频的人声起止点，提前 180ms 交接，并把下一句开头的静音前摇吃掉（最多 160ms），所以听感上是压着尾音接上去的，不会中间空一拍。某只正在说话时，接话会自动跳过，不会叠音。

## 与 Windows 版的差异

| 项 | Windows 版 | macOS 版 |
| --- | --- | --- |
| 进程模型 | 三个独立 exe + 命名管道 | 单进程 + 三窗口 + 进程内链路 |
| 音频 | WASAPI 低延迟输出 | HTMLAudioElement（Chromium） |
| 托盘 | 系统托盘 NotifyIcon | 菜单栏 Template Image |
| Dock | — | 隐藏（纯菜单栏应用，不占 Dock） |
| 动态效果 | WPF ScaleTransform | CSS `scaleY` 动画 |

字幕位置、字号、气泡配色、窗口尺寸公式 `(Size - 16) × 图片比例 + 52`、音量档位、大小档位、筛选"全部恢复"逻辑，都按原版来。

## 目录

```
src/main/
  main.js        窗口、播放、菜单、托盘、IPC
  bridge.js      接话链路规则（原 BridgeRules 移植）
  catalog.js     clips.json + 音频人声边界
  selector.js    随机/固定/筛选状态机（原 PlaybackSelector 移植）
  settings.js    偏好与位置持久化
  wav.js         WAV 头解析、人声起止检测
src/renderer/
  pet.*          桌宠窗口
  filter.*       轮播内容筛选窗口
assets/
  shaolan|sunpet|fengge/{face.png, clips.json, Clips/*.wav}
test/
  selftest.js    20 项无依赖自检：素材/链路/选择器
  e2e-driver.js  17 项端到端验证：真实起窗口、截图、采样接话时序
```

## 验证

```bash
# 纯逻辑自检，不需要 Electron
node test/selftest.js

# 端到端：开真窗口、截图、模拟点击、按 60ms 采样还原接话时间线
PETS_E2E=1 ./node_modules/.bin/electron . --no-sandbox
```

端到端会断言：三只头像解码成功、字幕可见、内容不溢出窗口、接话顺序为
`邵艾伦 → 太对了 → 峰哥 → 太对了`、点太对了不引发接话、中途停止后不再冒出接话。
产物（截图 + `e2e.json`）写在 `.cache/`。

## 打包成 .app

仓库里已有构建好的 `三只桌宠.app`（约 247MB，含 Electron 运行时）。改完代码要重新打包的话：

```bash
# 1. 复制 Electron 运行时
ditto node_modules/electron/dist/Electron.app "三只桌宠.app"
# 2. 改主程序名与 Info.plist（CFBundleExecutable → AlanDesktopPets，LSUIElement → true）
# 3. 代码与素材放进包内
mkdir -p "三只桌宠.app/Contents/Resources/app"
cp -R src package.json "三只桌宠.app/Contents/Resources/app/"
cp -R assets "三只桌宠.app/Contents/Resources/assets"
# 4. 改过包内容必须重新做 ad-hoc 签名，否则 Apple Silicon 直接 kill
codesign --force --deep --sign - "三只桌宠.app"
```

Electron 运行时的 `.app` 已设置 `LSUIElement`，不会在 Dock 里留图标，纯菜单栏常驻。

也可以走 `npm run dist`（electron-builder），但它要从 GitHub 拉运行时，本机网络下容易失败。

## 偏好文件位置

```
~/Library/Application Support/alan-desktop-pets-mac/settings.json
```

删掉它即可恢复出厂位置与默认设置。

## 素材来源与许可

三个角色的头像、语音、字幕来自上游项目：

- [ShaolanPet](https://github.com/Ganzhe2028/ShaolanPet) · [SunPet](https://github.com/Ganzhe2028/SunPet) · [FengGe-Desktop-Pet](https://github.com/Ganzhe2028/FengGe-Desktop-Pet)
- 整合版：[wanzhijie1/Alan-Desktop-Pets-Windows](https://github.com/wanzhijie1/Alan-Desktop-Pets-Windows)

各角色原许可证见 `assets/` 内对应目录的上游仓库；本项目仅做平台移植，未修改原始音频与图像。
