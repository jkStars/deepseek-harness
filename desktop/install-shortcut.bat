@echo off
title 创建 DeepSeek Harness 桌面快捷方式
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$desktop = [Environment]::GetFolderPath('Desktop');" ^
  "$lnk = $ws.CreateShortcut((Join-Path $desktop 'DeepSeek Harness.lnk'));" ^
  "$lnk.TargetPath = (Join-Path '%~dp0' 'DeepSeek Harness.vbs');" ^
  "$lnk.WorkingDirectory = '%~dp0';" ^
  "$lnk.Description = 'DeepSeek Harness 桌面版';" ^
  "$lnk.Save()"

if errorlevel 1 (
  echo [错误] 创建快捷方式失败。
) else (
  echo 已创建桌面快捷方式：DeepSeek Harness
)
pause
