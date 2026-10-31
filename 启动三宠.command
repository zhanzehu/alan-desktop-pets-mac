#!/bin/zsh
# 备选启动方式。正常使用请直接双击「三只桌宠.app」。
# 这个脚本不依赖 node —— 直接调用 Electron 二进制。

cd "$(dirname "$0")" || exit 1
unset ELECTRON_RUN_AS_NODE

APP="三只桌宠.app"
LOG="$HOME/Library/Logs/AlanDesktopPets.log"
mkdir -p "$(dirname "$LOG")"

# 首选：直接用系统 open 启动 .app 包（等价于在 Finder 里双击）
if [ -d "$APP" ]; then
  open "$APP"
  sleep 3
  if pgrep -f "$APP/Contents/MacOS/AlanDesktopPets" >/dev/null 2>&1; then
    echo "三只已就位。关闭方式：右键任意一只 →「退出桌宠」，或点菜单栏图标。"
    exit 0
  fi
  echo "启动失败。若系统提示「无法验证开发者」，去「系统设置 → 隐私与安全性」点「仍要打开」。"
  exit 1
fi

# 兜底：没有 .app 时走开发模式（不经过 node_modules/.bin/electron，那个需要系统 node）
BIN="./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [ ! -x "$BIN" ]; then
  echo "缺少 Electron 运行时。请先执行：npm install"
  echo "若卡在下载 Electron 二进制，用镜像补装："
  echo "  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js"
  read -r "?按回车退出"
  exit 1
fi

echo "启动中…"
nohup "$BIN" . --no-sandbox >"$LOG" 2>&1 &
disown

sleep 5
if pgrep -f "$BIN" >/dev/null 2>&1; then
  echo "三只已就位。关闭方式：右键任意一只 →「退出桌宠」。"
  exit 0
fi

echo "进程提前退出，日志：$LOG"
read -r "?按回车退出"
exit 1
