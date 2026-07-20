// Drift — a spatial web browser.
// Main process: owns the window and one WebContentsView (a real Chromium page)
// per canvas card. The renderer is the canvas UI; it tells us where each live
// page should sit on screen and at what zoom, and we position the native views.

const { app, BrowserWindow, WebContentsView, ipcMain, Menu, shell, dialog, session, safeStorage } = require('electron')
const path = require('path')
const fs = require('fs')

// Widevine DRM (Netflix, Disney+, etc.) needs a Content Decryption Module that
// stock Electron doesn't ship. On the castlabs "Electron for Content Security"
// build, `components` downloads/loads the Widevine CDM on first launch and we must
// await it before opening any window. On stock Electron `components` is absent, so
// this is a no-op and DRM sites simply won't play. See DRM-SETUP.md to enable it.
let widevine = null
try { widevine = require('electron').components } catch {}

const SELFTEST = process.argv.includes('--selftest')
const PROMO = process.argv.includes('--promoshot') // staged canvas for marketing shots

// Last-resort net: an aborted streaming request (stop button / dock close) can
// reject deep in Chromium's stream plumbing where no local catch reaches. Log
// and move on rather than letting it surface as a scary unhandled-rejection
// warning (or crash the process under a stricter Node policy).
process.on('unhandledRejection', (reason) => {
  const msg = String((reason && reason.message) || reason || '')
  if (/abort/i.test(msg)) return // expected on stream cancellation
  console.log('[drift] unhandled rejection: ' + msg)
})

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
let ai = null // AI assistant hub (ai/index.js), wired in whenReady
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

  // If this view's webContents is destroyed out-of-band — an extension closing
  // its tab, an OAuth popup finishing (Google sign-in), a render-process kill —
  // drop it from `views` and detach it. Otherwise the layout/prezoom/raise loops
  // later dereference a view whose `.webContents` is now undefined and throw
  // ("Cannot read properties of undefined (reading 'isFocused')").
  wc.once('destroyed', () => {
    const m = views.get(id)
    if (m && m.attached && win && !win.isDestroyed()) { try { win.contentView.removeChildView(m.view) } catch {} }
    views.delete(id)
    if (topViewId === id) topViewId = null
    if (selectedExtWc === wc) selectedExtWc = null
  })
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
  // Playback state: the renderer skips thumbnail captures on cards that are
  // mid-playback, so periodic capturePage never causes a video frame hitch.
  wc.on('media-started-playing', () => emit('media', { playing: true }))
  wc.on('media-paused', () => emit('media', { playing: false }))

  // Links that want a new window/tab become child cards with a trail edge.
  // BUT a real popup (window.open with features) — an OAuth / "Continue with
  // Google" sign-in — needs a genuine window with a working window.opener so it
  // can postMessage the result back; a disconnected card can't, and Google logs
  // "Failed to open popup window" and the login errors out. Let popups open as a
  // transient child window; ordinary link/new-tab opens still become cards.
  wc.setWindowOpenHandler((details) => {
    if (details.disposition === 'new-window') {
      if (!safeUrl(details.url)) return { action: 'deny' }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 500, height: 650, resizable: true, minimizable: false, fullscreenable: false,
          title: 'Sign in',
          parent: win && !win.isDestroyed() ? win : undefined,
          webPreferences: { sandbox: true, partition: 'persist:drift' }
        }
      }
    }
    if (safeUrl(details.url)) emit('spawn', { url: details.url })
    return { action: 'deny' }
  })

  // Right-clicks inside the page open Drift's card menu (pages have no
  // default context menu of their own in Electron).
  wc.on('context-menu', (_e, params) => {
    emit('ctx', { x: params.x, y: params.y, linkURL: safeUrl(params.linkURL || '') })
  })

  // Escape must reach the canvas even while a page has keyboard focus
  // (menu accelerators can't claim plain Escape without breaking pages).
  wc.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      sendUI('ui:key', { key: 'escape' })
    }
  })
}

function createView(id, url, opts = {}) {
  const view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      partition: 'persist:drift'
    }
  })
  views.set(id, { view, attached: false, zoom: null, panel: !!opts.panel })
  wireView(id, view)
  // A side-panel card hosts an extension's own UI page; it isn't a browsable tab,
  // so don't register it with the extension system (keeps it out of chrome.tabs /
  // debugger.getTargets, where an agentic extension shouldn't see its own panel).
  if (!opts.panel) attachExtTab(view.webContents)
  view.webContents.loadURL(url).catch(() => {})
  return view
}

function destroyView(id) {
  const m = views.get(id)
  if (!m) return
  const wc = m.view.webContents
  // Same keyboard-theft guard as the layout detach: a focused page must hand
  // the keyboard back to the canvas before it disappears. wc may already be gone
  // (destroyed out-of-band, entry not yet reaped) — stay undefined-safe.
  const focused = wc && !wc.isDestroyed() && wc.isFocused()
  if (m.attached && win && !win.isDestroyed()) { try { win.contentView.removeChildView(m.view) } catch {} }
  if (topViewId === id) topViewId = null
  if (selectedExtWc === wc) selectedExtWc = null
  if (wc && !wc.isDestroyed()) wc.close()
  views.delete(id)
  if (focused && win && !win.isDestroyed()) win.webContents.focus()
}

// ---------- IPC ----------

ipcMain.handle('view:ensure', (_e, { id, url, opts }) => {
  if (typeof id !== 'string') return { ok: false }
  if (views.has(id)) return { ok: true, created: false }
  const u = viewUrl(url)
  if (!u) return { ok: false }
  createView(id, u, opts || {})
  return { ok: true, created: true }
})

ipcMain.handle('view:destroy', (_e, { id }) => { destroyView(id) })

ipcMain.handle('view:load', (_e, { id, url }) => {
  const m = views.get(id)
  const u = viewUrl(url)
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

// The send-style view channels move/stack native views — only the canvas
// renderer may drive them (session preloads mean page frames reach
// ipcRenderer too, so check the sender).
function fromCanvas(e) {
  return win && !win.isDestroyed() && e.sender === win.webContents
}

// Renderer sends the full set of live cards each frame; anything not listed
// gets detached (it keeps running in the background, like an unfocused tab).
ipcMain.on('view:layout', (e, { zoom, items }) => {
  if (!fromCanvas(e) || !Array.isArray(items)) return
  const z = clampZoom(Number(zoom) || 1)
  const seen = new Set()
  let attachedAny = false
  for (const it of items) {
    const m = views.get(it.id)
    if (!m) continue
    const wc = m.view.webContents
    if (!wc || wc.isDestroyed()) continue // torn down mid-frame; the detach loop cleans it up
    seen.add(it.id)
    if (!m.attached) { win.contentView.addChildView(m.view); m.attached = true; topViewId = it.id; attachedAny = true }
    // setBounds forces a compositor re-commit even for identical values, which
    // costs frames while a video plays — only call it when something moved.
    const b = {
      x: Math.round(it.x),
      y: Math.round(it.y),
      width: Math.max(1, Math.round(it.w)),
      height: Math.max(1, Math.round(it.h))
    }
    const lb = m.bounds
    if (!lb || lb.x !== b.x || lb.y !== b.y || lb.width !== b.width || lb.height !== b.height) {
      m.view.setBounds(b)
      m.bounds = b
    }
    // Content zoom must track the scaled bounds every frame, or pages look
    // mis-scaled mid-animation (focus in/out, pinch).
    if (m.zoom === null || Math.abs(m.zoom - z) > 0.001) {
      wc.setZoomFactor(z)
      m.zoom = z
    }
  }
  for (const [id, m] of views) {
    if (!seen.has(id) && m.attached) {
      // A page that keeps keyboard focus while hidden swallows every keystroke
      // (Escape "dies" after panning away from a focused page) — hand the
      // keyboard back to the canvas before hiding it. Guard the webContents: it
      // can be undefined if the view was destroyed out-of-band and this layout
      // pass raced the 'destroyed' cleanup above.
      const wc = m.view.webContents
      const focused = wc && !wc.isDestroyed() && wc.isFocused()
      try { win.contentView.removeChildView(m.view) } catch {}
      m.attached = false
      if (focused) win.webContents.focus()
    }
  }
  // Freshly attached page views land above the AI dock — bump it back on top.
  if (attachedAny && ai) ai.ensureOnTop()
})

// Which view sits on top of the native stack; raising it again would be a
// pointless compositor re-commit (mousedown fires a raise on every click).
let topViewId = null

ipcMain.on('view:raise', (e, id) => {
  if (!fromCanvas(e)) return
  const m = views.get(id)
  if (!m) return
  const wc = m.view.webContents
  if (!wc || wc.isDestroyed()) return // view torn down; nothing to raise
  // Re-adding an attached view bumps it to the top of the stack.
  if (m.attached && win && !win.isDestroyed() && topViewId !== id) {
    win.contentView.addChildView(m.view)
    topViewId = id
    if (ai) ai.ensureOnTop() // the AI dock stays above raised pages
  }
  // Tell the extension system this is the active tab, so its action icons update.
  selectExtTab(wc)
})

// A zoom animation is about to land at a known final zoom: apply the zoom
// factor now, while the views are detached behind their snapshots, so pages
// relayout during the animation instead of visibly popping at the end.
// id '*' pre-zooms every view (the renderer can't know which will land live).
ipcMain.on('view:prezoom', (e, { id, zoom }) => {
  if (!fromCanvas(e)) return
  const z = clampZoom(Number(zoom) || 1)
  const targets = id === '*' ? [...views.values()] : views.has(id) ? [views.get(id)] : []
  for (const m of targets) {
    const wc = m.view.webContents
    if (!wc || wc.isDestroyed()) continue
    if (m.zoom === null || Math.abs(m.zoom - z) > 0.001) {
      wc.setZoomFactor(z)
      m.zoom = z
    }
  }
})

ipcMain.handle('view:snapshot', async (_e, { id, width }) => {
  const m = views.get(id)
  if (!m || !m.attached) return null
  try {
    const img = await m.view.webContents.capturePage()
    if (img.isEmpty()) return null
    const w = Math.min(1600, Math.max(80, Number(width) || 480))
    // resize + encode run synchronously on the main process, which is also
    // Chromium's UI thread — every ms here is a hitch in ALL views (worst
    // while a video plays). 'good' (box filter) over the default lanczos, and
    // JPEG over PNG: ~5x faster to encode and ~4x smaller in the state file.
    return 'data:image/jpeg;base64,' +
      img.resize({ width: w, quality: 'good' }).toJPEG(72).toString('base64')
  } catch { return null }
})

// State payloads carry thumbnail images and can reach several MB; a sync
// write here stalls the main process and shows up as scroll jank. Write
// async, coalescing to the latest payload if saves arrive faster than disk.
// Write to a temp file then rename: writeFile truncates on open, so an
// interrupted direct write (crash, kill, power loss, quit race) would leave
// drift-state.json half-written — state:load then returns null and the
// renderer falls back to firstRun(), silently wiping the user's whole canvas.
// rename is atomic, so the live file is always either fully old or fully new.
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
      const f = stateFile()
      const tmp = f + '.' + process.pid + '.tmp'
      try {
        await fs.promises.writeFile(tmp, JSON.stringify(data))
        await fs.promises.rename(tmp, f)
      } catch { try { await fs.promises.unlink(tmp) } catch {} }
    }
    savingState = false
  })()
})

ipcMain.handle('state:load', () => {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) } catch (err) {
    // A parse failure means an old truncated file from before atomic writes.
    // Preserve it (once) instead of letting the next save overwrite it with
    // the demo canvas — a corrupt file is still a recovery artifact.
    try {
      const f = stateFile()
      if (fs.existsSync(f)) fs.renameSync(f, f.replace(/\.json$/, '') + '.corrupt.json')
    } catch {}
    return null
  }
})

// ---------- bookmarks ----------
// Stored in their own file so they survive independently of the canvas state.

const bookmarksFile = () => path.join(app.getPath('userData'), 'drift-bookmarks.json')

ipcMain.handle('bookmarks:load', () => {
  try { return JSON.parse(fs.readFileSync(bookmarksFile(), 'utf8')) } catch { return null }
})

ipcMain.handle('bookmarks:save', (_e, data) => {
  if (SELFTEST || PROMO) return
  if (data == null || typeof data !== 'object') return
  try { fs.writeFileSync(bookmarksFile(), JSON.stringify(data)) } catch {}
})

// Export/import bookmarks as a standard Netscape HTML file (the format every
// browser reads and writes). The renderer builds/parses the HTML; main only
// runs the save/open dialog and touches the file.
ipcMain.handle('bookmarks:export', async (_e, html) => {
  if (typeof html !== 'string') return { ok: false }
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export bookmarks',
    defaultPath: 'drift-bookmarks.html',
    filters: [{ name: 'HTML', extensions: ['html'] }]
  })
  if (canceled || !filePath) return { ok: false }
  try { fs.writeFileSync(filePath, html); return { ok: true } } catch { return { ok: false } }
})

ipcMain.handle('bookmarks:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import bookmarks',
    properties: ['openFile'],
    filters: [{ name: 'Bookmark HTML', extensions: ['html', 'htm'] }]
  })
  if (canceled || !filePaths || !filePaths[0]) return null
  try { return fs.readFileSync(filePaths[0], 'utf8') } catch { return null }
})

// ---------- settings ----------
// Small per-user preferences file (currently just the background choice).

const settingsFile = () => path.join(app.getPath('userData'), 'drift-settings.json')

function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) } catch { return {} }
}
function writeSettings(s) {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(s)) } catch {}
}

ipcMain.handle('settings:load', () => readSettings())
ipcMain.handle('settings:save', (_e, s) => {
  if (SELFTEST || PROMO) return
  if (s && typeof s === 'object') writeSettings(s)
})

// ---------- extensions ----------
// Real Chrome extensions via electron-chrome-extensions + electron-chrome-web-store.
// Everything runs in the shared persist:drift session, so an extension installed
// once applies to every card (tab). Action icons render in the canvas toolbar as
// <browser-action-list> and reflect the focused card.

const { ElectronChromeExtensions } = require('electron-chrome-extensions')
const { installChromeWebStore, uninstallExtension } = require('electron-chrome-web-store')
const { setupExtShims } = require('./ext-shims')

const driftSession = () => session.fromPartition('persist:drift')
let extensions = null
let extShims = null

// Map a card's extension tab id (its webContents.id) back to the Drift card + view.
function resolveTab(tabId) {
  for (const [id, m] of views) {
    const wc = m.view.webContents
    if (!wc.isDestroyed() && wc.id === tabId) return { wc, driftId: id, view: m.view }
  }
  return null
}

// Extension manifest (for a side panel's default_path, etc.).
function extManifest(extId) {
  try {
    const e = driftSession().extensions.getExtension(extId)
    return e && e.manifest
  } catch { return null }
}

// The set of live card pages, as chrome.debugger-style targets.
function listExtTabs() {
  const out = []
  for (const [, m] of views) {
    const wc = m.view.webContents
    if (wc.isDestroyed()) continue
    out.push({ tabId: wc.id, title: wc.getTitle(), url: wc.getURL() })
  }
  return out
}

// A card may host an installed extension's own page (a side panel). Allow those
// URLs in addition to http(s) when creating/navigating a view.
function isInstalledExtUrl(u) {
  const m = /^chrome-extension:\/\/([a-p]{32})\//.exec(String(u || ''))
  if (!m) return null
  try {
    const found = driftSession().extensions.getAllExtensions().some(e => e.id === m[1])
    return found ? String(u) : null
  } catch { return null }
}
function viewUrl(u) { return safeUrl(u) || isInstalledExtUrl(u) }

// Map a webContents back to the card id the renderer knows it by.
function idOfWebContents(wc) {
  for (const [id, m] of views) if (m.view.webContents === wc) return id
  return null
}

async function setupExtensions() {
  const s = driftSession()
  try { ElectronChromeExtensions.handleCRXProtocol(s) } catch {}

  // Register the chrome.* shim preload BEFORE constructing the library, so it runs
  // first in each extension context and its additions survive the library freezing
  // `chrome`. It injects for extension frames and MV3 service workers.
  // The file is asarUnpack'd, so in a packaged build point at the real unpacked copy
  // rather than the app.asar path (preloads must load from the filesystem).
  let shimPath = path.join(__dirname, 'ext-shim-preload.js')
  if (shimPath.includes(`app.asar${path.sep}`)) {
    shimPath = shimPath.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
  }
  if (!fs.existsSync(shimPath)) console.log('[drift] ext shim preload missing at ' + shimPath)
  try {
    if (typeof s.registerPreloadScript === 'function') {
      s.registerPreloadScript({ id: 'drift-ext-shim-frame', type: 'frame', filePath: shimPath })
      s.registerPreloadScript({ id: 'drift-ext-shim-sw', type: 'service-worker', filePath: shimPath })
    } else {
      s.setPreloads([shimPath, ...s.getPreloads()])
    }
  } catch (err) { console.log('[drift] ext shim preload registration failed: ' + err.message) }

  extShims = setupExtShims({
    session: s,
    getWindow: () => win,
    sendUI,
    resolveTab,
    getManifest: extManifest,
    listTabs: listExtTabs
  })

  extensions = new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session: s,
    // An extension opened a new tab: make a Drift card that adopts the view.
    createTab: async (details) => {
      const id = 'x' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36)
      const view = new WebContentsView({ webPreferences: { sandbox: true, partition: 'persist:drift' } })
      views.set(id, { view, attached: false, zoom: null })
      wireView(id, view)
      try { extensions.addTab(view.webContents, win) } catch {}
      const u = safeUrl(details.url || '')
      if (u) view.webContents.loadURL(u).catch(() => {})
      sendUI('ext:adoptTab', { id, url: details.url || '' })
      return [view.webContents, win]
    },
    selectTab: (tab) => {
      // The library changed its own active tab (e.g. chrome.tabs.update):
      // keep the dedupe cache honest so the next user click isn't skipped.
      selectedExtWc = tab
      const id = idOfWebContents(tab)
      if (id) sendUI('ext:selectTab', { id })
    },
    removeTab: (tab) => {
      const id = idOfWebContents(tab)
      if (id) sendUI('ext:removeTab', { id })
    }
  })

  // Cards restored at boot can create their views before this setup finishes,
  // so attachExtTab was a no-op for them — register every existing view now,
  // then tell the renderer the extension system is live so it can mount the
  // per-card action rows.
  for (const [, m] of views) { try { extensions.addTab(m.view.webContents, win) } catch {} }
  sendUI('ext:ready')

  // Enable Chrome Web Store install (with a permission confirmation) and load
  // any previously installed extensions.
  try {
    await installChromeWebStore({
      session: s,
      loadExtensions: true,
      async beforeInstall(details) {
        if (!details.browserWindow || details.browserWindow.isDestroyed()) return { action: 'allow' }
        const m = details.manifest || {}
        // Disclose ALL of an extension's reach, not just classic permissions:
        // host_permissions and content-script match patterns are what actually
        // let it read/change the pages you visit — and every Drift tab shares
        // one session, so broad access touches every site at once.
        const hosts = [
          ...(Array.isArray(m.host_permissions) ? m.host_permissions : []),
          ...((Array.isArray(m.content_scripts) ? m.content_scripts : [])
            .flatMap(cs => Array.isArray(cs.matches) ? cs.matches : []))
        ]
        const uniqHosts = [...new Set(hosts)]
        const broad = uniqHosts.some(h => /<all_urls>|:\/\/\*\/|\*:\/\/\*/.test(h))
        const perms = (Array.isArray(m.permissions) ? m.permissions : []).filter(p => typeof p === 'string')
        const lines = []
        if (broad) lines.push('⚠ This extension can read and change data on EVERY site you visit — across all your tabs.')
        else if (uniqHosts.length) lines.push('Runs on: ' + uniqHosts.slice(0, 8).join(', ') + (uniqHosts.length > 8 ? ' …' : ''))
        if (perms.length) lines.push('Permissions: ' + perms.slice(0, 12).join(', ') + (perms.length > 12 ? ' …' : ''))
        if (!lines.length) lines.push('It applies to every tab.')
        const r = await dialog.showMessageBox(details.browserWindow, {
          type: broad ? 'warning' : 'question',
          title: 'Add extension',
          message: `Add “${details.localizedName}” to Drift?`,
          detail: lines.join('\n\n'),
          icon: details.icon,
          buttons: ['Cancel', 'Add Extension'],
          // Broad-reach extensions default to Cancel so the risky choice is deliberate.
          defaultId: broad ? 0 : 1,
          cancelId: 0
        })
        return { action: r.response === 1 ? 'allow' : 'deny' }
      }
    })
  } catch (err) {
    console.log('[drift] web store setup failed: ' + err.message)
  }

  // Wake each extension's MV3 service worker so its event listeners (notably
  // action.onClicked, which side-panel extensions use to open their panel) are
  // registered before the user clicks — the library otherwise drops a click that
  // arrives before any listener exists.
  try {
    const all = s.extensions.getAllExtensions().filter(e => e && e.id)
    if (extShims) extShims.warmServiceWorkers(all)
  } catch {}
}

// Register a card's page with the extension system so chrome.tabs sees it.
function attachExtTab(wc) {
  if (extensions) { try { extensions.addTab(wc, win) } catch {} }
}
// Re-selecting the already-selected tab would fan tabs.onActivated out to
// every extension service worker on every click — notify only real changes.
let selectedExtWc = null
function selectExtTab(wc) {
  if (!extensions || !wc || wc === selectedExtWc) return
  selectedExtWc = wc
  try { extensions.selectTab(wc) } catch {}
}

// The renderer pins each card's <browser-action-list> to that card's tab id
// (its webContents id), so extension clicks/badges act on that page rather
// than whichever card is active.
ipcMain.handle('ext:tabId', (_e, { id }) => {
  const m = views.get(id)
  const wc = m && m.view.webContents
  return wc && !wc.isDestroyed() ? wc.id : null
})

ipcMain.handle('ext:isReady', () => !!extensions)

ipcMain.handle('ext:list', () => {
  try {
    return driftSession().extensions.getAllExtensions()
      .filter(e => e.id) // hide the internal web-store helper if present
      .map(e => ({ id: e.id, name: e.name, version: e.manifest && e.manifest.version }))
  } catch { return [] }
})

// Open the Chrome Web Store as a card so the user can browse & install.
ipcMain.handle('ext:openStore', () => {
  sendUI('view:spawnUrl', { url: 'https://chromewebstore.google.com/' })
  return { ok: true }
})

ipcMain.handle('ext:remove', async (_e, id) => {
  try { await uninstallExtension(id, { session: driftSession() }) }
  catch { try { driftSession().extensions.removeExtension(id) } catch {} }
  for (const [, m] of views) { try { m.view.webContents.reload() } catch {} }
  return { ok: true }
})

// ---------- password vault ----------
// The renderer does all crypto (Web Crypto): the main process only ever stores
// an opaque encrypted blob, and never sees a plaintext password.

const vaultFile = () => path.join(app.getPath('userData'), 'drift-vault.json')

ipcMain.handle('vault:load', () => {
  try { return JSON.parse(fs.readFileSync(vaultFile(), 'utf8')) } catch { return null }
})

ipcMain.handle('vault:save', (_e, blob) => {
  if (SELFTEST || PROMO) return
  if (!blob || typeof blob !== 'object') return
  try { fs.writeFileSync(vaultFile(), JSON.stringify(blob)) } catch {}
})

// Fill a saved login into a live card's page. Best-effort: fills the first
// password field and the nearest username/email field before it.
ipcMain.handle('vault:fill', async (_e, { id, username, password }) => {
  const m = views.get(id)
  if (!m || typeof username !== 'string' || typeof password !== 'string') return { ok: false }
  const script = `(() => {
    try {
      const U = ${JSON.stringify(username)}, P = ${JSON.stringify(password)};
      const set = (el, v) => {
        const proto = Object.getPrototypeOf(el);
        const d = Object.getOwnPropertyDescriptor(proto, 'value');
        d && d.set ? d.set.call(el, v) : (el.value = v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const pw = document.querySelector('input[type=password]');
      if (!pw) return 'nopw';
      set(pw, P);
      const inputs = [...document.querySelectorAll('input')];
      const idx = inputs.indexOf(pw);
      let user = null;
      for (let i = idx - 1; i >= 0; i--) {
        const t = (inputs[i].type || '').toLowerCase();
        if (['text','email','tel','',null].includes(t)) { user = inputs[i]; break; }
      }
      if (user) set(user, U);
      pw.focus();
      return 'ok';
    } catch (e) { return 'err:' + e.message; }
  })()`
  try {
    const res = await m.view.webContents.executeJavaScript(script, true)
    return { ok: res === 'ok', detail: res }
  } catch (e) { return { ok: false, detail: String(e && e.message) } }
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

// Promo shots only: strip consent/cookie overlays from the staged pages so
// captures show content, not banners. Registered exclusively in --promoshot
// runs against the throwaway profile — never in a normal session.
if (PROMO) {
  ipcMain.handle('promo:clean', async () => {
    const script = `(() => {
      try {
        const rx = /onetrust|cookie|consent|gdpr|truste|didomi|sp_message/i
        for (const el of Array.from(document.querySelectorAll('div,section,aside,dialog,iframe'))) {
          const key = (el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '') + ' ' + (el.getAttribute('data-uia') || '')
          if (rx.test(key)) el.remove()
        }
        document.documentElement.style.overflow = ''
        if (document.body) document.body.style.overflow = ''
      } catch {}
      return true
    })()`
    for (const [, m] of views) {
      try { await m.view.webContents.executeJavaScript(script, true) } catch {}
    }
    return { ok: true }
  })
}

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
      preload: path.join(__dirname, 'preload.js'),
      // Trusted local UI. sandbox:false lets the preload require the
      // browser-action module that injects the extension icon element.
      sandbox: false
    }
  })
  // The canvas renderer is the layout engine for every native page view — its
  // rAF loop positions/attaches them. Occlusion throttling would stall that
  // while the window is hidden, so an assistant action (present_card) could
  // "succeed" against a view stuck at 0×0. The canvas idles when nothing is
  // scheduled, so keeping it unthrottled costs nothing.
  win.webContents.setBackgroundThrottling(false)
  win.loadFile('renderer/index.html', {
    query: SELFTEST ? { selftest: '1' }
      : PROMO ? { promo: '1', scene: process.env.DRIFT_PROMO_SCENE || 'biology' }
      : {}
  })
  win.on('closed', () => { win = null })
}

// Hard rule for every webContents in the app: pages may only navigate to
// http(s); the canvas renderer may not navigate anywhere at all.
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-navigate', (e, url) => {
    if (win && wc === win.webContents) { e.preventDefault(); return }
    // Pages stay on http(s); extension surfaces (popups, options) need their
    // own protocols, so allow those too.
    let proto = ''
    try { proto = new URL(url).protocol } catch {}
    if (!['http:', 'https:', 'chrome-extension:', 'devtools:'].includes(proto)) e.preventDefault()
  })
})

app.whenReady().then(async () => {
  // The time-machine history log was removed in v0.2.1 — clear any file a
  // previous build left behind.
  fs.promises.rm(path.join(app.getPath('userData'), 'drift-history.json'), { force: true }).catch(() => {})
  // Load the Widevine CDM (castlabs build only) before any page can request it,
  // so the first Netflix/Disney+ card doesn't race a missing decryption module.
  if (widevine && !SELFTEST && !PROMO) {
    try {
      await widevine.whenReady()
      let status = 'ok'
      try { status = widevine.status ? JSON.stringify(widevine.status()) : 'ok' } catch {}
      console.log('[drift] Widevine ready: ' + status)
    } catch (err) { console.log('[drift] Widevine load failed: ' + err.message) }
  }
  buildMenu()
  createWindow()
  // AI assistant hub. Runs in selftest too (with the offline mock provider),
  // so the agent spine gets exercised by the standard gate.
  if (SELFTEST) process.env.DRIFT_AI_MOCK = '1'
  try {
    const { setupAI } = require('./ai')
    ai = setupAI({
      app, ipcMain, safeStorage, shell, WebContentsView,
      getWindow: () => win,
      views, sendUI, fromCanvas,
      headless: SELFTEST || PROMO,
      selftest: SELFTEST
    })
  } catch (err) { console.log('[drift] ai setup: ' + err.message) }
  // Set up the extension system + Chrome Web Store (skipped in headless runs).
  if (!SELFTEST && !PROMO) { setupExtensions().catch(err => console.log('[drift] ext setup: ' + err.message)) }
  checkForUpdates()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { app.quit() })
