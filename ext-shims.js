// Drift extension-API shims (main process).
//
// Backs ext-shim-preload.js: implements the chrome.* surface that
// electron-chrome-extensions@4.9 omits but side-panel/agentic extensions need —
// chrome.sidePanel, chrome.debugger (mapped onto Electron's native
// webContents.debugger), and chrome.identity.launchWebAuthFlow. Everything is
// scoped to the shared persist:drift session.
//
// IPC comes from two kinds of extension context and must be handled separately:
//   - chrome-extension:// frames  -> ipcMain.handle
//   - MV3 service workers         -> serviceWorker.ipc.handle (per worker)
// Events flow back the same way (frame.send / serviceWorker.send).

const { ipcMain, BrowserWindow } = require('electron')

const extIdFromUrl = (u) => {
  const m = /^chrome-extension:\/\/([a-p]{32})\b/.exec(String(u || ''))
  return m ? m[1] : null
}

function setupExtShims({ session, getWindow, sendUI, resolveTab, getManifest, listTabs }) {
  // An extension may only use debugger/identity if it declared the matching
  // permission — the same gate Chrome enforces (and Drift's install dialog already
  // discloses). Without this, any installed extension could silently drive full CDP
  // over every page (arbitrary JS, credential theft), which is unacceptable given
  // Drift's privacy stance.
  const hasPermission = (extId, perm) => {
    const man = getManifest(extId) || {}
    return Array.isArray(man.permissions) && man.permissions.includes(perm)
  }
  const requirePermission = (extId, perm) => {
    if (!hasPermission(extId, perm)) throw new Error(`"${perm}" permission is not declared in the manifest.`)
  }

  // Per-extension side-panel state.
  const panelOptions = new Map() // extId -> Map(tabId -> {path, enabled})
  const panelBehavior = new Map() // extId -> {openPanelOnActionClick}
  const optionsFor = (extId) => {
    let m = panelOptions.get(extId)
    if (!m) { m = new Map(); panelOptions.set(extId, m) }
    return m
  }
  const manifestPanelPath = (extId) => {
    const man = getManifest(extId) || {}
    return (man.side_panel && man.side_panel.default_path) ||
           (man.sidebar_action && man.sidebar_action.default_panel) || 'sidepanel.html'
  }

  // Debugger attachments we own. One record per tab id, with a SINGLE pair of
  // wc.debugger listeners (registered once, removed on detach) that broadcast to
  // every subscribed extension context. Replies are keyed by a stable sender key
  // so re-invocations replace rather than accumulate.
  const attached = new Map() // tabId -> { wc, replies:Map(key->fn), onMessage, onDetach }

  function ensureAttached(tabId, ctx) {
    const t = resolveTab(tabId)
    if (!t) throw new Error('No tab with given id ' + tabId)
    const wc = t.wc
    let rec = attached.get(tabId)
    if (!rec) {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
      const source = { tabId }
      rec = { wc, replies: new Map(), onMessage: null, onDetach: null }
      rec.onMessage = (_e, method, params) => {
        for (const reply of rec.replies.values()) reply('debugger.onEvent', [source, method, params])
      }
      rec.onDetach = (_e, reason) => {
        for (const reply of rec.replies.values()) reply('debugger.onDetach', [source, reason])
        teardownAttachment(tabId)
      }
      wc.debugger.on('message', rec.onMessage)
      wc.debugger.on('detach', rec.onDetach)
      attached.set(tabId, rec)
    }
    if (ctx) rec.replies.set(ctx.replyKey, ctx.reply)
    return rec
  }

  function teardownAttachment(tabId) {
    const rec = attached.get(tabId)
    if (!rec) return
    try {
      if (rec.onMessage) rec.wc.debugger.removeListener('message', rec.onMessage)
      if (rec.onDetach) rec.wc.debugger.removeListener('detach', rec.onDetach)
    } catch {}
    attached.delete(tabId)
  }

  const methods = {
    // ---- sidePanel ----
    'sidePanel.setOptions': (ctx, [options = {}]) => {
      if (options.tabId != null) {
        optionsFor(ctx.extId).set(options.tabId, { path: options.path, enabled: options.enabled !== false })
      } else if (options.path) {
        optionsFor(ctx.extId).set('*', { path: options.path, enabled: options.enabled !== false })
      }
      return {}
    },
    'sidePanel.getOptions': (ctx, [options = {}]) => {
      const m = optionsFor(ctx.extId)
      const o = (options.tabId != null && m.get(options.tabId)) || m.get('*') || {}
      return { tabId: options.tabId, path: o.path || manifestPanelPath(ctx.extId), enabled: o.enabled !== false }
    },
    // NOTE: openPanelOnActionClick is stored but not auto-honored — Drift can't tell
    // from the toolbar which extension's icon was clicked. Extensions that open their
    // panel from an action.onClicked listener work; ones that rely solely on this
    // flag won't auto-open on click. Tracked as a known limitation.
    'sidePanel.setPanelBehavior': (ctx, [behavior = {}]) => {
      panelBehavior.set(ctx.extId, { openPanelOnActionClick: !!behavior.openPanelOnActionClick })
      return {}
    },
    'sidePanel.getPanelBehavior': (ctx) => panelBehavior.get(ctx.extId) || { openPanelOnActionClick: false },
    'sidePanel.open': (ctx, [options = {}]) => openSidePanel(ctx.extId, options.tabId),

    // ---- debugger -> webContents.debugger (gated on the "debugger" permission) ----
    'debugger.attach': (ctx, [target = {}]) => {
      requirePermission(ctx.extId, 'debugger')
      ensureAttached(target.tabId, ctx)
      return {}
    },
    'debugger.detach': (ctx, [target = {}]) => {
      requirePermission(ctx.extId, 'debugger')
      const rec = attached.get(target.tabId)
      if (rec) {
        try { if (rec.wc.debugger.isAttached()) rec.wc.debugger.detach() } catch {}
        teardownAttachment(target.tabId)
      }
      return {}
    },
    'debugger.sendCommand': async (ctx, [target = {}, method, commandParams]) => {
      requirePermission(ctx.extId, 'debugger')
      // Route auto-attach through ensureAttached so events are still forwarded.
      const rec = ensureAttached(target.tabId, ctx)
      return await rec.wc.debugger.sendCommand(method, commandParams || {})
    },
    'debugger.getTargets': (ctx) => {
      requirePermission(ctx.extId, 'debugger')
      return (listTabs ? listTabs() : []).map(t => ({
        id: String(t.tabId), tabId: t.tabId, type: 'page',
        title: t.title || '', url: t.url || '', attached: attached.has(t.tabId)
      }))
    },

    // ---- identity (gated on the "identity" permission) ----
    'identity.launchWebAuthFlow': (ctx, [details = {}]) => {
      requirePermission(ctx.extId, 'identity')
      return launchWebAuthFlow(ctx.extId, details)
    },
    'identity.getAuthToken': (ctx) => { requirePermission(ctx.extId, 'identity'); throw new Error('getAuthToken is not supported') },
    'identity.removeCachedAuthToken': (ctx) => { requirePermission(ctx.extId, 'identity'); return {} }
  }

  async function dispatch(ctx, method, args) {
    const fn = methods[method]
    if (!fn) throw new Error('Unknown drift-crx method: ' + method)
    return await fn(ctx, args)
  }

  function openSidePanel(extId, tabId) {
    const t = tabId != null ? resolveTab(tabId) : null
    const m = optionsFor(extId)
    const opt = (tabId != null && m.get(tabId)) || m.get('*') || {}
    const path = opt.path || manifestPanelPath(extId)
    const url = `chrome-extension://${extId}/${String(path).replace(/^\//, '')}`
    sendUI('ext:openSidePanel', { extId, driftId: t ? t.driftId : null, tabId, url })
    return {}
  }

  // OAuth: load the auth URL in a popup window and resolve when it redirects to
  // the extension's chromiumapp.org redirect URL (Chrome's launchWebAuthFlow contract).
  function launchWebAuthFlow(extId, details) {
    return new Promise((resolve, reject) => {
      // Only http(s) auth endpoints — never let an extension point this at a
      // file:, chrome-extension:, or other privileged scheme.
      let scheme = ''
      try { scheme = new URL(details.url).protocol } catch {}
      if (!['http:', 'https:'].includes(scheme)) { reject(new Error('launchWebAuthFlow requires an http(s) URL.')); return }

      const redirectPrefix = `https://${extId}.chromiumapp.org/`
      const parent = getWindow()
      const win = new BrowserWindow({
        width: 480,
        height: 700,
        parent: parent && !parent.isDestroyed() ? parent : undefined,
        modal: !!(parent && details.interactive),
        show: !!details.interactive,
        title: 'Sign in',
        webPreferences: { session, sandbox: true, partition: 'persist:drift' }
      })
      let settled = false
      const finish = (fn, val) => {
        if (settled) return
        settled = true
        try { if (!win.isDestroyed()) win.destroy() } catch {}
        fn(val)
      }
      const check = (url) => {
        if (url && url.startsWith(redirectPrefix)) { finish(resolve, url); return true }
        return false
      }
      win.webContents.on('will-redirect', (_e, url) => check(url))
      win.webContents.on('will-navigate', (_e, url) => check(url))
      win.webContents.on('did-navigate', (_e, url) => check(url))
      win.on('closed', () => { if (!settled) { settled = true; reject(new Error('The user did not approve access.')) } })
      // Non-interactive flows must not hang forever if no redirect happens.
      if (!details.interactive) {
        setTimeout(() => finish(reject, new Error('User interaction required.')), 8000)
      }
      win.loadURL(details.url).catch(() => finish(reject, new Error('Auth page failed to load.')))
    })
  }

  // ---- IPC wiring ----
  const frameHandler = (event, method, ...args) => {
    const extId = extIdFromUrl(event.sender.getURL())
    if (!extId) throw new Error('Not an extension context')
    const replyKey = 'frame:' + event.sender.id
    const reply = (channel, payload) => { if (!event.sender.isDestroyed()) event.sender.send('drift-crx-event', channel, payload) }
    return dispatch({ extId, reply, replyKey }, method, args)
  }
  ipcMain.handle('drift-crx-rpc', frameHandler)

  // Service workers: attach a handler as each extension worker starts.
  session.serviceWorkers.on('running-status-changed', ({ runningStatus, versionId }) => {
    if (runningStatus !== 'starting') return
    let sw
    try { sw = session.serviceWorkers.getWorkerFromVersionID(versionId) } catch {}
    if (!sw || !sw.scope || !sw.scope.startsWith('chrome-extension://') || sw.__driftShimWired) return
    sw.__driftShimWired = true
    const extId = extIdFromUrl(sw.scope)
    const replyKey = 'sw:' + extId
    const reply = (channel, payload) => { try { sw.send('drift-crx-event', channel, payload) } catch {} }
    sw.ipc.handle('drift-crx-rpc', (_event, method, ...args) => dispatch({ extId, reply, replyKey }, method, args))
  })

  // Called by main once extensions are loaded: wake each service worker so its
  // event listeners (esp. action.onClicked, which side-panel extensions use to
  // open their panel) are registered before the user clicks.
  function warmServiceWorkers(extensions) {
    for (const e of extensions) {
      if (!e || !e.id) continue
      try { session.serviceWorkers.startWorkerForScope(`chrome-extension://${e.id}/`).catch(() => {}) } catch {}
    }
  }

  return { warmServiceWorkers }
}

module.exports = { setupExtShims, extIdFromUrl }
