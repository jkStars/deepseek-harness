'use strict'
/**
 * One-shot icon renderer: rasterize apps/web/public/favicon.svg to a 512x512
 * PNG (desktop/favicon.png) using an offscreen Electron window, then quit.
 * Run: node_modules\electron\dist\electron.exe render-icon.js
 */
const { app, BrowserWindow, nativeTheme } = require('electron')
const { writeFileSync } = require('node:fs')
const path = require('node:path')

const OUT = path.join(__dirname, 'favicon.png')
const PAGE = path.join(__dirname, 'icon-page.html')

app.disableHardwareAcceleration()
nativeTheme.themeSource = 'light' // the SVG's dark-mode path fill would turn the whale white

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: 512,
      height: 512,
      show: false,
      frame: false,
      transparent: true,
      webPreferences: { offscreen: true, backgroundThrottling: false },
    })
    await win.loadFile(PAGE)
    await new Promise((resolve) => setTimeout(resolve, 600))
    const image = await win.webContents.capturePage()
    const sized = image.getSize().width === 512 && image.getSize().height === 512
      ? image
      : image.resize({ width: 512, height: 512 })
    writeFileSync(OUT, sized.toPNG())
    console.log(`saved ${OUT} (${sized.getSize().width}x${sized.getSize().height})`)
    win.destroy()
  } catch (error) {
    console.error('render failed:', error)
    process.exitCode = 1
  }
  app.quit()
})
