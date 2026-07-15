// Drift AI assistant — main-process hub.
//
// Owns: the chat dock (a native WebContentsView layered above page views — DOM
// panels lose that fight, see the toolbar limitation), the canvas RPC bridge
// (tools that must run in the canvas renderer), the permission prompt plumbing,
// and every ai:* IPC channel. Providers/agent/tools/store live in siblings.
//
// Security: EVERY channel here — handle and send alike — checks its sender.
// Pages and extension contexts share persist:drift and its preloads, so an
// unguarded handle channel would let any page frame drive the assistant
// (spend the user's tokens, run JS in other cards). fromCanvas = the canvas
// renderer only; fromChat = the chat dock only.

const path = require('path')
const { createAiStore } = require('./store')
const { createProviders } = require('./providers')
const { connectOpenRouter, connectChatGPT, refreshChatGPT } = require('./oauth')
const { createTools } = require('./tools')
const { createAgent } = require('./agent')

const DOCK_W = 400
const TOOLBAR = 60
const PIN_MS = 120000 // how long an AI read pins a card's webContents against pruning

function setupAI(deps) {
  const {
    app, ipcMain, safeStorage, shell, WebContentsView,
    getWindow, views, sendUI, fromCanvas, headless, selftest
  } = deps

  const store = createAiStore({ userDataDir: app.getPath('userData'), safeStorage, headless })
  const providers = createProviders({ store, refreshChatGPT })

  // ---------- chat dock ----------

  let chatView = null
  let chatOpen = false
  const wiredWindows = new WeakSet()

  const chatWC = () => (chatView && !chatView.webContents.isDestroyed() ? chatView.webContents : null)
  const fromChat = e => { const wc = chatWC(); return !!wc && e.sender === wc }

  // The chat preload is asarUnpack'd (preloads load from the filesystem, not
  // from inside app.asar) — point at the unpacked copy in a packaged build.
  let chatPreload = path.join(__dirname, '..', 'chat-preload.js')
  if (chatPreload.includes(`app.asar${path.sep}`)) {
    chatPreload = chatPreload.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
  }

  function ensureChatView() {
    if (chatView && !chatView.webContents.isDestroyed()) return chatView
    chatView = new WebContentsView({
      webPreferences: {
        preload: chatPreload,
        sandbox: true
      }
    })
    // Transparent view background: the page's own rounded glass container
    // paints, the sliver of margin around it shows the canvas through.
    chatView.setBackgroundColor('#00000000')
    const wc = chatView.webContents
    // The dock is trusted local UI. Markdown links open as canvas cards via
    // IPC — the dock document itself must never navigate anywhere.
    wc.on('will-navigate', e => e.preventDefault())
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) openCardFromMain(url)
      return { action: 'deny' }
    })
    wc.loadFile(
      path.join(__dirname, '..', 'chat', 'chat.html'),
      selftest ? { query: { selftest: '1' } } : {}
    ).catch(() => {})
    return chatView
  }

  function layoutChat() {
    const win = getWindow()
    if (!win || win.isDestroyed() || !chatView || !chatOpen) return
    const [w, h] = win.getContentSize()
    chatView.setBounds({
      x: Math.max(0, w - DOCK_W),
      y: TOOLBAR,
      width: Math.min(DOCK_W, w),
      height: Math.max(1, h - TOOLBAR)
    })
  }

  function openDock() {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    ensureChatView()
    if (!wiredWindows.has(win)) {
      wiredWindows.add(win)
      win.on('resize', layoutChat)
      win.on('closed', () => { chatView = null; chatOpen = false })
    }
    chatOpen = true
    win.contentView.addChildView(chatView)
    layoutChat()
    chatView.webContents.focus()
    sendUI('ai:dock', { open: true, width: DOCK_W })
  }

  function closeDock() {
    const win = getWindow()
    chatOpen = false
    if (chatView && win && !win.isDestroyed()) {
      try { win.contentView.removeChildView(chatView) } catch {}
      // Same keyboard rule as detaching page views: a hidden view holding
      // focus swallows every keystroke.
      win.webContents.focus()
    }
    sendUI('ai:dock', { open: false, width: DOCK_W })
  }

  // Page views are (re)added above earlier children on attach/raise; re-adding
  // the dock bumps it back to the top of the native stack. main.js calls this
  // only when the page stack actually changed, so it stays cheap.
  function ensureOnTop() {
    const win = getWindow()
    if (chatOpen && chatView && win && !win.isDestroyed()) {
      win.contentView.addChildView(chatView)
      layoutChat()
    }
  }

  // ---------- canvas RPC (tools that live in the renderer) ----------

  let rpcSeq = 0
  const rpcPending = new Map()

  function canvasRpc(verb, args = {}, timeoutMs = 15000) {
    const win = getWindow()
    if (!win || win.isDestroyed()) return Promise.reject(new Error('no window'))
    return new Promise((resolve, reject) => {
      const rpcId = ++rpcSeq
      const timer = setTimeout(() => {
        rpcPending.delete(rpcId)
        reject(new Error('the canvas did not answer: ' + verb))
      }, timeoutMs)
      rpcPending.set(rpcId, { resolve, reject, timer })
      sendUI('ai:canvas', { rpcId, verb, args })
    })
  }

  ipcMain.on('ai:canvasResult', (e, d) => {
    if (!fromCanvas(e) || !d) return
    const p = rpcPending.get(d.rpcId)
    if (!p) return
    rpcPending.delete(d.rpcId)
    clearTimeout(p.timer)
    d.ok ? p.resolve(d.result) : p.reject(new Error(d.error || 'canvas error'))
  })

  function openCardFromMain(url) {
    canvasRpc('open_card', { url }).catch(() => {})
  }

  // ---------- page access for tools ----------

  const glowTimers = new Map()
  function glowCard(cardId) {
    canvasRpc('card_glow', { card_id: cardId, on: true }).catch(() => {})
    clearTimeout(glowTimers.get(cardId))
    glowTimers.set(cardId, setTimeout(() => {
      glowTimers.delete(cardId)
      canvasRpc('card_glow', { card_id: cardId, on: false }).catch(() => {})
    }, 1800))
  }

  function pageTarget(cardId) {
    const m = views.get(cardId)
    if (!m || m.view.webContents.isDestroyed()) return null
    glowCard(cardId)
    return { wc: m.view.webContents, zoom: m.zoom }
  }

  async function snapshot(cardId, width) {
    const m = views.get(cardId)
    if (!m || !m.attached || m.view.webContents.isDestroyed()) return null
    try {
      const img = await m.view.webContents.capturePage()
      if (img.isEmpty()) return null
      const w = Math.min(1600, Math.max(80, Number(width) || 900))
      return 'data:image/jpeg;base64,' +
        img.resize({ width: w, quality: 'good' }).toJPEG(72).toString('base64')
    } catch { return null }
  }

  // ---------- permission prompts (rendered inline in the chat) ----------

  let permSeq = 0
  const permPending = new Map()

  function requestPermission({ origin, action, chatId }) {
    const wc = chatWC()
    if (!wc || !chatOpen) return Promise.resolve('no')
    return new Promise(resolve => {
      const requestId = 'p' + (++permSeq)
      permPending.set(requestId, resolve)
      wc.send('ai:event', chatId, { type: 'permission', requestId, origin, action })
      setTimeout(() => {
        if (permPending.delete(requestId)) resolve('no')
      }, 120000)
    })
  }

  ipcMain.on('ai:permReply', (e, d) => {
    if (!fromChat(e) || !d) return
    const resolve = permPending.get(d.requestId)
    if (!resolve) return
    permPending.delete(d.requestId)
    resolve(['once', 'always', 'no'].includes(d.decision) ? d.decision : 'no')
  })

  // ---------- agent wiring ----------

  const tools = createTools({ canvasRpc, pageTarget, snapshot, store })

  function emit(chatId, event) {
    const wc = chatWC()
    if (wc) wc.send('ai:event', chatId, event)
  }

  const agent = createAgent({ store, providers, tools, emit, requestPermission })

  const running = new Map() // chatId -> AbortController

  ipcMain.on('ai:send', async (e, payload) => {
    if (!fromChat(e) || !payload || typeof payload.text !== 'string') return
    const text = payload.text.slice(0, 32000)
    if (!text.trim()) return
    const meta = store.getMeta()
    let chat = payload.chatId ? store.getChat(payload.chatId) : null
    if (!chat) {
      chat = {
        id: 'a' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
        title: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: []
      }
    }
    if (running.has(chat.id)) return // one turn at a time per chat
    chat.provider = payload.provider || chat.provider || (meta.prefs && meta.prefs.provider) || 'anthropic'
    chat.model = payload.model || chat.model || (meta.prefs && meta.prefs.model) || ''
    emit(chat.id, { type: 'chat', chatId: chat.id })

    const blocks = [{ type: 'text', text }]
    const cardIds = Array.isArray(payload.cardIds) ? payload.cardIds.slice(0, 8) : []
    if (cardIds.length) {
      try {
        const all = await canvasRpc('list_cards')
        const picked = all.filter(c => cardIds.includes(c.id))
        if (picked.length) {
          blocks.push({
            type: 'text',
            text: '<context_cards>\n' +
              picked.map(c => `${c.id} · ${c.title || ''} · ${c.url}`).join('\n') +
              '\n</context_cards>\nThe user attached these canvas cards as context — use read_page to see their content.'
          })
        }
      } catch {}
    }

    const ctrl = new AbortController()
    running.set(chat.id, ctrl)
    try {
      await agent.runTurn({ chat, userBlocks: blocks, signal: ctrl.signal })
    } catch (err) {
      emit(chat.id, { type: 'error', message: String((err && err.message) || err) })
    } finally {
      running.delete(chat.id)
    }
  })

  ipcMain.on('ai:stop', (e, d) => {
    if (!fromChat(e)) return
    const id = d && d.chatId
    if (id && running.has(id)) running.get(id).abort()
    else for (const ctrl of running.values()) ctrl.abort()
  })

  // ---------- config / connections ----------

  const KEY_PROVIDERS = ['anthropic', 'openai', 'openrouter', 'gemini', 'custom']

  ipcMain.handle('ai:config', e => {
    if (!fromChat(e) && !fromCanvas(e)) return null
    const meta = store.getMeta()
    return {
      providers: providers.descriptors(),
      prefs: meta.prefs || {},
      custom: meta.custom || {},
      encryptionAvailable: meta.encryptionAvailable !== false
    }
  })

  ipcMain.handle('ai:setKey', (e, d) => {
    if (!fromChat(e) || !d || !KEY_PROVIDERS.includes(d.provider)) return { ok: false, error: 'bad provider' }
    const key = typeof d.key === 'string' ? d.key.trim() : ''
    try {
      store.setSecret(d.provider, key || null)
      return { ok: true }
    } catch (err) { return { ok: false, error: String((err && err.message) || err) } }
  })

  ipcMain.handle('ai:setPrefs', (e, patch) => {
    if (!fromChat(e) || !patch || typeof patch !== 'object') return { ok: false }
    const meta = store.getMeta()
    const next = {}
    if (patch.prefs && typeof patch.prefs === 'object') next.prefs = { ...(meta.prefs || {}), ...patch.prefs }
    if (patch.custom && typeof patch.custom === 'object') next.custom = { ...(meta.custom || {}), ...patch.custom }
    // Flat patches ({provider, model, …}) are prefs patches.
    const flat = Object.keys(patch).filter(k => k !== 'prefs' && k !== 'custom')
    if (flat.length) {
      next.prefs = next.prefs || { ...(meta.prefs || {}) }
      for (const k of flat) next.prefs[k] = patch[k]
    }
    store.setMeta(next)
    return { ok: true }
  })

  let connecting = false
  ipcMain.handle('ai:connect', async (e, d) => {
    if (!fromChat(e) || !d) return { ok: false, error: 'bad request' }
    if (connecting) return { ok: false, error: 'a sign-in is already in progress' }
    connecting = true
    try {
      if (d.provider === 'openrouter') {
        const { key } = await connectOpenRouter({ openExternal: url => shell.openExternal(url) })
        store.setSecret('openrouter', key)
        return { ok: true }
      }
      if (d.provider === 'chatgpt') {
        const tokens = await connectChatGPT({ openExternal: url => shell.openExternal(url) })
        store.setSecret('chatgpt', JSON.stringify(tokens))
        return { ok: true, email: tokens.email || null }
      }
      return { ok: false, error: 'unknown provider' }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) }
    } finally {
      connecting = false
    }
  })

  ipcMain.handle('ai:disconnect', (e, d) => {
    if (!fromChat(e) || !d) return { ok: false }
    if (![...KEY_PROVIDERS, 'chatgpt'].includes(d.provider)) return { ok: false }
    store.setSecret(d.provider, null)
    return { ok: true }
  })

  ipcMain.handle('ai:models', async (e, d) => {
    if (!fromChat(e) || !d) return []
    try { return await providers.listModels(d.provider) } catch { return [] }
  })

  ipcMain.handle('ai:detectLocal', async e => {
    if (!fromChat(e)) return null
    try { return await providers.detectLocal({}) } catch { return { ollama: { up: false }, lmstudio: { up: false } } }
  })

  // ---------- chats ----------

  ipcMain.handle('ai:chats', e => (fromChat(e) ? store.listChats() : []))
  ipcMain.handle('ai:chat', (e, d) => (fromChat(e) && d ? store.getChat(d.id) : null))
  ipcMain.handle('ai:chatDelete', (e, d) => { if (fromChat(e) && d) store.deleteChat(d.id); return { ok: true } })
  ipcMain.handle('ai:chatsClear', e => { if (fromChat(e)) store.clearChats(); return { ok: true } })

  // ---------- canvas helpers for the chat UI ----------

  ipcMain.handle('ai:cards', async e => {
    if (!fromChat(e)) return []
    try {
      const all = await canvasRpc('list_cards')
      return all.filter(c => !c.panel).map(c => ({ id: c.id, title: c.title, url: c.url, active: !!c.active }))
    } catch { return [] }
  })

  ipcMain.handle('ai:openUrl', (e, d) => {
    if (!fromChat(e) || !d || !/^https?:\/\//i.test(String(d.url || ''))) return { ok: false }
    openCardFromMain(String(d.url))
    return { ok: true }
  })

  ipcMain.on('ai:close', e => { if (fromChat(e)) closeDock() })
  ipcMain.on('ai:toggle', e => { if (fromCanvas(e)) (chatOpen ? closeDock() : openDock()) })

  // ---------- selftest: exercise the whole spine offline (mock provider) ----------

  ipcMain.handle('ai:selftest', async e => {
    if (!fromCanvas(e) || !selftest) return { ok: false, error: 'not in selftest' }
    try {
      const chat = {
        id: 'selftest-chat', title: '', createdAt: Date.now(), updatedAt: Date.now(),
        provider: 'mock', model: 'mock-1', messages: []
      }
      let toolRan = false
      const localAgent = createAgent({
        store, providers, tools,
        emit: (_id, ev) => { if (ev.type === 'tool_done') toolRan = true },
        requestPermission: () => Promise.resolve('no')
      })
      await localAgent.runTurn({
        chat,
        userBlocks: [{ type: 'text', text: 'please use tool to look at my canvas' }],
        signal: new AbortController().signal
      })
      const text = chat.messages
        .filter(m => m.role === 'assistant')
        .flatMap(m => m.content)
        .filter(b => b.type === 'text')
        .map(b => b.text).join(' ')
      return { ok: true, toolRan, text }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) }
    }
  })

  return { ensureOnTop, toggleDock: () => (chatOpen ? closeDock() : openDock()), isOpen: () => chatOpen }
}

module.exports = { setupAI }
