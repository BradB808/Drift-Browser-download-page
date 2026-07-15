const { contextBridge, ipcRenderer } = require('electron')

// Inject the <browser-action-list> custom element (extension icon row) into
// the canvas renderer. Requires sandbox:false on this window.
try { require('electron-chrome-extensions/browser-action') } catch (err) { /* extensions optional */ }

contextBridge.exposeInMainWorld('drift', {
  ensureView: (id, url, opts) => ipcRenderer.invoke('view:ensure', { id, url, opts }),
  destroyView: (id) => ipcRenderer.invoke('view:destroy', { id }),
  loadURL: (id, url) => ipcRenderer.invoke('view:load', { id, url }),
  navAction: (id, action) => ipcRenderer.invoke('view:nav', { id, action }),
  layout: (payload) => ipcRenderer.send('view:layout', payload),
  raise: (id) => ipcRenderer.send('view:raise', id),
  prezoom: (id, zoom) => ipcRenderer.send('view:prezoom', { id, zoom }),
  snapshot: (id, width) => ipcRenderer.invoke('view:snapshot', { id, width }),
  saveState: (json) => ipcRenderer.invoke('state:save', json),
  loadState: () => ipcRenderer.invoke('state:load'),
  bookmarksLoad: () => ipcRenderer.invoke('bookmarks:load'),
  bookmarksSave: (data) => ipcRenderer.invoke('bookmarks:save', data),
  bookmarksExport: (html) => ipcRenderer.invoke('bookmarks:export', html),
  bookmarksImport: () => ipcRenderer.invoke('bookmarks:import'),
  vaultLoad: () => ipcRenderer.invoke('vault:load'),
  vaultSave: (blob) => ipcRenderer.invoke('vault:save', blob),
  vaultFill: (id, username, password) => ipcRenderer.invoke('vault:fill', { id, username, password }),
  selftestArtifact: (name, dataUrl) => ipcRenderer.invoke('selftest:artifact', { name, dataUrl }),
  selftestDone: (report) => ipcRenderer.invoke('selftest:done', report),
  openDownloadPage: () => ipcRenderer.invoke('update:open'),
  settingsLoad: () => ipcRenderer.invoke('settings:load'),
  settingsSave: (s) => ipcRenderer.invoke('settings:save', s),
  extList: () => ipcRenderer.invoke('ext:list'),
  extRemove: (id) => ipcRenderer.invoke('ext:remove', id),
  extOpenStore: () => ipcRenderer.invoke('ext:openStore'),
  extTabId: (id) => ipcRenderer.invoke('ext:tabId', { id }),
  extIsReady: () => ipcRenderer.invoke('ext:isReady'),
  onExtReady: (fn) => ipcRenderer.on('ext:ready', () => fn()),
  onViewEvent: (fn) => ipcRenderer.on('view:event', (_e, d) => fn(d)),
  onUIKey: (fn) => ipcRenderer.on('ui:key', (_e, d) => fn(d)),
  onUpdateAvailable: (fn) => ipcRenderer.on('update:available', (_e, d) => fn(d)),
  onExtOpenSidePanel: (fn) => ipcRenderer.on('ext:openSidePanel', (_e, d) => fn(d)),
  onExtAdoptTab: (fn) => ipcRenderer.on('ext:adoptTab', (_e, d) => fn(d)),
  onExtSelectTab: (fn) => ipcRenderer.on('ext:selectTab', (_e, d) => fn(d)),
  onExtRemoveTab: (fn) => ipcRenderer.on('ext:removeTab', (_e, d) => fn(d)),
  onSpawnUrl: (fn) => ipcRenderer.on('view:spawnUrl', (_e, d) => fn(d)),
  aiToggle: () => ipcRenderer.send('ai:toggle'),
  aiSelftest: () => ipcRenderer.invoke('ai:selftest'),
  aiCanvasResult: (payload) => ipcRenderer.send('ai:canvasResult', payload),
  onAICanvas: (fn) => ipcRenderer.on('ai:canvas', (_e, d) => fn(d)),
  onAIDock: (fn) => ipcRenderer.on('ai:dock', (_e, d) => fn(d))
})
