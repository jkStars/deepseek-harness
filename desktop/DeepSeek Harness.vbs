Option Explicit

' DeepSeek Harness 无窗口启动器：双击本文件后只显示 DeepSeek Harness 窗口，
' 不显示命令行窗口。首次运行会在后台静默安装 Electron（约 100MB，国内镜像）。
' Electron 会复制到 bin\DeepSeek Harness\ 并把主程序改名为 DeepSeek Harness.exe，
' 使任务管理器中的进程名称显示为 DeepSeek Harness。

Dim fso, shell, appDir, stockExe, stockDir, appBin, appExe, logFile, command, code, env

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
stockExe = appDir & "\node_modules\electron\dist\electron.exe"
stockDir = appDir & "\node_modules\electron\dist"
appBin = appDir & "\bin\DeepSeek Harness"
appExe = appBin & "\DeepSeek Harness.exe"
logFile = appDir & "\install.log"

If Not fso.FileExists(stockExe) Then
  MsgBox "首次运行需要安装 Electron（约 100MB，使用国内镜像）。" & vbCrLf & _
         "点击“确定”开始安装，完成后会自动打开 DeepSeek Harness 窗口。", _
         vbInformation, "DeepSeek Harness"
  Set env = shell.Environment("PROCESS")
  env("ELECTRON_MIRROR") = "https://npmmirror.com/mirrors/electron/"
  env("ELECTRON_BUILDER_BINARIES_MIRROR") = "https://npmmirror.com/mirrors/electron-builder-binaries/"
  command = "cmd /s /c ""cd /d """ & appDir & """ && npm install --no-audit --no-fund > """ & logFile & """ 2>&1"""
  code = shell.Run(command, 0, True)
  If code <> 0 Or Not fso.FileExists(stockExe) Then
    MsgBox "依赖安装失败（退出码 " & code & "）。" & vbCrLf & _
           "请检查日志： " & logFile, vbCritical, "DeepSeek Harness"
    WScript.Quit 1
  End If
End If

' 生成进程名为 DeepSeek Harness.exe 的副本（整体复制 dist 后重命名主程序）。
If Not fso.FileExists(appExe) And fso.FileExists(stockExe) Then
  If fso.FolderExists(appBin) Then fso.DeleteFolder appBin, True
  fso.CreateFolder appBin
  fso.CopyFolder stockDir & "\*", appBin, True
  fso.MoveFile appBin & "\electron.exe", appExe
End If

shell.CurrentDirectory = appDir
If fso.FileExists(appExe) Then
  shell.Run """" & appExe & """ """ & appDir & """", 1, False
Else
  shell.Run """" & stockExe & """ """ & appDir & """", 1, False
End If
