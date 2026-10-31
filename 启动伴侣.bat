@echo off
chcp 65001 >nul
title 启动 Looma 客户跟进伴侣
cd /d "%~dp0"

echo ===================================================
echo     正在启动 Looma 客户跟进伴侣...
echo ===================================================

if not exist "node_modules\typescript" (
    echo 正在安装锁定版本的依赖...
    call npm ci
    if errorlevel 1 (
        echo 依赖安装失败，启动已取消。
        pause
        exit /b 1
    )
)

echo 正在验证并构建当前代码...
call npm run build
if errorlevel 1 (
    echo 构建失败，未启动旧版本。
    pause
    exit /b 1
)

echo 伴侣悬浮窗即将出现在屏幕右侧...
call npm run start
