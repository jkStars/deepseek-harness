# DeepSeek Harness 桌面版（desktop/）

双击即可启动 DeepSeek Harness：本目录下的 Electron 壳会像 `pnpm dsh web` 一样拉起
`dsh web` 服务，但把 Web GUI 显示在一个**原生窗口**里（类似 Codex / Claude 桌面版），
不再需要手动敲命令、也不再占用浏览器标签页。关闭窗口即停止服务（若复用了外部已启动
的实例则不动它）。

## 环境要求

- Windows 10 / 11
- Node.js `^22.19 || >=24`（与仓库要求一致，服务进程直接使用本机的 node）
- 仓库根目录已执行过 `pnpm install`（即能跑 `pnpm dsh web` 的环境即可）

## 快速开始

1. **日常使用：双击 `desktop/DeepSeek Harness.vbs`** —— 不会出现命令行窗口，只显示
   DeepSeek Harness 窗口。
   - 首次运行会先弹窗确认，然后**后台静默**安装 Electron（约 100MB，国内镜像），
     完成后自动打开窗口；之后直接秒开。
2. 可选：双击 `desktop/install-shortcut.bat` 在桌面创建 "DeepSeek Harness" 快捷方式
   （同样指向 VBS，双击无命令行窗口），之后从桌面图标启动。

需要看服务日志时，用 `desktop/start-desktop.bat`（命令行版，窗口会显示启动过程日志）。

也可以手动安装并启动：

```bat
cd desktop
npm install
npm start
```

## 行为说明

- **窗口即应用**：启动时先显示加载页，`dsh web` 就绪后加载 GUI；关闭窗口 = 退出应用
  = 停止本次启动的服务进程（含其子进程树，不会残留后台进程）。
- **首次启动较慢属正常**：第一次会编译 CLI 并装配整个 web 配置，约 1-2 分钟（期间显示
  加载页）；之后启动会快很多。
- **进程名**：启动器会把 Electron 复制到 `bin/DeepSeek Harness/` 并重命名主程序为
  `DeepSeek Harness.exe`，因此**任务管理器中的进程名显示为 "DeepSeek Harness"**
  而不是 "electron"（两个启动器都会自动生成该副本）。
- **端口**：默认优先使用 3080。如果 3080 上已有一个 `dsh web`（例如你从终端手动
  启动的），桌面版会**直接复用**它，退出时不关闭它；否则自动选一个空闲端口
  （`--port 0`），互不冲突。
- **单实例**：重复双击只会聚焦已打开的窗口。
- **外部链接**：GUI 中的外链会用系统默认浏览器打开，窗口本身不会跳走。

## 配置（可选）

复制 `config.json.example` 为 `desktop/config.json` 后按需修改：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `repoRoot` | 自动向上查找 | 仓库根目录（含 `pnpm-workspace.yaml`）；一般无需配置 |
| `nodePath` | `node`（PATH 查找） | 服务进程使用的 Node 可执行文件绝对路径 |
| `port` | `3080` | 优先尝试的端口；设为 `0` 则始终让系统分配 |

示例：

```json
{ "repoRoot": "..", "nodePath": "C:\\Program Files\\nodejs\\node.exe", "port": 3080 }
```

## 打包成独立 .exe（可选）

想要一个真正独立的单文件 portable exe（进程名、版本信息都显示 "DeepSeek Harness"）：

```bat
cd desktop
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run pack
```

产物在 `desktop/dist/DeepSeek Harness.exe`，双击即可运行（无命令行窗口）。exe 图标
取自 GUI 页面左上角的鲸鱼图标（`apps/web/public/favicon.svg` 渲染成
`desktop/favicon.png`）。注意：图标是**黑色鲸鱼 + 透明背景**，在深色任务栏上可能
不明显；需要白色或带底色版本可以再生成。该 exe 只是桌面壳，运行时仍需调用
`repoRoot` 对应的仓库来启动服务——exe 放在仓库内（如 `desktop/dist/`）会自动向上
找到仓库；若放到别处，请在 exe 同目录放一个 `config.json` 并指定 `repoRoot`。

## 排障

- **启动失败弹窗「dsh web 在就绪前退出」**：确认仓库根目录已 `pnpm install`、当前
  Node 版本满足要求；窗口下方的控制台会打印服务日志尾部。
- **提示找不到 npm**：安装 Node.js 并确认 `npm` 在 PATH 中。
- **安装 Electron 很慢/失败**：检查 `DeepSeek Harness.vbs` / `start-desktop.bat` 中
  镜像地址是否可达，或换用其它镜像源后手动执行 `npm install`；失败日志在
  `desktop/install.log`。
- **端口被占用**：桌面版会自动改用空闲端口；只有 3080 被非 DSH 服务占用且系统也
  无法分配端口时才会失败（极罕见）。
- **重新安装 Electron 后进程名又变回 electron**：`bin/DeepSeek Harness/` 是旧版本
  的副本。删除 `desktop/bin` 目录后重新启动，启动器会按新版本自动重建。
- **批处理中文乱码**：`start-desktop.bat` / `install-shortcut.bat` / `DeepSeek Harness.vbs`
  为 **GBK（代码页 936）编码**，与中文 Windows 的原生编码一致。若用编辑器改过并保存
  成了 UTF-8，中文会乱码；请另存为 ANSI/GBK 编码，行尾保持 CRLF。

## 目录结构

```
desktop/
  main.js               Electron 主进程（窗口、生命周期、导航守卫）
  server.js             纯 Node 逻辑（仓库定位、探测、启动服务、杀进程树）
  splash.html           启动加载页
  DeepSeek Harness.vbs  无窗口启动器（日常双击入口；首装 Electron + 拉起窗口）
  start-desktop.bat     命令行版启动器（调试用，可看服务日志）
  install-shortcut.bat  创建桌面快捷方式（指向 VBS）
  config.json.example   可选配置样例
  favicon.png           鲸鱼图标（exe 与窗口图标；由 render-icon.js 渲染）
  render-icon.js / icon-page.html / favicon.svg   图标渲染工具（改图标后重跑 electron render-icon.js 并 npm run pack）
  package.json          依赖与打包配置（electron / electron-builder）
  bin/DeepSeek Harness/ 自动生成的进程名副本（DeepSeek Harness.exe；可删除，启动时自动重建）
  dist/                 electron-builder 打包产物（DeepSeek Harness.exe）
```
