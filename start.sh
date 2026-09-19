#!/bin/sh
# LAN-generals 一键启动（Mac / Linux）
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "请先安装 Node.js 16+：https://nodejs.org"
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "首次运行，正在安装依赖…"
  npm install || exit 1
fi
node server.js
