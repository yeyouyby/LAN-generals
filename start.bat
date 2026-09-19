@echo off
chcp 65001 >nul
REM LAN-generals 一键启动（Windows）
cd /d %~dp0
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 16+: https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules (
  echo 首次运行，正在安装依赖…
  call npm install
  if errorlevel 1 ( pause & exit /b 1 )
)
node server.js
pause
