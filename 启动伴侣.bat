@echo off
chcp 65001 >nul
title 启动 Ambi 桌面生活态伴随体
cd /d "%~dp0"

echo ===================================================
echo     正在启动 Ambi 桌面生活伴随体 (Desktop Personal Agent)...
echo ===================================================

if not exist "dist" (
    echo 正在进行首次编译构建...
    call npm run build
)

echo 伴侣悬浮窗即将出现在屏幕右侧...
call npm run start
