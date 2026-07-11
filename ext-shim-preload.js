// Drift extension-API shim preload.
//
// electron-chrome-extensions@4.9 implements only a subset of chrome.*. Side-panel
// extensions (e.g. the official Claude extension) render their whole UI through
// chrome.sidePanel and drive pages through chrome.debugger — neither of which the
// library provides, so out of the box such an extension installs but does nothing.
//
// This preload runs in every extension context (MV3 service worker + chrome-extension://
// pages). It adds the missing APIs to `chrome`, backed by IPC to the main process
// (see ext-shims.js). It MUST be registered before ElectronChromeExtensions so it runs
// before the library freezes `chrome` — properties we add first survive the freeze.

const { ipcRenderer, contextBridge, webFrame } = require('electron')

function isExtensionContext() {
  try {
    if (typeof process !== 'undefined' && process.type === 'service-worker') return true
    return typeof location !== 'undefined' && String(location.href).startsWith('chrome-extension://')
  } catch { return false }
}

// The isolated-world side of the bridge: real ipcRenderer access lives here.
function makeBridge() {
  const listeners = new Map() // channel -> Set<fn>
  ipcRenderer.on('drift-crx-event', (_e, channel, ...args) => {
    const set = listeners.get(channel)
    if (set) for (const fn of set) { try { fn(...args) } catch {} }
  })
  return {
    rpc: (method, ...args) => ipcRenderer.invoke('drift-crx-rpc', method, ...args),
    subscribe: (channel, fn) => {
      let set = listeners.get(channel)
      if (!set) { set = new Set(); listeners.set(channel, set) }
      set.add(fn)
    },
    unsubscribe: (channel, fn) => {
      const set = listeners.get(channel)
      if (set) set.delete(fn)
    }
  }
}

// The main-world side: builds the chrome.* shims from the bridge. Runs in the same
// realm as the extension's own code, so the objects it defines are what the extension sees.
function mainWorldScript() {
  const B = globalThis.__driftExtBridge
  const chrome = globalThis.chrome
  if (!chrome || !B) return
  const extId = chrome.runtime && chrome.runtime.id

  const define = (name, value) => {
    if (chrome[name]) return // don't clobber anything the library/Electron already provides
    try { Object.defineProperty(chrome, name, { value, enumerable: true, configurable: true }) } catch {}
  }

  // A minimal chrome.events.Event backed by the bridge's event channel.
  function makeEvent(channel) {
    const wrappers = new Map()
    return {
      addListener(cb) {
        const w = (payload) => cb(...(Array.isArray(payload) ? payload : [payload]))
        wrappers.set(cb, w)
        B.subscribe(channel, w)
      },
      removeListener(cb) {
        const w = wrappers.get(cb)
        if (w) { B.unsubscribe(channel, w); wrappers.delete(cb) }
      },
      hasListener(cb) { return wrappers.has(cb) },
      hasListeners() { return wrappers.size > 0 }
    }
  }

  // Match Chrome's contract: the promise form rejects; the callback form resolves
  // with undefined but exposes the reason via chrome.runtime.lastError during the
  // callback, so extensions that guard `if (chrome.runtime.lastError)` behave.
  const cbOrPromise = (promise, cb) => {
    if (typeof cb === 'function') {
      promise.then(r => cb(r)).catch(err => {
        let set = false
        try { chrome.runtime.lastError = { message: String((err && err.message) || err) }; set = true } catch {}
        try { cb(undefined) } finally { if (set) { try { delete chrome.runtime.lastError } catch {} } }
      })
      return
    }
    return promise
  }

  // ---- chrome.sidePanel ----
  define('sidePanel', {
    setOptions: (options, cb) => cbOrPromise(B.rpc('sidePanel.setOptions', options), cb),
    getOptions: (options, cb) => cbOrPromise(B.rpc('sidePanel.getOptions', options), cb),
    getPanelBehavior: (cb) => cbOrPromise(B.rpc('sidePanel.getPanelBehavior'), cb),
    setPanelBehavior: (behavior, cb) => cbOrPromise(B.rpc('sidePanel.setPanelBehavior', behavior), cb),
    open: (options, cb) => cbOrPromise(B.rpc('sidePanel.open', options), cb)
  })

  // ---- chrome.debugger -> Electron webContents.debugger ----
  define('debugger', {
    attach: (target, requiredVersion, cb) =>
      cbOrPromise(B.rpc('debugger.attach', target, requiredVersion), cb),
    detach: (target, cb) => cbOrPromise(B.rpc('debugger.detach', target), cb),
    sendCommand: (target, method, commandParams, cb) =>
      cbOrPromise(B.rpc('debugger.sendCommand', target, method, commandParams || {}), cb),
    getTargets: (cb) => cbOrPromise(B.rpc('debugger.getTargets'), cb),
    onEvent: makeEvent('debugger.onEvent'),
    onDetach: makeEvent('debugger.onDetach')
  })

  // ---- chrome.identity (OAuth via a native popup window) ----
  define('identity', {
    getRedirectURL: (pathArg) => {
      const p = pathArg ? String(pathArg).replace(/^\//, '') : ''
      return `https://${extId}.chromiumapp.org/${p}`
    },
    launchWebAuthFlow: (details, cb) =>
      cbOrPromise(B.rpc('identity.launchWebAuthFlow', details), cb),
    getAuthToken: (details, cb) =>
      cbOrPromise(B.rpc('identity.getAuthToken', details), cb),
    removeCachedAuthToken: (details, cb) =>
      cbOrPromise(B.rpc('identity.removeCachedAuthToken', details), cb),
    onSignInChanged: makeEvent('identity.onSignInChanged')
  })

  // ---- Graceful degradations: present but inert, so callers don't throw ----
  // tabGroups: report "no groups" rather than crash grouping logic. The Color enum
  // and TAB_GROUP_ID_NONE are read at module-load time by some extensions, so they
  // must be present even though grouping itself is a no-op.
  define('tabGroups', {
    TAB_GROUP_ID_NONE: -1,
    Color: {
      GREY: 'grey', BLUE: 'blue', RED: 'red', YELLOW: 'yellow',
      GREEN: 'green', PINK: 'pink', PURPLE: 'purple', CYAN: 'cyan', ORANGE: 'orange'
    },
    get: (id, cb) => cbOrPromise(Promise.resolve(undefined), cb),
    query: (q, cb) => cbOrPromise(Promise.resolve([]), cb),
    update: (id, props, cb) => cbOrPromise(Promise.resolve(undefined), cb),
    move: (id, props, cb) => cbOrPromise(Promise.resolve(undefined), cb),
    onCreated: makeEvent('noop'), onUpdated: makeEvent('noop'),
    onMoved: makeEvent('noop'), onRemoved: makeEvent('noop')
  })
  // offscreen: no offscreen documents; features that need them (GIF capture, audio) no-op.
  define('offscreen', {
    createDocument: (o, cb) => cbOrPromise(Promise.resolve(), cb),
    closeDocument: (cb) => cbOrPromise(Promise.resolve(), cb),
    hasDocument: (cb) => cbOrPromise(Promise.resolve(false), cb)
  })
  // declarativeNetRequest: accept rule updates but do nothing with them.
  define('declarativeNetRequest', {
    updateSessionRules: (o, cb) => cbOrPromise(Promise.resolve(), cb),
    getSessionRules: (cb) => cbOrPromise(Promise.resolve([]), cb),
    updateDynamicRules: (o, cb) => cbOrPromise(Promise.resolve(), cb),
    getDynamicRules: (cb) => cbOrPromise(Promise.resolve([]), cb)
  })
}

if (isExtensionContext()) {
  const bridge = makeBridge()
  try {
    if (process.contextIsolated) {
      contextBridge.exposeInMainWorld('__driftExtBridge', bridge)
      if ('executeInMainWorld' in contextBridge) {
        contextBridge.executeInMainWorld({ func: mainWorldScript })
      } else {
        // Older Electron: bridge object is reachable via the isolated world global.
        globalThis.__driftExtBridge = bridge
        webFrame.executeJavaScript('(' + mainWorldScript.toString() + ')()')
      }
    } else {
      globalThis.__driftExtBridge = bridge
      mainWorldScript()
    }
  } catch (err) {
    try { console.error('[drift] ext shim inject failed: ' + err.message) } catch {}
  }
}
