'use strict'

/**
 * Pure-Node helpers for the DeepSeek Harness desktop shell: locating the
 * checkout, probing an already-running `dsh web` instance, spawning the web
 * server as a child process, and killing its process tree. This module imports
 * nothing from Electron so the logic stays testable under plain Node.
 * @module dsh-desktop/server
 */

const { spawn } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const http = require('node:http')
const path = require('node:path')

/** The HTML marker `dsh web` injects into every served page. */
const BOOT_MARKER = '__DSH_BOOT__'

/** The readiness line `dsh web` prints once the server can serve the GUI. */
const URL_LINE = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/

/**
 * How long to wait for the readiness line before declaring the boot failed.
 * Generous on purpose: the first boot transpiles the CLI graph and assembles
 * the whole web profile, which can take over two minutes on a cold machine.
 */
const BOOT_TIMEOUT_MS = 180_000

/**
 * Read `desktop/config.json` if present. Malformed JSON is ignored so a
 * typo never blocks startup.
 * @param {string} appDir - the directory holding the desktop app files.
 * @returns {Record<string, unknown>} the parsed config, empty when absent or invalid.
 */
function loadConfig(appDir) {
  const configPath = path.join(appDir, 'config.json')
  if (!existsSync(configPath)) return {}
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    console.error(`dsh-desktop: ignoring invalid ${configPath}: ${error.message}`)
    return {}
  }
}

/**
 * Locate the harness checkout root: the configured `repoRoot` (resolved against
 * the desktop directory) when present and valid, otherwise walk up from the
 * desktop directory looking for a `pnpm-workspace.yaml` next to
 * `apps/cli/src/bin.ts`.
 * @param {string} appDir - the directory holding the desktop app files.
 * @param {Record<string, unknown>} config - parsed config from {@link loadConfig}.
 * @returns {string | null} the checkout root, or null when not found.
 */
function findRepoRoot(appDir, config) {
  const candidate = typeof config.repoRoot === 'string' && config.repoRoot !== ''
    ? path.resolve(appDir, config.repoRoot)
    : null
  if (candidate !== null) {
    if (existsSync(path.join(candidate, 'pnpm-workspace.yaml')) && existsSync(path.join(candidate, 'apps', 'cli', 'src', 'bin.ts'))) {
      return candidate
    }
    return null
  }
  let dir = appDir
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml')) && existsSync(path.join(dir, 'apps', 'cli', 'src', 'bin.ts'))) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * The Node executable used to run the server: the configured `nodePath` when
 * present, otherwise `node` resolved through PATH.
 * @param {Record<string, unknown>} config - parsed config from {@link loadConfig}.
 * @returns {string} the executable to spawn.
 */
function resolveNode(config) {
  return typeof config.nodePath === 'string' && config.nodePath !== '' ? config.nodePath : 'node'
}

/**
 * Whether the URL already serves a DeepSeek Harness page (an existing
 * `dsh web` instance, e.g. one the user started from a terminal).
 * @param {string} url - the URL to probe, `http://127.0.0.1:<port>`.
 * @param {number} [timeoutMs] - per-request timeout; defaults to 2000.
 * @returns {Promise<boolean>} true when the page carries the boot marker.
 */
function probeBoot(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve(body.includes(BOOT_MARKER)))
      res.on('error', () => resolve(false))
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

/**
 * Spawn `node --import tsx/esm apps/cli/src/bin.ts web --port <port>` with the
 * checkout as working directory and resolve once the readiness line
 * `dsh web: http://127.0.0.1:<port>` appears on stdout. Rejects on spawn
 * failure, early exit, or a boot timeout, carrying the tail of the output.
 * @param {string} repoRoot - the harness checkout root.
 * @param {string} node - the Node executable to spawn.
 * @param {number} port - the port to request; 0 lets the OS assign one.
 * @param {(text: string) => void} [onOutput] - live forwarding of stdout chunks.
 * @param {(child: import('node:child_process').ChildProcess) => void} [onChild] -
 *   invoked with the child right after spawn, so the caller can stop it even
 *   while the readiness promise is still pending (e.g. window closed mid-boot).
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, url: string }>}
 */
function startServer(repoRoot, node, port, onOutput = () => {}, onChild = () => {}) {
  return new Promise((resolve, reject) => {
    const args = ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--port', String(port)]
    const child = spawn(node, args, {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    onChild(child)
    let output = ''
    let settled = false
    const finish = (fn) => { if (!settled) { settled = true; fn() } }
    const tail = () => output.split('\n').slice(-12).join('\n').trim()
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      output += text
      onOutput(text)
      const match = output.match(URL_LINE)
      if (match) finish(() => resolve({ child, url: match[1] }))
    })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.on('error', (error) => finish(() => reject(new Error(`dsh web 无法启动: ${error.message}`))))
    child.on('exit', (code) => finish(() => reject(new Error(`dsh web 在就绪前退出（退出码 ${code ?? '?'}）:\n${tail()}`))))
    setTimeout(() => {
      finish(() => reject(new Error(`dsh web 在 ${Math.round(BOOT_TIMEOUT_MS / 1000)} 秒内未就绪:\n${tail()}`)))
    }, BOOT_TIMEOUT_MS).unref()
  })
}

/**
 * Stop a spawned server: terminate the child and, on Windows, ask taskkill to
 * take down its whole process tree so no shell or tool subprocess is orphaned.
 * @param {import('node:child_process').ChildProcess | null} child - the spawned server process.
 */
function killServerTree(child) {
  if (child === null || child.exitCode !== null) return
  try { child.kill() } catch { /* already terminating */ }
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    }).unref()
  }
}

module.exports = {
  BOOT_MARKER,
  BOOT_TIMEOUT_MS,
  URL_LINE,
  findRepoRoot,
  killServerTree,
  loadConfig,
  probeBoot,
  resolveNode,
  startServer,
}
