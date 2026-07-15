// Drift AI chat dock — preload bridge.
// Sandboxed WebContentsView (default session, NOT persist:drift). Exposes only
// a narrow, typed surface to the chat document: no ipcRenderer, no raw event
// objects. Every channel is sender-checked in ai/index.js (fromChat).

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('driftAI', {
  config: () => ipcRenderer.invoke('ai:config'),
  setKey: (provider, key) => ipcRenderer.invoke('ai:setKey', { provider, key }),
  setPrefs: (patch) => ipcRenderer.invoke('ai:setPrefs', patch),
  connect: (provider) => ipcRenderer.invoke('ai:connect', { provider }),
  disconnect: (provider) => ipcRenderer.invoke('ai:disconnect', { provider }),
  models: (provider) => ipcRenderer.invoke('ai:models', { provider }),
  detectLocal: () => ipcRenderer.invoke('ai:detectLocal'),
  chats: () => ipcRenderer.invoke('ai:chats'),
  chat: (id) => ipcRenderer.invoke('ai:chat', { id }),
  deleteChat: (id) => ipcRenderer.invoke('ai:chatDelete', { id }),
  clearChats: () => ipcRenderer.invoke('ai:chatsClear'),
  cards: () => ipcRenderer.invoke('ai:cards'),
  send: (msg) => ipcRenderer.send('ai:send', msg),
  // A chatId targets one chat's turn; omit it to stop whatever is running.
  stop: (chatId) => ipcRenderer.send('ai:stop', { chatId }),
  permissionReply: (requestId, decision) => ipcRenderer.send('ai:permReply', { requestId, decision }),
  openUrl: (url) => ipcRenderer.invoke('ai:openUrl', { url }),
  close: () => ipcRenderer.send('ai:close'),
  // Main fans every turn's step events out as (chatId, event) — unwrap the
  // Electron event so the renderer never touches ipcRenderer internals.
  onEvent: (fn) => ipcRenderer.on('ai:event', (_e, chatId, event) => fn(chatId, event))
})
