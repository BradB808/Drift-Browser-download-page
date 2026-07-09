const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('drift', {
  ensureView: (id, url) => ipcRenderer.invoke('view:ensure', { id, url }),
  destroyView: (id) => ipcRenderer.invoke('view:destroy', { id }),
  loadURL: (id, url) => ipcRenderer.invoke('view:load', { id, url }),
  navAction: (id, action) => ipcRenderer.invoke('view:nav', { id, action }),
  layout: (payload) => ipcRenderer.send('view:layout', payload),
  raise: (id) => ipcRenderer.send('view:raise', id),
  snapshot: (id, width) => ipcRenderer.invoke('view:snapshot', { id, width }),
  saveState: (json) => ipcRenderer.invoke('state:save', json),
  loadState: () => ipcRenderer.invoke('state:load'),
  bookmarksLoad: () => ipcRenderer.invoke('bookmarks:load'),
  bookmarksSave: (arr) => ipcRenderer.invoke('bookmarks:save', arr),
  selftestArtifact: (name, dataUrl) => ipcRenderer.invoke('selftest:artifact', { name, dataUrl }),
  selftestDone: (report) => ipcRenderer.invoke('selftest:done', report),
  openDownloadPage: () => ipcRenderer.invoke('update:open'),
  onViewEvent: (fn) => ipcRenderer.on('view:event', (_e, d) => fn(d)),
  onUIKey: (fn) => ipcRenderer.on('ui:key', (_e, d) => fn(d)),
  onUpdateAvailable: (fn) => ipcRenderer.on('update:available', (_e, d) => fn(d))
})
