// Drift canvas — the whole browser UI. Pages are cards on an infinite
// zoomable canvas; live Chromium views are positioned over each card's body
// by the main process, while zoomed-out cards fall back to DOM snapshots.

/* global drift */

const SELF = new URLSearchParams(location.search).get('selftest') === '1'

// ---------- constants ----------

const HEAD = 36          // card header height, world units
const INSET = 8          // frame ring around page content, world units
const TOOLBAR = 44       // screen px reserved at top
const LIVE_ON = 0.42     // canvas zoom at which cards go live
const LIVE_OFF = 0.38    // hysteresis: zoom below this detaches them
const MAX_LIVE = 10      // max simultaneously attached Chromium views
const KEEP_ALIVE = 12    // max background webContents before LRU destroy
const VIS_MARGIN = 220   // px of offscreen slack still counted as visible
const MIN_S = 0.06, MAX_S = 2.5

// ---------- state ----------

const V = { s: 0.9, ox: 60, oy: 90 } // world→screen: screen = world*s + o
const cards = new Map()              // id -> card
const edges = []                     // { from, to }
let seq = 0
let activeId = null
let focusState = null                // { prev: {s,ox,oy} }
let paletteOpen = false
let paletteMode = {}
let dirty = false
let layoutQueued = false
let animToken = 0

// ---------- dom ----------

const $ = s => document.querySelector(s)
const viewport = $('#viewport')
const world = $('#world')
const cardsEl = $('#cards')
const edgeG = $('#edgeG')
const zoomPct = $('#zoomPct')
const emptyEl = $('#empty')
const minimap = $('#minimap')
const palette = $('#palette')
const palInput = $('#palInput')

// ---------- helpers ----------

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const uid = () => 'c' + (++seq) + '_' + Math.random().toString(36).slice(2, 7)

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

function normalizeInput(q) {
  q = q.trim()
  if (!q) return null
  if (/^https?:\/\//i.test(q)) return q
  if (/^localhost(:\d+)?(\/.*)?$/.test(q)) return 'http://' + q
  if (!q.includes(' ') && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(q)) return 'https://' + q
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(q)
}

const toWorld = (x, y) => ({ x: (x - V.ox) / V.s, y: (y - V.oy) / V.s })

function screenRect(c) {
  return { x: c.x * V.s + V.ox, y: c.y * V.s + V.oy, w: c.w * V.s, h: c.h * V.s }
}

function screenBodyRect(c) {
  return {
    x: (c.x + INSET) * V.s + V.ox,
    y: (c.y + HEAD) * V.s + V.oy,
    w: (c.w - 2 * INSET) * V.s,
    h: (c.h - HEAD - INSET) * V.s
  }
}

function markDirty() { dirty = true }

// ---------- cards ----------

function createCard(d, opts = {}) {
  const c = {
    id: d.id || uid(),
    url: d.url,
    title: d.title || hostOf(d.url),
    fav: d.fav || null,
    x: d.x, y: d.y, w: d.w || 860, h: d.h || 600,
    snapshot: d.snapshot || null,
    createdAt: d.createdAt || Date.now(),
    lastActive: d.lastActive || Date.now(),
    live: false, wantLive: false, retiring: false,
    viewCreated: false, viewReady: false,
    loading: false, error: null,
    lastSnap: 0, snapPending: false, everLoaded: false
  }
  buildCardDom(c)
  cards.set(c.id, c)
  updateEmpty()
  markDirty()
  scheduleLayout()
  return c
}

function buildCardDom(c) {
  const el = document.createElement('div')
  el.className = 'card'
  el.dataset.id = c.id
  el.style.left = c.x + 'px'
  el.style.top = c.y + 'px'
  el.style.width = c.w + 'px'
  el.style.height = c.h + 'px'
  el.innerHTML = `
    <div class="head">
      <button class="nb b-back" title="Back">‹</button>
      <button class="nb b-fwd" title="Forward">›</button>
      <img class="fav hidden" alt="">
      <span class="ctitle"></span>
      <input class="urledit hidden" spellcheck="false">
      <span class="spin hidden"></span>
      <button class="nb b-reload" title="Reload">⟳</button>
      <button class="nb b-focus" title="Focus">⤢</button>
      <button class="nb b-close" title="Close">×</button>
    </div>
    <div class="body">
      <div class="ph">
        <span class="phletter"></span>
        <span class="phhost"></span>
        <span class="pherr hidden"></span>
      </div>
      <img class="snap hidden" alt="">
    </div>
    <div class="grip"></div>`
  cardsEl.appendChild(el)

  c.el = el
  c.titleEl = el.querySelector('.ctitle')
  c.favEl = el.querySelector('.fav')
  c.spinEl = el.querySelector('.spin')
  c.snapEl = el.querySelector('.snap')
  c.phLetterEl = el.querySelector('.phletter')
  c.phHostEl = el.querySelector('.phhost')
  c.phErrEl = el.querySelector('.pherr')
  c.urlEditEl = el.querySelector('.urledit')
  c.backBtn = el.querySelector('.b-back')
  c.fwdBtn = el.querySelector('.b-fwd')

  if (c.snapshot) { c.snapEl.src = c.snapshot; c.snapEl.classList.remove('hidden') }
  renderHead(c)

  const head = el.querySelector('.head')

  el.addEventListener('mousedown', () => { setActive(c.id); drift.raise(c.id) })

  head.addEventListener('mousedown', e => {
    if (e.target.closest('button') || e.target.closest('input')) return
    startCardDrag(c, e)
  })
  head.addEventListener('dblclick', e => {
    if (e.target.closest('button') || e.target.closest('input')) return
    focusCard(c)
  })

  // Clicking a zoomed-out thumbnail dives into that page.
  el.querySelector('.body').addEventListener('click', () => { if (!c.live) focusCard(c) })

  el.querySelector('.b-close').addEventListener('click', e => { e.stopPropagation(); closeCard(c.id) })
  el.querySelector('.b-reload').addEventListener('click', e => {
    e.stopPropagation()
    if (c.viewCreated) drift.navAction(c.id, 'reload')
  })
  el.querySelector('.b-focus').addEventListener('click', e => { e.stopPropagation(); focusCard(c) })
  c.backBtn.addEventListener('click', e => { e.stopPropagation(); drift.navAction(c.id, 'back') })
  c.fwdBtn.addEventListener('click', e => { e.stopPropagation(); drift.navAction(c.id, 'forward') })

  c.titleEl.addEventListener('click', e => { e.stopPropagation(); startUrlEdit(c) })
  c.urlEditEl.addEventListener('keydown', e => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      const u = normalizeInput(c.urlEditEl.value)
      endUrlEdit(c)
      if (u) navigateCard(c, u)
    } else if (e.key === 'Escape') endUrlEdit(c)
  })
  c.urlEditEl.addEventListener('blur', () => endUrlEdit(c))
  c.urlEditEl.addEventListener('mousedown', e => e.stopPropagation())

  el.querySelector('.grip').addEventListener('mousedown', e => startCardResize(c, e))
}

function renderHead(c) {
  c.titleEl.textContent = c.title || hostOf(c.url)
  c.el.title = c.url
  c.spinEl.classList.toggle('hidden', !c.loading)
  if (c.fav) {
    c.favEl.src = c.fav
    c.favEl.classList.remove('hidden')
    c.favEl.onerror = () => c.favEl.classList.add('hidden')
  } else c.favEl.classList.add('hidden')
  c.backBtn.disabled = !c.canGoBack
  c.fwdBtn.disabled = !c.canGoForward
  const host = hostOf(c.url)
  c.phLetterEl.textContent = (host[0] || '?').toUpperCase()
  c.phHostEl.textContent = host
  c.phErrEl.classList.toggle('hidden', !c.error)
  if (c.error) c.phErrEl.textContent = c.error
}

function startUrlEdit(c) {
  c.titleEl.classList.add('hidden')
  c.urlEditEl.classList.remove('hidden')
  c.urlEditEl.value = c.url
  c.urlEditEl.focus()
  c.urlEditEl.select()
}

function endUrlEdit(c) {
  c.urlEditEl.classList.add('hidden')
  c.titleEl.classList.remove('hidden')
}

function navigateCard(c, url) {
  c.url = url
  c.title = hostOf(url)
  c.fav = null
  c.error = null
  renderHead(c)
  markDirty()
  if (c.viewCreated) drift.loadURL(c.id, url)
  else scheduleLayout() // liveness engine will create the view with the new url
}

function setActive(id) {
  if (activeId === id) return
  if (activeId) cards.get(activeId)?.el.classList.remove('active')
  activeId = id
  const c = cards.get(id)
  if (c) { c.el.classList.add('active'); c.lastActive = Date.now() }
}

function closeCard(id) {
  const c = cards.get(id)
  if (!c) return
  if (c.viewCreated) drift.destroyView(id)
  c.el.remove()
  cards.delete(id)
  for (let i = edges.length - 1; i >= 0; i--) {
    if (edges[i].from === id || edges[i].to === id) removeEdgeEl(edges[i]), edges.splice(i, 1)
  }
  if (activeId === id) activeId = null
  updateEmpty()
  markDirty()
  scheduleLayout()
}

function updateEmpty() { emptyEl.classList.toggle('hidden', cards.size > 0 || SELF) }

function flashCard(c) {
  c.el.classList.remove('flash')
  void c.el.offsetWidth
  c.el.classList.add('flash')
}

// ---------- edges (trails) ----------

function edgeKey(e) { return e.from + '->' + e.to }
const edgeEls = new Map()

function addEdge(from, to, quiet) {
  if (!cards.has(from) || !cards.has(to)) return
  if (edges.some(e => e.from === from && e.to === to)) return
  edges.push({ from, to })
  if (!quiet) markDirty()
  updateEdges()
}

function removeEdgeEl(e) {
  const el = edgeEls.get(edgeKey(e))
  if (el) { el.path.remove(); el.dot.remove(); edgeEls.delete(edgeKey(e)) }
}

function updateEdges() {
  for (const e of edges) {
    const a = cards.get(e.from), b = cards.get(e.to)
    if (!a || !b) continue
    let el = edgeEls.get(edgeKey(e))
    if (!el) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      edgeG.appendChild(path)
      edgeG.appendChild(dot)
      el = { path, dot }
      edgeEls.set(edgeKey(e), el)
    }
    const goRight = (b.x + b.w / 2) >= (a.x + a.w / 2)
    const p1 = { x: goRight ? a.x + a.w : a.x, y: a.y + a.h / 2 }
    const p2 = { x: goRight ? b.x : b.x + b.w, y: b.y + b.h / 2 }
    const dx = Math.max(60, Math.abs(p2.x - p1.x) / 2) * (goRight ? 1 : -1)
    el.path.setAttribute('d',
      `M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y}, ${p2.x - dx} ${p2.y}, ${p2.x} ${p2.y}`)
    el.dot.setAttribute('cx', p2.x)
    el.dot.setAttribute('cy', p2.y)
    el.dot.setAttribute('r', 5 / V.s)
  }
}

// ---------- layout / liveness ----------

function scheduleLayout() {
  if (!layoutQueued) {
    layoutQueued = true
    requestAnimationFrame(doLayout)
  }
}

function doLayout() {
  layoutQueued = false
  world.style.transform = `translate(${V.ox}px, ${V.oy}px) scale(${V.s})`
  viewport.style.backgroundSize = `${24 * V.s}px ${24 * V.s}px`
  viewport.style.backgroundPosition = `${V.ox}px ${V.oy}px`
  edgeG.setAttribute('stroke-width', String(2.5 / V.s))
  decideLiveness()
  const items = []
  for (const c of cards.values()) {
    if (c.live && c.viewReady) {
      const r = screenBodyRect(c)
      items.push({ id: c.id, x: r.x, y: r.y, w: r.w, h: r.h })
    }
  }
  drift.layout({ zoom: V.s, items })
  zoomPct.textContent = Math.round(V.s * 100) + '%'
  updateEdges()
  drawMinimap()
  pruneViews()
}

function decideLiveness() {
  const vw = innerWidth, vh = innerHeight
  const want = []
  for (const c of cards.values()) {
    const r = screenRect(c)
    const visible = r.x < vw + VIS_MARGIN && r.x + r.w > -VIS_MARGIN &&
                    r.y < vh + VIS_MARGIN && r.y + r.h > -VIS_MARGIN
    const zoomOk = c.live ? V.s >= LIVE_OFF : V.s >= LIVE_ON
    c.wantLive = !paletteOpen && visible && zoomOk
    if (c.wantLive) want.push(c)
  }
  want.sort((a, b) => b.lastActive - a.lastActive)
  want.slice(MAX_LIVE).forEach(c => { c.wantLive = false })
  for (const c of cards.values()) {
    if (c.retiring) continue
    if (c.wantLive && !c.live) goLive(c)
    else if (!c.wantLive && c.live) retire(c, paletteOpen)
  }
}

async function goLive(c) {
  c.live = true
  if (!c.viewCreated) {
    c.viewCreated = true
    const res = await drift.ensureView(c.id, c.url)
    if (!res || !res.ok) { c.viewCreated = false; c.live = false; return }
  }
  c.viewReady = true
  scheduleLayout()
}

async function retire(c, fast) {
  c.retiring = true
  try { if (!fast && c.viewCreated) await takeSnapshot(c, true) } finally {
    c.live = false
    c.retiring = false
    scheduleLayout()
  }
}

function pruneViews() {
  const alive = [...cards.values()].filter(c => c.viewCreated)
  if (alive.length <= KEEP_ALIVE) return
  alive
    .filter(c => !c.live && !c.retiring)
    .sort((a, b) => a.lastActive - b.lastActive)
    .slice(0, alive.length - KEEP_ALIVE)
    .forEach(c => {
      c.viewCreated = false
      c.viewReady = false
      drift.destroyView(c.id)
    })
}

async function takeSnapshot(c, force) {
  if (!c.viewCreated || c.snapPending) return
  if (!force && Date.now() - c.lastSnap < 3000) return
  c.snapPending = true
  try {
    const d = await drift.snapshot(c.id, 480)
    if (d && d.length > 200) {
      c.snapshot = d
      c.snapEl.src = d
      c.snapEl.classList.remove('hidden')
      c.lastSnap = Date.now()
      markDirty()
    }
  } finally { c.snapPending = false }
}

// ---------- events from live pages ----------

drift.onViewEvent(d => {
  const c = cards.get(d.id)
  if (!c) return
  switch (d.type) {
    case 'title': c.title = d.title; renderHead(c); markDirty(); break
    case 'favicon': c.fav = d.favicon; renderHead(c); markDirty(); break
    case 'url':
      c.url = d.url
      c.canGoBack = d.canGoBack
      c.canGoForward = d.canGoForward
      c.error = null
      renderHead(c)
      markDirty()
      break
    case 'loading':
      c.loading = d.loading
      renderHead(c)
      if (!d.loading) { c.everLoaded = true; takeSnapshot(c) }
      break
    case 'fail': c.error = d.desc; renderHead(c); break
    case 'spawn': spawnChild(c, d.url); break
    case 'focus': setActive(c.id); break
  }
})

// ---------- spawning ----------

function overlapsAny(x, y, w, h, pad = 24) {
  for (const c of cards.values()) {
    if (x < c.x + c.w + pad && x + w + pad > c.x && y < c.y + c.h + pad && y + h + pad > c.y) return true
  }
  return false
}

function findFreeSpot(x, y, w, h) {
  for (let i = 0; i < 40 && overlapsAny(x, y, w, h); i++) { x += 36; y += 36 }
  return [x, y]
}

function newCard(url, at) {
  const w = 860, h = 600
  let x, y
  if (at) { x = at.x - w / 2; y = at.y - 60 } else {
    const p = toWorld(innerWidth / 2, TOOLBAR + (innerHeight - TOOLBAR) / 2)
    x = p.x - w / 2
    y = p.y - h / 2
  }
  ;[x, y] = findFreeSpot(x, y, w, h)
  const c = createCard({ url, x, y, w, h })
  setActive(c.id)
  ensureVisible(c)
  return c
}

function spawnChild(parent, url) {
  const w = parent.w, h = parent.h
  const sibs = edges.filter(e => e.from === parent.id).length
  let x = parent.x + parent.w + 110
  let y = parent.y + sibs * 90
  ;[x, y] = findFreeSpot(x, y, w, h)
  const c = createCard({ url, x, y, w, h })
  addEdge(parent.id, c.id)
  setActive(c.id)
  flashCard(c)
  ensureVisible(c)
  return c
}

function ensureVisible(c) {
  const r = screenRect(c)
  const m = 40
  let dx = 0, dy = 0
  if (r.x + r.w > innerWidth - m) dx = innerWidth - m - (r.x + r.w)
  if (r.x < m) dx = m - r.x
  if (r.y + r.h > innerHeight - m) dy = innerHeight - m - (r.y + r.h)
  if (r.y < TOOLBAR + m) dy = TOOLBAR + m - r.y
  if (r.w > innerWidth - 2 * m || r.h > innerHeight - TOOLBAR - 2 * m) {
    // Card bigger than the window: just center it.
    animateView({
      s: V.s,
      ox: innerWidth / 2 - (c.x + c.w / 2) * V.s,
      oy: TOOLBAR + (innerHeight - TOOLBAR) / 2 - (c.y + c.h / 2) * V.s
    })
  } else if (dx || dy) {
    animateView({ s: V.s, ox: V.ox + dx, oy: V.oy + dy })
  }
}

// ---------- view animation ----------

function animateView(target, ms = 280) {
  const from = { ...V }
  const tok = ++animToken
  const t0 = performance.now()
  const ease = x => 1 - Math.pow(1 - x, 3)
  function step(now) {
    if (tok !== animToken) return
    const k = ease(Math.min(1, (now - t0) / ms))
    V.s = from.s + (target.s - from.s) * k
    V.ox = from.ox + (target.ox - from.ox) * k
    V.oy = from.oy + (target.oy - from.oy) * k
    doLayout()
    if (k < 1) requestAnimationFrame(step)
    else markDirty()
  }
  requestAnimationFrame(step)
}

function worldBBox() {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (const c of cards.values()) {
    x1 = Math.min(x1, c.x); y1 = Math.min(y1, c.y)
    x2 = Math.max(x2, c.x + c.w); y2 = Math.max(y2, c.y + c.h)
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

function fitAll() {
  if (!cards.size) return
  const b = worldBBox()
  const pad = 90
  const s = clamp(Math.min(innerWidth / (b.w + pad * 2), (innerHeight - TOOLBAR) / (b.h + pad * 2)), MIN_S, 1)
  animateView({
    s,
    ox: innerWidth / 2 - (b.x + b.w / 2) * s,
    oy: TOOLBAR + (innerHeight - TOOLBAR) / 2 - (b.y + b.h / 2) * s
  })
}

function focusCard(c) {
  if (!focusState) focusState = { prev: { ...V } }
  setActive(c.id)
  c.lastActive = Date.now()
  const s = clamp(Math.min((innerWidth - 90) / c.w, (innerHeight - TOOLBAR - 60) / c.h), 0.2, 2.2)
  animateView({
    s,
    ox: innerWidth / 2 - (c.x + c.w / 2) * s,
    oy: TOOLBAR + (innerHeight - TOOLBAR) / 2 - (c.y + c.h / 2) * s
  })
}

function exitFocus() {
  if (!focusState) return
  animateView(focusState.prev)
  focusState = null
}

function zoomAt(px, py, factor) {
  animToken++
  const ns = clamp(V.s * factor, MIN_S, MAX_S)
  V.ox = px - (px - V.ox) * (ns / V.s)
  V.oy = py - (py - V.oy) * (ns / V.s)
  V.s = ns
  markDirty()
  scheduleLayout()
}

// ---------- input ----------

function wireGlobalInput() {
  window.addEventListener('wheel', e => {
    if (e.target.closest('.no-pan')) return
    e.preventDefault()
    animToken++
    if (e.ctrlKey || e.metaKey) {
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01))
    } else {
      V.ox -= e.deltaX
      V.oy -= e.deltaY
      markDirty()
      scheduleLayout()
    }
  }, { passive: false })

  // Drag empty canvas to pan.
  viewport.addEventListener('mousedown', e => {
    if (e.target.closest('.card') || e.target.closest('#toolbar') ||
        e.target.closest('#minimap') || e.target.closest('#palette')) return
    animToken++
    const sx = e.clientX, sy = e.clientY, ox = V.ox, oy = V.oy
    const move = ev => {
      V.ox = ox + (ev.clientX - sx)
      V.oy = oy + (ev.clientY - sy)
      scheduleLayout()
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      markDirty()
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  })

  viewport.addEventListener('dblclick', e => {
    if (e.target.closest('.card') || e.target.closest('#toolbar') ||
        e.target.closest('#minimap') || e.target.closest('#palette')) return
    openPalette({ at: toWorld(e.clientX, e.clientY) })
  })

  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return
    const pan = 80
    if (e.key === 'Escape') { paletteOpen ? closePalette() : exitFocus() }
    else if (e.key === 'ArrowLeft') { V.ox += pan; scheduleLayout() }
    else if (e.key === 'ArrowRight') { V.ox -= pan; scheduleLayout() }
    else if (e.key === 'ArrowUp') { V.oy += pan; scheduleLayout() }
    else if (e.key === 'ArrowDown') { V.oy -= pan; scheduleLayout() }
  })

  window.addEventListener('resize', scheduleLayout)

  $('#btnNew').addEventListener('click', () => openPalette({}))
  $('#btnFit').addEventListener('click', fitAll)

  minimap.addEventListener('mousedown', e => {
    const t = minimapTransform()
    if (!t) return
    const r = minimap.getBoundingClientRect()
    const wx = (e.clientX - r.left - t.ox) / t.k
    const wy = (e.clientY - r.top - t.oy) / t.k
    animateView({
      s: V.s,
      ox: innerWidth / 2 - wx * V.s,
      oy: TOOLBAR + (innerHeight - TOOLBAR) / 2 - wy * V.s
    })
  })

  palInput.addEventListener('keydown', e => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      const u = normalizeInput(palInput.value)
      const mode = paletteMode
      closePalette()
      if (!u) return
      if (mode.navigateId && cards.has(mode.navigateId)) {
        navigateCard(cards.get(mode.navigateId), u)
      } else {
        newCard(u, mode.at)
      }
    } else if (e.key === 'Escape') closePalette()
  })
  palette.addEventListener('mousedown', e => { if (e.target === palette) closePalette() })
}

function startCardDrag(c, e) {
  e.preventDefault()
  setActive(c.id)
  const sx = e.clientX, sy = e.clientY, x0 = c.x, y0 = c.y
  const move = ev => {
    c.x = x0 + (ev.clientX - sx) / V.s
    c.y = y0 + (ev.clientY - sy) / V.s
    c.el.style.left = c.x + 'px'
    c.el.style.top = c.y + 'px'
    scheduleLayout()
  }
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    markDirty()
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

function startCardResize(c, e) {
  e.preventDefault()
  e.stopPropagation()
  setActive(c.id)
  const sx = e.clientX, sy = e.clientY, w0 = c.w, h0 = c.h
  const move = ev => {
    c.w = Math.max(340, w0 + (ev.clientX - sx) / V.s)
    c.h = Math.max(240, h0 + (ev.clientY - sy) / V.s)
    c.el.style.width = c.w + 'px'
    c.el.style.height = c.h + 'px'
    scheduleLayout()
  }
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    markDirty()
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

// ---------- palette ----------

function openPalette(mode) {
  paletteMode = mode || {}
  palette.classList.remove('hidden')
  palInput.value = paletteMode.prefill || ''
  paletteOpen = true
  scheduleLayout() // detaches live views so the overlay is actually on top
  window.focus()
  palInput.focus()
  palInput.select()
  setTimeout(() => palInput.focus(), 80)
}

function closePalette() {
  palette.classList.add('hidden')
  paletteOpen = false
  paletteMode = {}
  scheduleLayout()
}

// ---------- shortcuts from the app menu / page views ----------

drift.onUIKey(({ key }) => {
  switch (key) {
    case 'escape': paletteOpen ? closePalette() : exitFocus(); break
    case 'newcard': openPalette({}); break
    case 'closecard': if (activeId) closeCard(activeId); break
    case 'fit': fitAll(); break
    case 'zoomin': zoomAt(innerWidth / 2, innerHeight / 2, 1.25); break
    case 'zoomout': zoomAt(innerWidth / 2, innerHeight / 2, 0.8); break
    case 'reloadcard': if (activeId) drift.navAction(activeId, 'reload'); break
    case 'address': {
      const c = activeId && cards.get(activeId)
      if (c) openPalette({ navigateId: c.id, prefill: c.url })
      else openPalette({})
      break
    }
  }
})

// ---------- minimap ----------

function minimapTransform() {
  if (!cards.size) return null
  const b = worldBBox()
  // Include the current viewport in the bounds so the view rect stays on-map.
  const v1 = toWorld(0, 0), v2 = toWorld(innerWidth, innerHeight)
  const x1 = Math.min(b.x, v1.x), y1 = Math.min(b.y, v1.y)
  const x2 = Math.max(b.x + b.w, v2.x), y2 = Math.max(b.y + b.h, v2.y)
  const W = 180, H = 120, pad = 8
  const k = Math.min((W - pad * 2) / (x2 - x1), (H - pad * 2) / (y2 - y1))
  return { k, ox: pad + ((W - pad * 2) - (x2 - x1) * k) / 2 - x1 * k, oy: pad + ((H - pad * 2) - (y2 - y1) * k) / 2 - y1 * k }
}

function drawMinimap() {
  const show = cards.size > 0
  minimap.classList.toggle('hidden', !show)
  if (!show) return
  const ctx = minimap.getContext('2d')
  const t = minimapTransform()
  ctx.setTransform(2, 0, 0, 2, 0, 0) // canvas is 360x240 for 180x120 css px
  ctx.clearRect(0, 0, 180, 120)
  for (const c of cards.values()) {
    ctx.fillStyle = c.id === activeId ? 'rgba(94,234,212,0.85)' : 'rgba(139,147,167,0.55)'
    ctx.fillRect(t.ox + c.x * t.k, t.oy + c.y * t.k, Math.max(3, c.w * t.k), Math.max(2, c.h * t.k))
  }
  const v1 = toWorld(0, 0), v2 = toWorld(innerWidth, innerHeight)
  ctx.strokeStyle = 'rgba(94,234,212,0.9)'
  ctx.lineWidth = 1
  ctx.strokeRect(t.ox + v1.x * t.k, t.oy + v1.y * t.k, (v2.x - v1.x) * t.k, (v2.y - v1.y) * t.k)
}

// ---------- persistence ----------

function serialize() {
  return {
    v: 1,
    seq,
    view: { ...V },
    cards: [...cards.values()].map(c => ({
      id: c.id, url: c.url, title: c.title, fav: c.fav,
      x: c.x, y: c.y, w: c.w, h: c.h,
      snapshot: c.snapshot, createdAt: c.createdAt, lastActive: c.lastActive
    })),
    edges: edges.map(e => ({ ...e }))
  }
}

function restore(st) {
  seq = st.seq || 0
  if (st.view && Number.isFinite(st.view.s)) {
    V.s = clamp(st.view.s, MIN_S, MAX_S)
    V.ox = st.view.ox
    V.oy = st.view.oy
  }
  for (const d of st.cards) createCard(d, { restored: true })
  for (const e of st.edges || []) addEdge(e.from, e.to, true)
  dirty = false
}

function firstRun() {
  // A tiny demo trail: the idea Drift is built on, and the essay it came from.
  const a = createCard({ url: 'https://en.wikipedia.org/wiki/Memex', x: 0, y: 0, w: 820, h: 580 })
  const b = createCard({ url: 'https://en.wikipedia.org/wiki/As_We_May_Think', x: 940, y: 120, w: 820, h: 580 })
  addEdge(a.id, b.id)
  setActive(a.id)
  fitAll()
}

// ---------- selftest ----------

const selftestErrors = []
window.addEventListener('error', e => selftestErrors.push(String(e.message)))
window.addEventListener('unhandledrejection', e => selftestErrors.push('rejection: ' + String(e.reason)))

async function runSelftest() {
  const report = { errors: selftestErrors, cards: [] }
  try {
    const a = createCard({ url: 'https://example.com', x: 0, y: 260, w: 760, h: 540 })
    const b = createCard({ url: 'https://en.wikipedia.org/wiki/Memex', x: 880, y: 0, w: 760, h: 540 })
    const c = createCard({ url: 'https://en.wikipedia.org/wiki/As_We_May_Think', x: 880, y: 640, w: 760, h: 540 })
    addEdge(a.id, b.id)
    addEdge(a.id, c.id)
    fitAll()

    const t0 = Date.now()
    while (Date.now() - t0 < 25000) {
      if ([a, b, c].every(x => x.everLoaded)) break
      await sleep(300)
    }
    await sleep(1500)
    for (const x of [a, b, c]) await takeSnapshot(x, true)

    // Close-up proof that a real page rendered.
    focusCard(b)
    await sleep(900)
    const shot = await drift.snapshot(b.id, 1200)
    if (shot) await drift.selftestArtifact('selftest-page.png', shot)
    else report.errors.push('page snapshot failed')

    // Zoom out past the live threshold: constellation of DOM thumbnails,
    // which the main process can capture as one image.
    exitFocus()
    await sleep(400)
    const bb = worldBBox()
    const s = 0.3
    animateView({
      s,
      ox: innerWidth / 2 - (bb.x + bb.w / 2) * s,
      oy: TOOLBAR + (innerHeight - TOOLBAR) / 2 - (bb.y + bb.h / 2) * s
    }, 200)
    await sleep(1200)

    report.cards = [a, b, c].map(x => ({
      url: x.url, title: x.title, loaded: x.everLoaded, hasSnapshot: !!x.snapshot
    }))
    for (const x of [a, b, c]) if (!x.everLoaded) report.errors.push('did not finish loading: ' + x.url)
  } catch (err) {
    report.errors.push(String(err && err.stack || err))
  }
  await drift.selftestDone(report)
}

// ---------- boot ----------

async function init() {
  wireGlobalInput()
  if (!SELF) {
    const st = await drift.loadState()
    if (st && Array.isArray(st.cards) && st.cards.length) restore(st)
    else firstRun()
  }
  updateEmpty()
  scheduleLayout()

  setInterval(() => {
    for (const c of cards.values()) if (c.live) takeSnapshot(c)
  }, 20000)

  setInterval(() => {
    if (dirty && !SELF) { dirty = false; drift.saveState(serialize()) }
  }, 2500)
  window.addEventListener('blur', () => {
    if (dirty && !SELF) { dirty = false; drift.saveState(serialize()) }
  })

  if (SELF) runSelftest()
}

init()
