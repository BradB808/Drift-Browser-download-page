// Drift — a spatial web browser.
// Main process: owns the window and one WebContentsView (a real Chromium page)
// per canvas card. The renderer is the canvas UI; it tells us where each live
// page should sit on screen and at what zoom, and we position the native views.

const { app, BrowserWindow, WebContentsView, ipcMain, Menu, shell } = require('electron')
const path = require('path')
const fs = require('fs')

const SELFTEST = process.argv.includes('--selftest')
const PROMO = process.argv.includes('--promoshot') // staged canvas for marketing shots

// Keep selftest/promo runs out of the real profile so the user's canvas is
// never touched.
if (SELFTEST || PROMO) {
  app.setPath('userData', path.join(app.getPath('temp'), 'drift-selftest-profile'))
}

// Some sites block anything advertising Electron in the UA; present as plain Chrome.
app.userAgentFallback = app.userAgentFallback
  .replace(/\sdrift-browser\/[\d.]+/, '')
  .replace(/\sElectron\/[\d.]+/, '')

let win = null
const views = new Map() // id -> { view, attached, zoom }

const stateFile = () => path.join(app.getPath('userData'), 'drift-state.json')

function safeUrl(u) {
  try {
    const p = new URL(u)
    return ['http:', 'https:'].includes(p.protocol) ? p.href : null
  } catch { return null }
}

function clampZoom(z) { return Math.min(5, Math.max(0.25, z)) }

function sendUI(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function wireView(id, view) {
  const wc = view.webContents
  const emit = (type, payload = {}) => sendUI('view:event', { id, type, ...payload })
  const navState = () => {
    const h = wc.navigationHistory
    return { canGoBack: h.canGoBack(), canGoForward: h.canGoForward() }
  }

  wc.on('page-title-updated', (_e, title) => emit('title', { title }))
  wc.on('page-favicon-updated', (_e, favicons) => {
    if (favicons && favicons.length) emit('favicon', { favicon: favicons[0] })
  })
  wc.on('did-navigate', (_e, url) => emit('url', { url, ...navState() }))
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (isMainFrame) emit('url', { url, ...navState() })
  })
  wc.on('did-start-loading', () => emit('loading', { loading: true }))
  wc.on('did-stop-loading', () => emit('loading', { loading: false }))
  wc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) emit('fail', { desc: desc || ('error ' + code) })
  })
  wc.on('focus', () => emit('focus'))

  // Links that want a new window/tab become child cards with a trail edge instead.
  wc.setWindowOpenHandler(({ url }) => {
    if (safeUrl(url)) emit('spawn', { url })
    return { action: 'deny' }
  })

  // Escape must reach the canvas even while a page has keyboard focus
  // (menu accelerators can't claim plain Escape without breaking pages).
  wc.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      sendUI('ui:key', { key: 'escape' })
    }
  })
}

function createView(id, url) {
  const view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      partition: 'persist:drift'
    }
  })
  views.set(id, { view, attached: false, zoom: null })
  wireView(id, view)
  view.webContents.loadURL(url).catch(() => {})
  return view
}

function destroyView(id) {
  const m = views.get(id)
  if (!m) return
  if (m.attached && win && !win.isDestroyed()) win.contentView.removeChildView(m.view)
  m.view.webContents.close()
  views.delete(id)
}

// ---------- IPC ----------

ipcMain.handle('view:ensure', (_e, { id, url }) => {
  if (typeof id !== 'string') return { ok: false }
  if (views.has(id)) return { ok: true, created: false }
  const u = safeUrl(url)
  if (!u) return { ok: false }
  createView(id, u)
  return { ok: true, created: true }
})

ipcMain.handle('view:destroy', (_e, { id }) => { destroyView(id) })

ipcMain.handle('view:load', (_e, { id, url }) => {
  const m = views.get(id)
  const u = safeUrl(url)
  if (m && u) m.view.webContents.loadURL(u).catch(() => {})
})

ipcMain.handle('view:nav', (_e, { id, action }) => {
  const m = views.get(id)
  if (!m) return
  const wc = m.view.webContents
  const h = wc.navigationHistory
  if (action === 'back' && h.canGoBack()) h.goBack()
  else if (action === 'forward' && h.canGoForward()) h.goForward()
  else if (action === 'reload') wc.reload()
  else if (action === 'stop') wc.stop()
})

// Renderer sends the full set of live cards each frame; anything not listed
// gets detached (it keeps running in the background, like an unfocused tab).
ipcMain.on('view:layout', (_e, { zoom, items }) => {
  if (!win || win.isDestroyed() || !Array.isArray(items)) return
  const z = clampZoom(Number(zoom) || 1)
  const seen = new Set()
  for (const it of items) {
    const m = views.get(it.id)
    if (!m) continue
    seen.add(it.id)
    if (!m.attached) { win.contentView.addChildView(m.view); m.attached = true }
    m.view.setBounds({
      x: Math.round(it.x),
      y: Math.round(it.y),
      width: Math.max(1, Math.round(it.w)),
      height: Math.max(1, Math.round(it.h))
    })
    // Content zoom must track the scaled bounds every frame, or pages look
    // mis-scaled mid-animation (focus in/out, pinch).
    if (m.zoom === null || Math.abs(m.zoom - z) > 0.001) {
      m.view.webContents.setZoomFactor(z)
      m.zoom = z
    }
  }
  for (const [id, m] of views) {
    if (!seen.has(id) && m.attached) {
      win.contentView.removeChildView(m.view)
      m.attached = false
    }
  }
})

ipcMain.on('view:raise', (_e, id) => {
  const m = views.get(id)
  // Re-adding an attached view bumps it to the top of the stack.
  if (m && m.attached && win && !win.isDestroyed()) win.contentView.addChildView(m.view)
})

ipcMain.handle('view:snapshot', async (_e, { id, width }) => {
  const m = views.get(id)
  if (!m || !m.attached) return null
  try {
    const img = await m.view.webContents.capturePage()
    if (img.isEmpty()) return null
    const w = Math.min(1600, Math.max(80, Number(width) || 480))
    return img.resize({ width: w }).toDataURL()
  } catch { return null }
})

// State payloads carry thumbnail images and can reach several MB; a sync
// write here stalls the main process and shows up as scroll jank. Write
// async, coalescing to the latest payload if saves arrive faster than disk.
let savingState = false
let pendingState = null
ipcMain.handle('state:save', (_e, json) => {
  if (SELFTEST || PROMO) return
  pendingState = json
  if (savingState) return
  savingState = true
  ;(async () => {
    while (pendingState) {
      const data = pendingState
      pendingState = null
      try { await fs.promises.writeFile(stateFile(), JSON.stringify(data)) } catch {}
    }
    savingState = false
  })()
})

ipcMain.handle('state:load', () => {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) } catch { return null }
})

// ---------- bookmarks ----------
// Stored in their own file so they survive independently of the canvas state.

const bookmarksFile = () => path.join(app.getPath('userData'), 'drift-bookmarks.json')

ipcMain.handle('bookmarks:load', () => {
  try {
    const a = JSON.parse(fs.readFileSync(bookmarksFile(), 'utf8'))
    return Array.isArray(a) ? a : []
  } catch { return [] }
})

ipcMain.handle('bookmarks:save', (_e, arr) => {
  if (!Array.isArray(arr)) return
  try { fs.writeFileSync(bookmarksFile(), JSON.stringify(arr.slice(0, 500))) } catch {}
})

// ---------- update notice ----------
// Quiet check against GitHub Releases a few seconds after launch. If a newer
// version exists, the renderer shows a pill linking to the download page.

const UPDATE_REPO = 'BradB808/Drift-Browser-download-page'
const DOWNLOAD_PAGE = 'https://driftwebbrowser.com/'

function isNewerVersion(a, b) { // a > b, "x.y.z"
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true
    if ((pa[i] || 0) < (pb[i] || 0)) return false
  }
  return false
}

function checkForUpdates() {
  if (SELFTEST || PROMO) return
  const force = process.env.DRIFT_UPDATE_TEST === '1'
  setTimeout(async () => {
    try {
      const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
        headers: { 'User-Agent': 'drift-browser', Accept: 'application/vnd.github+json' }
      })
      if (!res.ok) return
      const rel = await res.json()
      const latest = String(rel.tag_name || '').replace(/^v/, '')
      if (force || (latest && isNewerVersion(latest, app.getVersion()))) {
        sendUI('update:available', { version: latest || app.getVersion() })
      }
    } catch {} // offline is fine — try again next launch
  }, force ? 1500 : 6000)
}

ipcMain.handle('update:open', () => shell.openExternal(DOWNLOAD_PAGE))

// ---------- Selftest plumbing ----------

const selftestDir = process.env.DRIFT_SELFTEST_DIR || path.join(app.getPath('temp'), 'drift-selftest')

ipcMain.handle('selftest:artifact', (_e, { name, dataUrl }) => {
  const m = /^data:image\/(?:png|jpeg);base64,(.+)$/.exec(dataUrl || '')
  if (!m || !/^[\w.-]+$/.test(name)) return null
  fs.mkdirSync(selftestDir, { recursive: true })
  const p = path.join(selftestDir, name)
  fs.writeFileSync(p, Buffer.from(m[1], 'base64'))
  return p
})

ipcMain.handle('selftest:done', async (_e, report) => {
  try {
    fs.mkdirSync(selftestDir, { recursive: true })
    const img = await win.webContents.capturePage()
    fs.writeFileSync(path.join(selftestDir, 'selftest-canvas.png'), img.toPNG())
    fs.writeFileSync(path.join(selftestDir, 'report.json'), JSON.stringify(report, null, 2))
  } catch (err) {
    report = report || {}
    report.errors = [...(report.errors || []), 'capture failed: ' + err.message]
  }
  console.log('[selftest] report ' + JSON.stringify(report))
  console.log('[selftest] artifacts in ' + selftestDir)
  const code = report && report.errors && report.errors.length ? 1 : 0
  setTimeout(() => app.exit(code), 400)
})

// ---------- Window / app lifecycle ----------

function buildMenu() {
  const key = k => () => { if (win) { win.webContents.focus(); sendUI('ui:key', { key: k }) } }
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Card', accelerator: 'CmdOrCtrl+T', click: key('newcard') },
        { label: 'New Zone', accelerator: 'Shift+CmdOrCtrl+N', click: key('newzone') },
        { label: 'Reopen Closed Card', click: key('reopen') },
        { label: 'Close Card', accelerator: 'CmdOrCtrl+W', click: key('closecard') },
        { type: 'separator' },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Edit Address', accelerator: 'CmdOrCtrl+L', click: key('address') },
        { label: 'Reload Page', accelerator: 'CmdOrCtrl+R', click: key('reloadcard') },
        { type: 'separator' },
        { label: 'Find on Canvas', accelerator: 'CmdOrCtrl+F', click: key('search') },
        { label: 'Tidy Canvas', accelerator: 'Shift+CmdOrCtrl+T', click: key('tidy') },
        { label: 'Show Walkthrough', click: key('tour') },
        { type: 'separator' },
        { label: 'Fit Canvas', accelerator: 'CmdOrCtrl+0', click: key('fit') },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: key('zoomin') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: key('zoomout') },
        { type: 'separator' },
        {
          label: 'Canvas DevTools',
          accelerator: 'Alt+CmdOrCtrl+I',
          click: () => { if (win) win.webContents.openDevTools({ mode: 'detach' }) }
        }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 560,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0b0d12',
    title: 'Drift',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  })
  win.loadFile('renderer/index.html', { query: SELFTEST ? { selftest: '1' } : PROMO ? { promo: '1' } : {} })
  win.on('closed', () => { win = null })
}

// Hard rule for every webContents in the app: pages may only navigate to
// http(s); the canvas renderer may not navigate anywhere at all.
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-navigate', (e, url) => {
    if (win && wc === win.webContents) { e.preventDefault(); return }
    if (!safeUrl(url)) e.preventDefault()
  })
})

app.whenReady().then(() => {
  // The time-machine history log was removed in v0.2.1 — clear any file a
  // previous build left behind.
  fs.promises.rm(path.join(app.getPath('userData'), 'drift-history.json'), { force: true }).catch(() => {})
  buildMenu()
  createWindow()
  checkForUpdates()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { app.quit() })
