'use strict'

/**
 * DeepSeek Harness desktop shell: a native window over the `dsh web` GUI.
 *
 * Boots `dsh web` as a child process (reusing an already-running instance on
 * the preferred port when present) and presents the GUI in a BrowserWindow.
 * Closing the window quits the app and stops the spawned server; when the
 * instance was reused the server keeps running untouched.
 * @module dsh-desktop/main
 */

const { app, BrowserWindow, dialog, shell } = require('electron')
const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const path = require('node:path')
const {
  findRepoRoot,
  killServerTree,
  loadConfig,
  probeBoot,
  resolveNode,
  startServer,
} = require('./server.js')

const APP_NAME = 'DeepSeek Harness'
const PREFERRED_PORT = 3080
const appDir = __dirname
// When packaged as a portable exe, config and repo discovery anchor on the
// folder holding the exe (electron-builder sets PORTABLE_EXECUTABLE_DIR), so
// config.json can sit next to the exe and the exe can live anywhere; bundled
// assets (splash) still load from the app bundle.
const anchorDir = app.isPackaged && typeof process.env.PORTABLE_EXECUTABLE_DIR === 'string'
  ? process.env.PORTABLE_EXECUTABLE_DIR
  : appDir

/** Known browser installations, in fallback preference order (Chrome first). */
const BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA !== undefined ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
  'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
  'C:\\Program Files\\360\\360se6\\Application\\360se.exe',
  'C:\\Program Files (x86)\\360\\360se6\\Application\\360se.exe',
].filter((candidate) => candidate !== null)

/**
 * Open a URL in the user's browser. `shell.openExternal` is the primary path;
 * when the OS cannot resolve the default browser (a removed or stale default
 * association makes ShellExecute fail, e.g. 0x800401F5), fall back to
 * launching a known browser directly, Chrome first.
 * @param {string} url - the http(s) URL to open.
 * @returns {Promise<void>} resolves when the launch attempt finished.
 */
async function openExternal(url) {
  try {
    await shell.openExternal(url)
    return
  } catch {
    // Fall through to the direct-browser fallback.
  }
  for (const candidate of BROWSER_CANDIDATES) {
    if (existsSync(candidate)) {
      spawn(candidate, [url], { detached: true, stdio: 'ignore' }).unref()
      return
    }
  }
}

let mainWindow = null
let webUrl = null
let ownedServer = null // ChildProcess when this app spawned dsh web; null when reusing an existing instance
let pendingChild = null // ChildProcess while the boot promise is still in flight
let shuttingDown = false

function isAppUrl(target) {
  return webUrl !== null && (target === webUrl || target.startsWith(`${webUrl}/`))
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: APP_NAME,
    icon: path.join(appDir, 'favicon.png'),
    backgroundColor: '#0b0f14',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow.once('ready-to-show', () => { mainWindow?.show() })
  // Fallback: never leave the window hidden. If the window was created with a
  // hidden show state (e.g. the launching shell passed SW_HIDE), the first
  // paint — and with it `ready-to-show` — can be deferred indefinitely; show
  // the splash after a short grace period regardless.
  setTimeout(() => {
    if (mainWindow !== null && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show()
  }, 2000)
  mainWindow.on('closed', () => { mainWindow = null })

  // The GUI opens no internal popups; hand every external link to the system
  // browser and refuse anything else.
  // The GUI opens no internal popups; hand every external link to the system
  // browser (with a direct-browser fallback) and refuse anything else.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target) && !isAppUrl(target)) void openExternal(target)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (isAppUrl(target) || target.startsWith('data:')) return
    event.preventDefault()
    if (/^https?:/i.test(target)) void openExternal(target)
  })

  void mainWindow.loadFile(path.join(appDir, 'splash.html'))
}

function watchServer() {
  if (ownedServer === null) return
  ownedServer.on('exit', (code) => {
    if (shuttingDown) return
    shuttingDown = true
    dialog.showErrorBox(`${APP_NAME} - 服务已停止`, `dsh web 意外退出（退出码 ${code ?? '?'}）。`)
    app.quit()
  })
}

async function boot() {
  const config = loadConfig(anchorDir)
  const repoRoot = findRepoRoot(anchorDir, config)
  if (repoRoot === null) {
    dialog.showErrorBox(
      APP_NAME,
      '未找到 DeepSeek Harness 仓库根目录（缺少 pnpm-workspace.yaml 与 apps/cli/src/bin.ts）。\n'
        + '请在 config.json（desktop 目录或 exe 所在目录）中配置 repoRoot 指向仓库根目录。',
    )
    app.quit()
    return
  }
  const node = resolveNode(config)
  const preferred = typeof config.port === 'number' && Number.isInteger(config.port) && config.port >= 0
    ? config.port
    : PREFERRED_PORT

  // Reuse an instance the user already started (e.g. from a terminal): probing
  // beats binding, so the app never kills a server it did not spawn.
  if (await probeBoot(`http://127.0.0.1:${preferred}`)) {
    webUrl = `http://127.0.0.1:${preferred}`
  } else {
    let started = null
    let lastError = null
    for (const port of preferred === 0 ? [0] : [preferred, 0]) {
      try {
        started = await startServer(repoRoot, node, port, (text) => console.log('[dsh web]', text.trimEnd()), (child) => { pendingChild = child })
        break
      } catch (error) {
        lastError = error
      }
    }
    pendingChild = null
    if (started === null) {
      if (!shuttingDown) {
        dialog.showErrorBox(
          `${APP_NAME} - 启动失败`,
          `${lastError instanceof Error ? lastError.message : String(lastError)}\n\n`
            + '请确认仓库根目录已执行过 pnpm install，且 node 可用（可在 desktop/config.json 中配置 nodePath）。',
        )
      }
      app.quit()
      return
    }
    ownedServer = started.child
    webUrl = started.url
    watchServer()
  }

  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    void mainWindow.loadURL(webUrl)
  }
}

app.setName(APP_NAME)

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
  app.on('before-quit', () => {
    shuttingDown = true
    const child = ownedServer ?? pendingChild
    if (child !== null) {
      killServerTree(child)
      ownedServer = null
      pendingChild = null
    }
  })
  app.on('window-all-closed', () => {
    app.quit()
  })
  app.whenReady().then(() => {
    createWindow()
    void boot()
  })
}
