// Drift AI chat dock — renderer. Talks to main only through window.driftAI
// (chat-preload.js). Rebuilds the transcript from the ai:event stream and from
// stored chats; nothing here touches the network or the filesystem directly.

(() => {
  const $ = (id) => document.getElementById(id)
  const isSelftest = /(?:^|[?&])selftest=1(?:&|$)/.test(location.search)

  const head = $('head')
  const stream = $('stream')
  const transcript = $('transcript')
  const empty = $('empty')
  const conn = $('conn')
  const composer = $('composer')
  const chips = $('chips')
  const input = $('input')
  const modelPill = $('modelPill')
  const sendBtn = $('sendBtn')
  const historyMenu = $('historyMenu')
  const modelMenu = $('modelMenu')
  const mentionMenu = $('mentionMenu')

  // ---------- state ----------

  let cfg = { providers: [], prefs: {}, custom: {}, encryptionAvailable: true }
  let currentChatId = null
  let streaming = false
  let turn = null            // active assistant turn: { el, textEl, thinkEl, pendingTools }
  let pendingUserEl = null   // the optimistic user bubble text node awaiting its echo
  let lastUserText = ''
  let selectedCards = []     // [{id,title,url}] attached as @-context
  let atBottom = true
  let mention = null         // { start } index of the active '@' token
  let cardCache = []         // last cards() result, filtered client-side

  // ---------- tiny dom helper ----------

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag)
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k]
        if (v == null) continue
        if (k === 'class') n.className = v
        else if (k === 'text') n.textContent = v
        else if (k === 'html') n.innerHTML = v
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2), v)
        else n.setAttribute(k, v)
      }
    }
    for (const kid of kids) {
      if (kid == null || kid === false) continue
      n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid)
    }
    return n
  }

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url || '' }
  }

  // ---------- markdown (escape first, then a minimal subset) ----------

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ))
  }

  // Inline formatting runs on already-escaped text. Code spans and links are
  // stashed as placeholders first so bold/italic can't mangle their innards.
  function inlineMd(text) {
    const tokens = []
    const stash = (html) => '' + (tokens.push(html) - 1) + ''
    let s = text
    s = s.replace(/`([^`]+)`/g, (_m, c) => stash('<code>' + c + '</code>'))
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => {
      if (!/^https?:\/\//i.test(u.replace(/&amp;/g, '&'))) return m
      return stash('<a class="mdlink" data-href="' + u + '">' + t + '</a>')
    })
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/gi, (_m, pre, u) =>
      pre + stash('<a class="mdlink" data-href="' + u + '">' + u + '</a>'))
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>')
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    s = s.replace(/(^|[^\w_])_([^_\n]+)_/g, '$1<em>$2</em>')
    s = s.replace(/(\d+)/g, (_m, i) => tokens[+i])
    return s
  }

  function renderMarkdown(src) {
    const lines = String(src).replace(/\r\n?/g, '\n').split('\n')
    let out = ''
    let i = 0
    let para = []
    const flush = () => {
      if (!para.length) return
      out += '<p>' + para.map((l) => inlineMd(escapeHtml(l))).join('<br>') + '</p>'
      para = []
    }
    while (i < lines.length) {
      const line = lines[i]
      if (/^```/.test(line)) {
        flush()
        i++
        const code = []
        while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++ }
        if (i < lines.length) i++
        out += '<div class="codeblock"><button class="ccopy" type="button">Copy</button>' +
          '<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre></div>'
        continue
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(line)
      if (h) { flush(); const n = h[1].length; out += '<h' + n + '>' + inlineMd(escapeHtml(h[2])) + '</h' + n + '>'; i++; continue }
      if (/^>\s?/.test(line)) {
        flush()
        const q = []
        while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, '')); i++ }
        out += '<blockquote>' + q.map((l) => inlineMd(escapeHtml(l))).join('<br>') + '</blockquote>'
        continue
      }
      if (/^\s*[-*+]\s+/.test(line)) {
        flush()
        const items = []
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i++ }
        out += '<ul>' + items.map((t) => '<li>' + inlineMd(escapeHtml(t)) + '</li>').join('') + '</ul>'
        continue
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        flush()
        const items = []
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++ }
        out += '<ol>' + items.map((t) => '<li>' + inlineMd(escapeHtml(t)) + '</li>').join('') + '</ol>'
        continue
      }
      if (/^\s*$/.test(line)) { flush(); i++; continue }
      para.push(line)
      i++
    }
    flush()
    return out
  }

  async function copyCode(btn) {
    const code = btn.parentElement.querySelector('code')
    const txt = code ? code.textContent : ''
    try { await navigator.clipboard.writeText(txt) } catch {
      const ta = el('textarea')
      ta.value = txt
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } catch {}
      ta.remove()
    }
    const prev = btn.textContent
    btn.textContent = 'Copied'
    setTimeout(() => { btn.textContent = prev }, 1200)
  }

  // ---------- scrolling ----------

  stream.addEventListener('scroll', () => {
    atBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 40
  })
  function maybeScroll() {
    if (atBottom) stream.scrollTop = stream.scrollHeight
  }

  // ---------- transcript builders ----------

  function ensureTurn() {
    if (turn && turn.el.isConnected) return turn
    const box = el('div', { class: 'assist' })
    transcript.appendChild(box)
    turn = { el: box, textEl: null, thinkEl: null, pendingTools: [] }
    hideEmpty()
    return turn
  }

  function newTextEl() {
    const t = ensureTurn()
    const md = el('div', { class: 'md' })
    md._raw = ''
    t.el.appendChild(md)
    t.textEl = md
    return md
  }

  function addUserBubble(text, cards, pending) {
    const bubble = el('div', { class: 'msg user' })
    const utext = el('div', { class: 'utext', text })
    bubble.appendChild(utext)
    if (cards && cards.length) {
      const tags = el('div', { class: 'utags' })
      for (const c of cards) tags.appendChild(el('span', { class: 'utag', text: '✦ ' + (c.title || hostOf(c.url) || c.id) }))
      bubble.appendChild(tags)
    }
    transcript.appendChild(bubble)
    if (pending) pendingUserEl = utext
    hideEmpty()
    turn = null
    maybeScroll()
    return bubble
  }

  function onUser(block) {
    const text = block && block.type === 'text' ? block.text : (block && block.text) || ''
    if (pendingUserEl) {
      // The saved content is authoritative — reconcile the optimistic bubble.
      if (text && !/^<context_cards>/.test(text)) pendingUserEl.textContent = text
      pendingUserEl = null
    } else if (block && block.type === 'image') {
      addUserBubble('🖼 image', null, false)
    } else if (text && !/^<context_cards>/.test(text)) {
      addUserBubble(text, null, false)
    }
    turn = null
  }

  function onText(delta) {
    const t = ensureTurn()
    t.thinkEl = null
    const md = t.textEl || newTextEl()
    md._raw += delta || ''
    md.innerHTML = renderMarkdown(md._raw)
    maybeScroll()
  }

  function onThinking(delta) {
    const t = ensureTurn()
    t.textEl = null
    let th = t.thinkEl
    if (!th) {
      th = el('div', { class: 'think' })
      const hdr = el('div', { class: 'thinkhdr' }, el('span', { class: 'caret', text: '▸' }), el('span', { text: 'thinking…' }))
      const body = el('div', { class: 'thinkbody' })
      body._raw = ''
      th.appendChild(hdr)
      th.appendChild(body)
      t.el.appendChild(th)
      t.thinkEl = th
    }
    const body = th.querySelector('.thinkbody')
    body._raw += delta || ''
    body.textContent = body._raw
    maybeScroll()
  }

  function toolLabel(name) {
    return String(name || 'tool').replace(/_/g, ' ')
  }

  function addToolChip(name, detail) {
    const t = ensureTurn()
    t.textEl = null
    t.thinkEl = null
    const chip = el('div', { class: 'tool' },
      el('span', { class: 'tico', text: '⚙' }),
      el('span', { class: 'tname', text: toolLabel(name) }),
      el('span', { class: 'tdetail', text: detail || '' }),
      el('span', { class: 'tstat' }, el('span', { class: 'tspin' })))
    chip._name = name
    t.el.appendChild(chip)
    t.pendingTools.push(chip)
    maybeScroll()
    return chip
  }

  function resolveToolChip(chip, ok, detail) {
    chip.classList.add(ok ? 'ok' : 'err')
    const stat = chip.querySelector('.tstat')
    stat.textContent = ok ? '✓' : '✕'
    if (detail) chip.querySelector('.tdetail').textContent = detail
  }

  function onToolStart(name, detail) { addToolChip(name, detail) }

  function onToolDone(name, ok, detail) {
    const t = ensureTurn()
    let chip = t.pendingTools.find((c) => c._name === name) || t.pendingTools[0]
    if (!chip) chip = addToolChip(name, detail)
    t.pendingTools = t.pendingTools.filter((c) => c !== chip)
    resolveToolChip(chip, ok, detail)
    maybeScroll()
  }

  function onPermission(ev) {
    const t = ensureTurn()
    t.textEl = null
    t.thinkEl = null
    const actionWord = ev.action === 'type' ? 'type into pages' : 'click on pages'
    const card = el('div', { class: 'perm' })
    card.appendChild(el('div', { class: 'permq', html: 'Allow the assistant to act on <b>' + escapeHtml(ev.origin || 'this site') + '</b>?' }))
    card.appendChild(el('div', { class: 'permsub', text: 'It wants to ' + actionWord + ' here.' }))
    const choice = el('div', { class: 'permchoice' })
    const reply = (decision, labelText) => {
      driftAI.permissionReply(ev.requestId, decision)
      card.classList.add('done')
      choice.textContent = labelText
    }
    const btns = el('div', { class: 'permbtns' },
      el('button', { class: 'pyes', onclick: () => reply('once', 'Allowed once.') }, 'Allow once'),
      el('button', { onclick: () => reply('always', 'Always allowed on ' + (ev.origin || 'this site') + '.') }, 'Always'),
      el('button', { onclick: () => reply('no', 'Declined.') }, 'No'))
    card.appendChild(btns)
    card.appendChild(choice)
    t.el.appendChild(card)
    maybeScroll()
  }

  function onError(message) {
    setStreaming(false)
    turn = null
    const banner = el('div', { class: 'errbanner' })
    banner.appendChild(el('div', { class: 'emsg', text: message || 'Something went wrong.' }))
    banner.appendChild(el('button', { class: 'eretry', onclick: () => { banner.remove(); if (lastUserText) doSend(lastUserText) } }, 'Retry'))
    transcript.appendChild(banner)
    hideEmpty()
    maybeScroll()
  }

  function onTitle() { /* stored server-side; the history list reads it on open */ }

  function onDone() {
    setStreaming(false)
    turn = null
  }

  // ---------- event stream ----------

  function handleEvent(chatId, event) {
    if (!event) return
    if (event.type === 'chat') { currentChatId = event.chatId || chatId; return }
    // Events for a background chat (e.g. the user switched away) are ignored.
    if (chatId && currentChatId && chatId !== currentChatId) return
    switch (event.type) {
      case 'user': onUser(event.block); break
      case 'text': onText(event.delta); break
      case 'thinking': onThinking(event.delta); break
      case 'tool_start': onToolStart(event.name, event.detail); break
      case 'tool_done': onToolDone(event.name, event.ok, event.detail); break
      case 'permission': onPermission(event); break
      case 'title': onTitle(event.title); break
      case 'done': onDone(event.usage); break
      case 'error': onError(event.message); break
    }
  }

  // ---------- rebuild a stored chat ----------

  function summarizeInput(input) {
    if (!input || typeof input !== 'object') return ''
    const parts = []
    for (const k of Object.keys(input)) {
      let v = input[k]
      if (v == null) continue
      v = String(v)
      if (v.length > 40) v = v.slice(0, 40) + '…'
      parts.push(v)
      if (parts.length >= 2) break
    }
    return parts.join(' · ')
  }

  function renderStoredChat(chat) {
    transcript.innerHTML = ''
    turn = null
    pendingUserEl = null
    for (const msg of (chat.messages || [])) {
      const blocks = Array.isArray(msg.content) ? msg.content : []
      if (msg.role === 'user') {
        for (const b of blocks) {
          if (b.type === 'text' && !/^<context_cards>/.test(b.text || '')) addUserBubble(b.text, null, false)
          else if (b.type === 'image') addUserBubble('🖼 image', null, false)
        }
      } else if (msg.role === 'assistant') {
        turn = null
        ensureTurn()
        for (const b of blocks) {
          if (b.type === 'text') { const md = newTextEl(); md._raw = b.text || ''; md.innerHTML = renderMarkdown(md._raw) }
          else if (b.type === 'tool_use') resolveToolChip(addToolChip(b.name, summarizeInput(b.input)), true, summarizeInput(b.input))
        }
        turn = null
      }
    }
    if (!transcript.children.length) showEmpty()
    else hideEmpty()
    atBottom = true
    maybeScroll()
  }

  // ---------- empty state ----------

  function buildEmpty() {
    empty.innerHTML = ''
    empty.appendChild(el('div', { class: 'emark', text: '✦' }))
    empty.appendChild(el('div', { class: 'etitle', text: 'Chat with your canvas' }))
    empty.appendChild(el('div', { class: 'esub', text: 'I can see your cards and open, read, or act on them. Ask away.' }))
    const examples = [
      'Summarize the pages open on my canvas',
      'Open Hacker News and read the top story',
      'What’s on the card I’m looking at?'
    ]
    const box = el('div', { class: 'echips' })
    for (const ex of examples) {
      box.appendChild(el('button', { class: 'echip', text: ex, onclick: () => { input.value = ex; autogrow(); input.focus() } }))
    }
    empty.appendChild(box)
    const cta = el('div', { class: 'ecta hidden' }, el('button', { onclick: openConn }, 'Connect a provider'))
    empty.appendChild(cta)
    empty._cta = cta
  }

  function updateEmptyCTA() {
    if (empty._cta) empty._cta.classList.toggle('hidden', anyConnected())
  }
  function showEmpty() { if (!transcript.children.length) { updateEmptyCTA(); empty.classList.remove('hidden') } }
  function hideEmpty() { empty.classList.add('hidden') }

  // ---------- config / providers ----------

  function anyConnected() {
    return !!(cfg.providers || []).some((p) => p.connected && (isSelftest || p.id !== 'mock'))
  }
  function firstConnected() {
    const p = (cfg.providers || []).find((x) => x.connected && (isSelftest || x.id !== 'mock'))
    return p ? p.id : null
  }

  async function ensureDefaults() {
    const connected = (cfg.providers || []).filter((p) => p.connected && (isSelftest || p.id !== 'mock'))
    if (!connected.length) return
    if (!cfg.prefs.provider || !connected.some((p) => p.id === cfg.prefs.provider)) {
      cfg.prefs.provider = connected[0].id
      cfg.prefs.model = null
    }
    if (!cfg.prefs.model) {
      try {
        const ms = await driftAI.models(cfg.prefs.provider)
        if (ms && ms.length) cfg.prefs.model = ms[0].id
      } catch {}
    }
    driftAI.setPrefs({ provider: cfg.prefs.provider, model: cfg.prefs.model || null })
  }

  function shortModel(id) {
    const s = String(id).split('/').pop()
    return s.length > 24 ? s.slice(0, 24) + '…' : s
  }
  function updateModelPill() {
    const m = cfg.prefs && cfg.prefs.model
    modelPill.textContent = m ? shortModel(m) : 'Choose model'
  }

  async function refreshConfig(rerenderConn) {
    const got = await driftAI.config()
    cfg = got || { providers: [], prefs: {}, custom: {}, encryptionAvailable: true }
    cfg.prefs = cfg.prefs || {}
    cfg.custom = cfg.custom || {}
    await ensureDefaults()
    updateModelPill()
    updateEmptyCTA()
    if (rerenderConn && !conn.classList.contains('hidden')) renderConnections()
  }

  // ---------- model picker ----------

  function selectModel(provider, model) {
    cfg.prefs.provider = provider
    cfg.prefs.model = model
    driftAI.setPrefs({ provider, model })
    updateModelPill()
    closeMenus()
  }

  function openModelMenu() {
    closeMenus('model')
    modelMenu.innerHTML = ''
    const connected = (cfg.providers || []).filter((p) => p.connected && (isSelftest || p.id !== 'mock'))
    if (!connected.length) {
      modelMenu.appendChild(el('div', { class: 'menuempty', text: 'No providers connected yet.' }))
      modelMenu.appendChild(el('button', { class: 'menucta', onclick: () => { closeMenus(); openConn() } }, 'Connect a provider'))
      modelMenu.classList.remove('hidden')
      return
    }
    for (const p of connected) {
      modelMenu.appendChild(el('div', { class: 'menusec', text: p.label || p.id }))
      const holder = el('div', { class: 'menugroup' }, el('div', { class: 'menuloading', text: 'Loading…' }))
      modelMenu.appendChild(holder)
      driftAI.models(p.id).then((list) => {
        holder.innerHTML = ''
        if (!list || !list.length) { holder.appendChild(el('div', { class: 'menuloading', text: 'No models found' })); return }
        for (const mo of list) {
          const on = cfg.prefs.provider === p.id && cfg.prefs.model === mo.id
          holder.appendChild(el('button', { class: 'menurow' + (on ? ' on' : ''), onclick: () => selectModel(p.id, mo.id) }, mo.label || mo.id))
        }
      }).catch(() => { holder.innerHTML = ''; holder.appendChild(el('div', { class: 'menuloading', text: 'Could not load models' })) })
    }
    modelMenu.classList.remove('hidden')
  }

  // ---------- history ----------

  async function openHistory() {
    closeMenus('history')
    historyMenu.innerHTML = ''
    const list = await driftAI.chats() || []
    if (!list.length) {
      historyMenu.appendChild(el('div', { class: 'menuempty', text: 'No past chats yet.' }))
    }
    for (const c of list) {
      const row = el('div', { class: 'histrow' + (c.id === currentChatId ? ' on' : '') })
      row.appendChild(el('div', { class: 'histtitle', text: c.title || 'Untitled chat', onclick: () => { closeMenus(); loadChat(c.id) } }))
      row.appendChild(el('button', { class: 'histdel', title: 'Delete chat', onclick: (e) => { e.stopPropagation(); delChat(c.id) } }, '×'))
      historyMenu.appendChild(row)
    }
    if (list.length) historyMenu.appendChild(el('button', { class: 'menucta danger', onclick: clearAll }, 'Clear all chats'))
    historyMenu.classList.remove('hidden')
  }

  async function loadChat(id) {
    const c = await driftAI.chat(id)
    if (!c) return
    currentChatId = id
    setStreaming(false)
    closeConn()
    renderStoredChat(c)
  }

  async function delChat(id) {
    await driftAI.deleteChat(id)
    if (id === currentChatId) newChat()
    openHistory()
  }

  async function clearAll() {
    await driftAI.clearChats()
    closeMenus()
    newChat()
  }

  function newChat() {
    currentChatId = null
    turn = null
    pendingUserEl = null
    transcript.innerHTML = ''
    clearChips()
    closeConn()
    closeMenus()
    showEmpty()
    input.focus()
  }

  // ---------- connections ----------

  const PROV = {
    openrouter: { name: 'OpenRouter', kind: 'oauth', caption: 'Connect — free & paid models, no key needed' },
    openai: { name: 'OpenAI', kind: 'key', placeholder: 'sk-…', note: 'API key from platform.openai.com.' },
    anthropic: { name: 'Claude (Anthropic)', kind: 'key', placeholder: 'sk-ant-…', note: "API key from console.anthropic.com. Subscription sign-in isn't offered — Anthropic limits it to first-party apps." },
    chatgpt: { name: 'ChatGPT subscription', kind: 'oauth', caption: 'Sign in with ChatGPT — uses your Plus/Pro plan · experimental: Codex models, may change' },
    gemini: { name: 'Google Gemini', kind: 'key', placeholder: 'AIza…', note: 'AI Studio key from aistudio.google.com — has a genuinely free tier.' },
    custom: { name: 'Custom (OpenAI-compatible)', kind: 'custom', note: 'Any OpenAI-compatible endpoint — xAI, Mistral, DeepSeek, LiteLLM, llama.cpp…' }
  }
  const ORDER = ['openrouter', 'openai', 'anthropic', 'chatgpt', 'gemini', 'local', 'custom']

  function providerConnected(id) {
    const d = (cfg.providers || []).find((p) => p.id === id)
    return !!(d && d.connected)
  }

  function renderConnections() {
    conn.innerHTML = ''
    const canSave = cfg.encryptionAvailable !== false
    conn.appendChild(el('div', { class: 'conntitle', text: 'Connect a provider' }))
    if (!canSave) {
      conn.appendChild(el('div', { class: 'connwarn', text: 'Your macOS keychain is unavailable, so keys can’t be stored securely right now. Saving and sign-in are disabled until the keychain is reachable.' }))
    }
    for (const id of ORDER) {
      if (id === 'local') { conn.appendChild(renderLocalRow(canSave)); continue }
      const spec = PROV[id]
      if (!spec) continue
      if (spec.kind === 'key') conn.appendChild(renderKeyRow(id, spec, canSave))
      else if (spec.kind === 'oauth') conn.appendChild(renderOauthRow(id, spec, canSave))
      else if (spec.kind === 'custom') conn.appendChild(renderCustomRow(id, spec, canSave))
    }
    conn.appendChild(el('div', { class: 'connfoot', text: 'Keys are encrypted with your macOS keychain and never leave this Mac.' }))
  }

  function rowHead(id, name, connected, stateText) {
    const h = el('div', { class: 'phead' })
    h.appendChild(el('span', { class: 'pdot' + (connected ? ' on' : '') }))
    h.appendChild(el('span', { class: 'pname', text: name }))
    if (connected) h.appendChild(el('span', { class: 'pstate', text: stateText || 'Connected' }))
    return h
  }

  function renderKeyRow(id, spec, canSave) {
    const connected = providerConnected(id)
    const row = el('div', { class: 'prow' })
    row.appendChild(rowHead(id, spec.name, connected))
    const errLine = el('div', { class: 'perr hidden' })
    const field = el('input', {
      class: 'pinput',
      type: 'password',
      placeholder: connected ? '•••••••• saved — paste a new key to replace' : (spec.placeholder || 'Paste API key'),
      autocomplete: 'off',
      spellcheck: 'false'
    })
    if (!canSave) field.disabled = true
    const save = async () => {
      const v = field.value.trim()
      if (!v) return
      errLine.classList.add('hidden')
      const r = await driftAI.setKey(id, v)
      if (r && r.ok) { field.value = ''; await refreshConfig(true) }
      else { errLine.textContent = (r && r.error) || 'Could not save the key.'; errLine.classList.remove('hidden') }
    }
    field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save() } })
    field.addEventListener('blur', save)
    row.appendChild(field)
    if (connected) {
      const bar = el('div', { class: 'pbtnrow' })
      bar.appendChild(el('button', { class: 'pbtn danger', onclick: async () => { await driftAI.disconnect(id); await refreshConfig(true) } }, 'Disconnect'))
      row.appendChild(bar)
    }
    if (spec.note) row.appendChild(el('div', { class: 'pnote', text: spec.note }))
    row.appendChild(errLine)
    return row
  }

  function renderOauthRow(id, spec, canSave) {
    const connected = providerConnected(id)
    const row = el('div', { class: 'prow' })
    row.appendChild(rowHead(id, spec.name, connected))
    row.appendChild(el('div', { class: 'pnote', text: spec.caption }))
    const errLine = el('div', { class: 'perr hidden' })
    const bar = el('div', { class: 'pbtnrow' })
    if (connected) {
      bar.appendChild(el('button', { class: 'pbtn danger', onclick: async () => { await driftAI.disconnect(id); await refreshConfig(true) } }, 'Disconnect'))
    } else {
      const btn = el('button', { class: 'pbtn primary', text: id === 'chatgpt' ? 'Sign in with ChatGPT' : 'Connect' })
      if (!canSave) btn.disabled = true
      btn.addEventListener('click', async () => {
        btn.disabled = true
        btn.textContent = 'Opening browser…'
        errLine.classList.add('hidden')
        const r = await driftAI.connect(id)
        if (r && r.ok) { await refreshConfig(true) }
        else {
          btn.disabled = false
          btn.textContent = id === 'chatgpt' ? 'Sign in with ChatGPT' : 'Connect'
          errLine.textContent = (r && r.error) || 'Sign-in failed.'
          errLine.classList.remove('hidden')
        }
      })
      bar.appendChild(btn)
    }
    row.appendChild(bar)
    row.appendChild(errLine)
    return row
  }

  function renderLocalRow(canSave) {
    const up = providerConnected('ollama') || providerConnected('lmstudio')
    const row = el('div', { class: 'prow' })
    row.appendChild(rowHead('local', 'Local models', up, 'Detected'))
    row.appendChild(el('div', { class: 'pnote', text: 'Private & offline — Ollama (:11434) and LM Studio (:1234).' }))
    const results = el('div', { class: 'plocalmodels hidden' })
    const bar = el('div', { class: 'pbtnrow' })
    const btn = el('button', { class: 'pbtn', text: 'Detect' })
    btn.addEventListener('click', async () => {
      btn.disabled = true
      btn.textContent = 'Detecting…'
      const d = await driftAI.detectLocal()
      btn.disabled = false
      btn.textContent = 'Detect again'
      const parts = []
      const fmt = (label, s) => {
        if (!s || !s.up) return label + ': not running'
        const ms = (s.models || [])
        return label + ': running' + (ms.length ? ' · ' + ms.slice(0, 6).join(', ') : ' · no models')
      }
      parts.push(fmt('Ollama', d && d.ollama))
      parts.push(fmt('LM Studio', d && d.lmstudio))
      results.innerHTML = parts.map((p) => '<div>' + escapeHtml(p) + '</div>').join('')
      results.classList.remove('hidden')
      await refreshConfig(false)
    })
    bar.appendChild(btn)
    row.appendChild(bar)
    row.appendChild(results)
    return row
  }

  function renderCustomRow(id, spec, canSave) {
    const connected = providerConnected('custom')
    const row = el('div', { class: 'prow' })
    row.appendChild(rowHead('custom', spec.name, connected))
    const base = el('input', { class: 'pinput', type: 'text', placeholder: 'Base URL — https://…/v1', spellcheck: 'false', autocomplete: 'off' })
    const key = el('input', { class: 'pinput', type: 'password', placeholder: 'API key (optional)', spellcheck: 'false', autocomplete: 'off' })
    const label = el('input', { class: 'pinput', type: 'text', placeholder: 'Label (e.g. Together)', spellcheck: 'false', autocomplete: 'off' })
    base.value = (cfg.custom && cfg.custom.baseUrl) || ''
    label.value = (cfg.custom && cfg.custom.label) || ''
    if (!canSave) { base.disabled = key.disabled = label.disabled = true }
    const errLine = el('div', { class: 'perr hidden' })
    row.appendChild(base)
    row.appendChild(key)
    row.appendChild(label)
    const bar = el('div', { class: 'pbtnrow' })
    const saveBtn = el('button', { class: 'pbtn primary', text: 'Save' })
    if (!canSave) saveBtn.disabled = true
    saveBtn.addEventListener('click', async () => {
      errLine.classList.add('hidden')
      await driftAI.setPrefs({ custom: { baseUrl: base.value.trim(), label: label.value.trim() } })
      const k = key.value.trim()
      if (k) {
        const r = await driftAI.setKey('custom', k)
        if (!(r && r.ok)) { errLine.textContent = (r && r.error) || 'Could not save.'; errLine.classList.remove('hidden'); return }
        key.value = ''
      }
      await refreshConfig(true)
    })
    bar.appendChild(saveBtn)
    if (connected) bar.appendChild(el('button', { class: 'pbtn danger', onclick: async () => { await driftAI.disconnect('custom'); await refreshConfig(true) } }, 'Disconnect'))
    row.appendChild(bar)
    if (spec.note) row.appendChild(el('div', { class: 'pnote', text: spec.note }))
    row.appendChild(errLine)
    return row
  }

  function openConn() { renderConnections(); conn.classList.remove('hidden'); btnConn().classList.add('on') }
  function closeConn() { conn.classList.add('hidden'); btnConn().classList.remove('on') }
  function toggleConn() { conn.classList.contains('hidden') ? openConn() : closeConn() }
  function btnConn() { return $('btnConn') }

  // ---------- context chips ----------

  function renderChips() {
    chips.innerHTML = ''
    if (!selectedCards.length) { chips.classList.add('hidden'); return }
    chips.classList.remove('hidden')
    for (const c of selectedCards) {
      const chip = el('span', { class: 'chip' })
      chip.appendChild(el('span', { class: 'clabel', text: c.title || hostOf(c.url) || c.id }))
      chip.appendChild(el('button', { class: 'cx', title: 'Remove', onclick: () => { selectedCards = selectedCards.filter((x) => x.id !== c.id); renderChips() } }, '×'))
      chips.appendChild(chip)
    }
  }
  function clearChips() { selectedCards = []; renderChips() }
  function addCard(card) {
    if (!selectedCards.some((c) => c.id === card.id)) selectedCards.push(card)
    renderChips()
  }

  // ---------- @-mention menu ----------

  function mentionToken() {
    const caret = input.selectionStart
    const before = input.value.slice(0, caret)
    const m = /(^|\s)@([^\s@]*)$/.exec(before)
    if (!m) return null
    return { q: m[2], start: caret - m[2].length - 1, end: caret }
  }

  async function updateMention() {
    const tok = mentionToken()
    if (!tok) { mentionMenu.classList.add('hidden'); mention = null; return }
    mention = tok
    if (!cardCache.length || tok.q === '') {
      try { cardCache = await driftAI.cards() || [] } catch { cardCache = [] }
    }
    renderMention(tok.q)
  }

  function renderMention(q) {
    const ql = q.toLowerCase()
    const matches = cardCache.filter((c) => !selectedCards.some((s) => s.id === c.id) &&
      ((c.title || '').toLowerCase().includes(ql) || (c.url || '').toLowerCase().includes(ql))).slice(0, 8)
    mentionMenu.innerHTML = ''
    if (!matches.length) {
      mentionMenu.appendChild(el('div', { class: 'menuempty', text: cardCache.length ? 'No matching cards' : 'No open cards' }))
      mentionMenu.classList.remove('hidden')
      return
    }
    matches.forEach((c, i) => {
      const row = el('div', { class: 'mrow' + (i === 0 ? ' on' : ''), 'data-id': c.id })
      row.appendChild(el('span', { class: 'mdot', text: (c.title || hostOf(c.url) || '·').slice(0, 1).toUpperCase() }))
      const main = el('div', { class: 'mmain' })
      main.appendChild(el('div', { class: 'mtitle', text: c.title || hostOf(c.url) || c.id }))
      main.appendChild(el('div', { class: 'mhost', text: hostOf(c.url) }))
      row.appendChild(main)
      row.addEventListener('mousedown', (e) => { e.preventDefault(); pickMention(c) })
      mentionMenu.appendChild(row)
    })
    mentionMenu.classList.remove('hidden')
  }

  function mentionOpen() { return !mentionMenu.classList.contains('hidden') }
  function moveMention(dir) {
    const rows = [...mentionMenu.querySelectorAll('.mrow')]
    if (!rows.length) return
    let idx = rows.findIndex((r) => r.classList.contains('on'))
    idx = (idx + dir + rows.length) % rows.length
    rows.forEach((r) => r.classList.remove('on'))
    rows[idx].classList.add('on')
    rows[idx].scrollIntoView({ block: 'nearest' })
  }
  function pickHighlightedMention() {
    const on = mentionMenu.querySelector('.mrow.on') || mentionMenu.querySelector('.mrow')
    if (!on) { mentionMenu.classList.add('hidden'); return }
    const card = cardCache.find((c) => c.id === on.getAttribute('data-id'))
    if (card) pickMention(card)
  }
  function pickMention(card) {
    if (mention) {
      const v = input.value
      input.value = v.slice(0, mention.start) + v.slice(mention.end)
      input.selectionStart = input.selectionEnd = mention.start
    }
    addCard(card)
    mention = null
    mentionMenu.classList.add('hidden')
    autogrow()
    input.focus()
  }

  // ---------- menus ----------

  function closeMenus(except) {
    if (except !== 'history') historyMenu.classList.add('hidden')
    if (except !== 'model') modelMenu.classList.add('hidden')
    if (except !== 'mention') mentionMenu.classList.add('hidden')
  }
  function anyMenuOpen() {
    return !historyMenu.classList.contains('hidden') || !modelMenu.classList.contains('hidden') || mentionOpen()
  }

  // ---------- send / stop ----------

  function setStreaming(on) {
    streaming = on
    sendBtn.classList.toggle('stop', on)
    sendBtn.textContent = on ? '■' : '➤'
    sendBtn.title = on ? 'Stop' : 'Send'
  }

  function currentProvider() { return cfg.prefs.provider || firstConnected() || null }
  function currentModel() { return cfg.prefs.model || null }

  function doSend(explicitText) {
    if (streaming) return
    const text = (explicitText != null ? explicitText : input.value).trim()
    if (!text) return
    if (!anyConnected() && !isSelftest) { openConn(); return }
    const cards = selectedCards.slice()
    addUserBubble(text, cards, true)
    lastUserText = text
    driftAI.send({
      chatId: currentChatId,
      text,
      cardIds: cards.map((c) => c.id),
      provider: currentProvider(),
      model: currentModel()
    })
    input.value = ''
    autogrow()
    clearChips()
    closeMenus()
    setStreaming(true)
  }

  function onSendBtn() {
    if (streaming) driftAI.stop(currentChatId)
    else doSend()
  }

  // ---------- composer ----------

  function autogrow() {
    input.style.height = 'auto'
    input.style.height = Math.min(150, input.scrollHeight) + 'px'
  }

  input.addEventListener('input', () => { autogrow(); updateMention() })
  input.addEventListener('keydown', (e) => {
    if (mentionOpen()) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveMention(1); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveMention(-1); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickHighlightedMention(); return }
      if (e.key === 'Escape') { e.preventDefault(); mentionMenu.classList.add('hidden'); mention = null; return }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend() }
  })

  // ---------- transcript delegation (links, code copy, thinking toggle) ----------

  transcript.addEventListener('click', (e) => {
    const a = e.target.closest('a.mdlink')
    if (a) { e.preventDefault(); const href = a.getAttribute('data-href'); if (href) driftAI.openUrl(href); return }
    const copy = e.target.closest('.ccopy')
    if (copy) { copyCode(copy); return }
    const th = e.target.closest('.thinkhdr')
    if (th) { th.parentElement.classList.toggle('open'); return }
  })

  // ---------- global keys / outside clicks ----------

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (mentionOpen()) { mentionMenu.classList.add('hidden'); mention = null; return }
    if (!modelMenu.classList.contains('hidden') || !historyMenu.classList.contains('hidden')) { closeMenus(); return }
    if (!conn.classList.contains('hidden')) { closeConn(); return }
    if (streaming) { driftAI.stop(currentChatId); return }
    driftAI.close()
  })

  document.addEventListener('mousedown', (e) => {
    if (anyMenuOpen() &&
        !e.target.closest('#historyMenu') && !e.target.closest('#modelMenu') && !e.target.closest('#mentionMenu') &&
        !e.target.closest('#btnHistory') && !e.target.closest('#modelPill') && !e.target.closest('#input')) {
      closeMenus()
    }
  })

  // ---------- header + composer wiring ----------

  $('btnHistory').addEventListener('click', () => { historyMenu.classList.contains('hidden') ? openHistory() : closeMenus() })
  $('btnNew').addEventListener('click', newChat)
  $('btnConn').addEventListener('click', toggleConn)
  $('btnClose').addEventListener('click', () => driftAI.close())
  modelPill.addEventListener('click', () => { modelMenu.classList.contains('hidden') ? openModelMenu() : closeMenus() })
  sendBtn.addEventListener('click', onSendBtn)
  window.addEventListener('focus', () => { if (conn.classList.contains('hidden')) input.focus() })

  // ---------- init ----------

  ;(async function init() {
    buildEmpty()
    setStreaming(false)
    try { await refreshConfig(false) } catch {}
    showEmpty()
    driftAI.onEvent(handleEvent)
    input.focus()
    if (isSelftest) {
      window.__aiSelftest = {
        send: (t) => doSend(t),
        getTranscriptText: () => transcript.innerText
      }
    }
  })()
})()
