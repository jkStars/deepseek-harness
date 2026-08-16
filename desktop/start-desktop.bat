@echo off
title DeepSeek Harness 桌面版
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 npm。请先安装 Node.js（https://nodejs.org）并确保 npm 在 PATH 中。
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo [dsh-desktop] 首次运行：正在安装 Electron（使用国内镜像，约 100MB，请稍候）...
  set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
  set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo [错误] 依赖安装失败。请检查网络后重新双击本文件，或在当前目录手动执行：npm install
    pause
    exit /b 1
  )
)

rem 生成进程名为 DeepSeek Harness.exe 的副本（整体复制 dist 后重命名主程序）
if not exist "bin\DeepSeek Harness\DeepSeek Harness.exe" if exist "node_modules\electron\dist\electron.exe" (
  if exist "bin\DeepSeek Harness" rmdir /s /q "bin\DeepSeek Harness"
  mkdir "bin\DeepSeek Harness" >nul 2>&1
  xcopy /e /i /y /q "node_modules\electron\dist\*" "bin\DeepSeek Harness\" >nul
  ren "bin\DeepSeek Harness\electron.exe" "DeepSeek Harness.exe"
)

echo [dsh-desktop] 正在启动 DeepSeek Harness，请稍候（首次启动需编译，约 10-30 秒）...
if exist "bin\DeepSeek Harness\DeepSeek Harness.exe" (
  start "" /b "bin\DeepSeek Harness\DeepSeek Harness.exe" "%cd%"
) else (
  call node_modules\.bin\electron.cmd . %*
)
