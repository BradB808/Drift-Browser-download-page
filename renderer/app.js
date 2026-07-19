// Drift canvas — the whole browser UI. Pages are cards on an infinite
// zoomable canvas; live Chromium views are positioned over each card's body
// by the main process, while zoomed-out cards fall back to DOM snapshots.

/* global drift */

const SELF = new URLSearchParams(location.search).get('selftest') === '1'
const PROMO = new URLSearchParams(location.search).get('promo') === '1'
const HEADLESS = SELF || PROMO // staged runs: no saved state, no tour, no persistence

// ---------- constants ----------

const HEAD = 36          // card header height, world units
const INSET = 8          // frame ring around page content, world units
const TOOLBAR = 60       // screen px reserved at top (floating toolbar)
const LIVE_ON = 0.42     // canvas zoom at which cards go live
const LIVE_OFF = 0.38    // hysteresis: zoom below this detaches them
const MAX_LIVE = 10      // max simultaneously attached Chromium views
const KEEP_ALIVE = 12    // max background webContents before LRU destroy
const VIS_MARGIN = 220   // px of offscreen slack still counted as visible
const MIN_S = 0.06, MAX_S = 2.5
const ZONE_COLORS = ['#ff9a5e', '#ff6f91', '#ffd166', '#b78cff', '#6ee7a0', '#5ecfe6'] // defaults, warm first

// ---------- state ----------

const V = { s: 0.9, ox: 60, oy: 90 } // world→screen: screen = world*s + o
const cards = new Map()              // id -> card
const zones = new Map()              // id -> zone
const edges = []                     // { from, to }
let seq = 0
let activeId = null
let prevActiveId = null              // the card that was active before this one
let focusState = null                // { prev: {s,ox,oy} }
let splitInfo = null                 // { movedId, home: {x,y} } during split focus
let fullId = null                    // card whose live view covers the whole window
let aiBrakeEpoch = 0                 // bumped on Escape so an in-flight present_card bails
let paletteOpen = false
let paletteMode = {}
let palHits = []                     // cards matching the palette query
let palRows = []                     // selectable rows: {type:'card',c} | {type:'bm',b}
let palRowEls = []
let palSel = -1                      // -1 = "open as address" row
let bookmarks = []                   // [{url, title, fav, t, folder}], saved outside canvas state
let bmFolders = []                   // folder names (kept even when empty)
let bmSet = new Set()                // urls, for O(1) star state
let bmCollapsed = new Set()          // folder names collapsed in the panel
const closedStack = []               // recently closed cards, newest last (max 20)
let hitSet = new Set()               // ids highlighted on canvas/minimap
let ctxOpenFor = null
let tourOpen = false
let tourIdx = 0
let tourPhase = 'intro'              // 'intro' (cinematic welcome scene) | 'steps' (coach-marks)
let bmOpen = false
let settingsOpen = false
let settings = { bg: { mode: 'photos' } } // loaded from disk at boot
let dirty = false
let snapDirty = false                // only thumbnails changed; persisted lazily, not per-save-tick
let layoutQueued = false
let animToken = 0
let animHardUntil = 0                // wheel input ignored until then, so trackpad momentum can't kill a deliberate glide
let viewFreeze = false               // during zoom animations, pages show snapshots
let aiDockW = 0                      // width reserved on the right for the AI chat dock (native view), 0 when closed

// ---------- dom ----------

const $ = s => document.querySelector(s)
const viewport = $('#viewport')
const gridEl = $('#grid')
const world = $('#world')
const cardsEl = $('#cards')
const zonesEl = $('#zones')
const edgeG = $('#edgeG')
const zoomPct = $('#zoomPct')
const emptyEl = $('#empty')
const minimap = $('#minimap')
const palette = $('#palette')
const palInput = $('#palInput')
const palResults = $('#palResults')
const palHint = $('#palHint')
const ctxEl = $('#ctx')
const toastEl = $('#toast')
const tourEl = $('#tour')
const tourSpot = $('#tourSpot')
const tourCard = $('#tourCard')
const introEl = $('#introScene')

// ---------- helpers ----------

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const uid = p => (p || 'c') + (++seq) + '_' + Math.random().toString(36).slice(2, 7)

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return String(url == null ? '' : url) }
}

function normalizeInput(q) {
  q = q.trim()
  if (!q) return null
  if (/^https?:\/\//i.test(q)) return q
  if (/^localhost(:\d+)?(\/.*)?$/.test(q)) return 'http://' + q
  if (!q.includes(' ') && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(q)) return 'https://' + q
  return 'https://www.google.com/search?q=' + encodeURIComponent(q)
}

const toWorld = (x, y) => ({ x: (x - V.ox) / V.s, y: (y - V.oy) / V.s })

// Usable canvas width: the AI dock (a native view on the right) covers its
// strip, so camera framing centers content in what's left of the window.
const viewW = () => innerWidth - aiDockW

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

function copyText(t) {
  navigator.clipboard.writeText(t).catch(() => {
    const ta = document.createElement('textarea')
    ta.value = t
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  })
}

let toastTimer = 0
function toast(msg) {
  toastEl.textContent = msg
  toastEl.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400)
}

function hexToRgba(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return `rgba(255, 154, 94, ${a})`
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

// Legacy zones stored an HSL hue instead of a color.
function hueToHex(h) {
  // hsl(h, 75%, 62%) → hex; a = s * min(l, 1-l) = 0.75 * 0.38
  const f = n => {
    const k = (n + h / 30) % 12
    const c = 0.62 - 0.285 * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(255 * Math.min(1, Math.max(0, c))).toString(16).padStart(2, '0')
  }
  return '#' + f(0) + f(8) + f(4)
}

// ---------- cards ----------

// Coerce a persisted/injected number to a finite value — a corrupt state file
// (partial write, disk fault, hand-edit) with a NaN/null coordinate must never
// poison contentBBox → fitAll → the whole V transform (canvas goes invisible).
function num(v, fallback) {
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : fallback
}

function createCard(d, opts = {}) {
  // Coerce persisted strings too — a corrupt state file with a numeric url or
  // title would otherwise crash string ops like palette search (.toLowerCase).
  const url = typeof d.url === 'string' ? d.url : (d.url == null ? '' : String(d.url))
  const c = {
    id: (typeof d.id === 'string' && d.id) ? d.id : (d.id != null ? String(d.id) : uid('c')),
    url,
    title: (typeof d.title === 'string' && d.title) || hostOf(url),
    fav: typeof d.fav === 'string' ? d.fav : null,
    x: num(d.x, 0), y: num(d.y, 0),
    w: Math.max(340, num(d.w, 860)), h: Math.max(240, num(d.h, 600)),
    snapshot: d.snapshot || null,
    createdAt: d.createdAt || Date.now(),
    lastActive: d.lastActive || Date.now(),
    live: false, wantLive: false, retiring: false,
    viewCreated: false, viewReady: false,
    loading: false, error: null,
    lastSnap: 0, snapPending: false, everLoaded: false,
    moveToken: 0
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
      <button class="nb b-star" title="Bookmark this page">☆</button>
      <button class="nb b-full" title="Full screen (esc exits)">⛶</button>
      <button class="nb b-focus" title="Focus · shift-click to split with previous card">⤢</button>
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
    <div class="grip"></div>
    <div class="port" title="Drag onto another card to connect a trail"></div>`
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
  c.starBtn = el.querySelector('.b-star')

  if (c.snapshot) { c.snapEl.src = c.snapshot; c.snapEl.classList.remove('hidden') }
  renderHead(c)

  const head = el.querySelector('.head')

  el.addEventListener('mousedown', () => { setActive(c.id); drift.raise(c.id) })

  el.addEventListener('contextmenu', e => {
    e.preventDefault()
    openCtx(c, e.clientX, e.clientY)
  })

  head.addEventListener('mousedown', e => {
    if (e.target.closest('button') || e.target.closest('input')) return
    startCardDrag(c, e)
  })
  head.addEventListener('dblclick', e => {
    if (e.target.closest('button') || e.target.closest('input')) return
    const prev = prevActiveId && prevActiveId !== c.id ? cards.get(prevActiveId) : null
    if (e.shiftKey && prev) focusPair(prev, c)
    else focusCard(c)
  })

  // Clicking a zoomed-out thumbnail dives into that page.
  el.querySelector('.body').addEventListener('click', () => { if (!c.live) focusCard(c) })

  el.querySelector('.b-close').addEventListener('click', e => { e.stopPropagation(); closeCard(c.id) })
  el.querySelector('.b-reload').addEventListener('click', e => {
    e.stopPropagation()
    if (c.viewCreated) drift.navAction(c.id, 'reload')
  })
  c.starBtn.addEventListener('click', e => { e.stopPropagation(); toggleBookmark(c) })
  el.querySelector('.b-full').addEventListener('click', e => { e.stopPropagation(); enterFullscreen(c) })
  el.querySelector('.b-focus').addEventListener('click', e => {
    e.stopPropagation()
    const prev = prevActiveId && prevActiveId !== c.id ? cards.get(prevActiveId) : null
    if (e.shiftKey && prev) focusPair(prev, c)
    else focusCard(c)
  })
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
  el.querySelector('.port').addEventListener('mousedown', e => startLinkDrag(c, e))
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
  const bm = bmSet.has(c.url)
  c.starBtn.textContent = bm ? '★' : '☆'
  c.starBtn.classList.toggle('on', bm)
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
  prevActiveId = activeId
  activeId = id
  const c = cards.get(id)
  if (c) { c.el.classList.add('active'); c.lastActive = Date.now() }
}

function closeCard(id) {
  const c = cards.get(id)
  if (!c) return
  if (c.isPanel) {
    // Transient extension UI — forget it (so it can reopen) and don't push it onto
    // the reopen stack.
    for (const [k, v] of panelCards) if (v === id) panelCards.delete(k)
    if (c.viewCreated) drift.destroyView(id)
    unmountCardExtActions(c)
    c.el.remove()
    cards.delete(id)
    for (let i = edges.length - 1; i >= 0; i--) {
      if (edges[i].from === id || edges[i].to === id) removeEdgeEl(edges[i]), edges.splice(i, 1)
    }
    if (activeId === id) activeId = null
    if (prevActiveId === id) prevActiveId = null
    if (fullId === id) exitFullscreen()
    hitSet.delete(id)
    updateEmpty()
    scheduleLayout()
    return
  }
  // Closing a page also closes any side panels bound to it, so they don't linger
  // as dead UI pointing at a destroyed tab.
  const orphanPanels = []
  for (const [k, panelId] of panelCards) if (k.endsWith('|' + id) && cards.has(panelId)) orphanPanels.push(panelId)
  orphanPanels.forEach(pid => closeCard(pid))
  // Remember it (with its trail partners) so "Reopen closed card" can undo this.
  const links = []
  for (const e of edges) {
    if (e.from === id) links.push(e.to)
    else if (e.to === id) links.push(e.from)
  }
  closedStack.push({
    url: c.url, title: c.title, fav: c.fav,
    x: c.x, y: c.y, w: c.w, h: c.h,
    snapshot: c.snapshot, links, t: Date.now()
  })
  if (closedStack.length > 20) closedStack.shift()
  if (c.viewCreated) drift.destroyView(id)
  c.el.remove()
  cards.delete(id)
  for (let i = edges.length - 1; i >= 0; i--) {
    if (edges[i].from === id || edges[i].to === id) removeEdgeEl(edges[i]), edges.splice(i, 1)
  }
  if (splitInfo && splitInfo.movedId === id) splitInfo = null
  if (fullId === id) exitFullscreen()
  if (activeId === id) activeId = null
  if (prevActiveId === id) prevActiveId = null
  hitSet.delete(id)
  updateEmpty()
  markDirty()
  scheduleLayout()
}

function updateEmpty() { emptyEl.classList.toggle('hidden', cards.size > 0 || HEADLESS) }

function reopenClosed() {
  const d = closedStack.pop()
  if (!d) { toast('Nothing to reopen'); return null }
  let x = d.x, y = d.y
  if (overlapsAny(x, y, d.w, d.h, 0)) [x, y] = findFreeSpot(x + 36, y + 36, d.w, d.h)
  const c = createCard({
    url: d.url, title: d.title, fav: d.fav, snapshot: d.snapshot,
    x, y, w: d.w, h: d.h
  })
  for (const pid of d.links) if (cards.has(pid)) addEdge(pid, c.id)
  setActive(c.id)
  flashCard(c)
  ensureVisible(c)
  autoGrowZones()
  toast(`Reopened “${(d.title || hostOf(d.url)).slice(0, 40)}”`)
  return c
}

function flashCard(c) {
  c.el.classList.remove('flash')
  void c.el.offsetWidth
  c.el.classList.add('flash')
}

// ---------- zones ----------
// Named regions on the canvas ("Trip planning", "Job hunt"). Dragging a zone
// by its label carries every card whose center sits inside it.

function createZone(d = {}) {
  const z = {
    id: d.id || uid('z'),
    name: d.name || 'Untitled zone',
    x: d.x, y: d.y, w: d.w || 1200, h: d.h || 800,
    color: /^#[0-9a-f]{6}$/i.test(d.color || '') ? d.color
      : Number.isFinite(d.hue) ? hueToHex(d.hue) // legacy hue-based zones
      : ZONE_COLORS[zones.size % ZONE_COLORS.length]
  }
  buildZoneDom(z)
  zones.set(z.id, z)
  markDirty()
  scheduleLayout()
  return z
}

function rectHitsAnything(x, y, w, h, pad) {
  for (const z of zones.values()) {
    if (x < z.x + z.w + pad && x + w + pad > z.x && y < z.y + z.h + pad && y + h + pad > z.y) return z
  }
  for (const c of cards.values()) {
    if (x < c.x + c.w + pad && x + w + pad > c.x && y < c.y + c.h + pad && y + h + pad > c.y) return c
  }
  return null
}

// Pan (never zoom) so a world rect is on screen.
function ensureRectVisible(r) {
  const m = 60
  const sx = r.x * V.s + V.ox, sy = r.y * V.s + V.oy
  const sw = r.w * V.s, sh = r.h * V.s
  if (sx >= m && sy >= TOOLBAR + m && sx + sw <= innerWidth - m && sy + sh <= innerHeight - m) return
  animateView({
    s: V.s,
    ox: innerWidth / 2 - (r.x + r.w / 2) * V.s,
    oy: TOOLBAR + (innerHeight - TOOLBAR) / 2 - (r.y + r.h / 2) * V.s
  })
}

function newZone() {
  const p = toWorld(innerWidth / 2, TOOLBAR + (innerHeight - TOOLBAR) / 2)
  const w = Math.max(900, (innerWidth * 0.55) / V.s)
  const h = Math.max(620, (innerHeight * 0.55) / V.s)
  // A fresh zone must start empty: slide beside whatever zone or card is in
  // the way instead of spawning on top and swallowing its contents.
  let x = p.x - w / 2, y = p.y - h / 2
  for (let i = 0; i < 50; i++) {
    const hit = rectHitsAnything(x, y, w, h, 70)
    if (!hit) break
    x = hit.x + hit.w + 90
  }
  const z = createZone({ x, y, w, h })
  ensureRectVisible(z)
  startZoneRename(z)
  return z
}

function buildZoneDom(z) {
  const el = document.createElement('div')
  el.className = 'zone'
  el.innerHTML = `
    <div class="zlabel">
      <span class="zdot" title="Change color"></span>
      <input class="zpick" type="color" tabindex="-1">
      <span class="zname"></span>
      <input class="znameedit hidden" spellcheck="false">
      <span class="zcount"></span>
      <button class="zclose" title="Remove zone (cards stay)">×</button>
    </div>
    <div class="zgrip"></div>`
  zonesEl.appendChild(el)

  z.el = el
  z.nameEl = el.querySelector('.zname')
  z.editEl = el.querySelector('.znameedit')
  z.countEl = el.querySelector('.zcount')
  z.pickEl = el.querySelector('.zpick')
  z.nameEl.textContent = z.name
  positionZone(z)
  applyZoneColor(z)

  const label = el.querySelector('.zlabel')
  label.addEventListener('mousedown', e => {
    if (e.target.closest('.zclose') || e.target.closest('.zdot') ||
        e.target.closest('.znameedit') || e.target.closest('.zpick')) return
    startZoneDrag(z, e)
  })
  // The dot opens the OS color wheel (with hex entry) via a hidden color input.
  el.querySelector('.zdot').addEventListener('click', e => {
    e.stopPropagation()
    z.pickEl.value = z.color
    z.pickEl.click()
  })
  z.pickEl.addEventListener('input', () => {
    z.color = z.pickEl.value
    applyZoneColor(z)
    markDirty()
    scheduleLayout()
  })
  el.querySelector('.zclose').addEventListener('click', e => { e.stopPropagation(); removeZone(z.id) })
  el.querySelector('.zgrip').addEventListener('mousedown', e => startZoneResize(z, e))

  z.editEl.addEventListener('keydown', e => {
    e.stopPropagation()
    if (e.key === 'Enter') endZoneRename(z, true)
    else if (e.key === 'Escape') endZoneRename(z, false)
  })
  z.editEl.addEventListener('blur', () => endZoneRename(z, true))
  z.editEl.addEventListener('mousedown', e => e.stopPropagation())
}

function positionZone(z) {
  z.el.style.left = z.x + 'px'
  z.el.style.top = z.y + 'px'
  z.el.style.width = z.w + 'px'
  z.el.style.height = z.h + 'px'
}

function applyZoneColor(z) { z.el.style.setProperty('--zc', z.color) }

function removeZone(id) {
  const z = zones.get(id)
  if (!z) return
  z.el.remove()
  zones.delete(id)
  markDirty()
  scheduleLayout()
}

function cardsInZone(z) {
  const out = []
  for (const c of cards.values()) {
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2
    if (cx >= z.x && cx <= z.x + z.w && cy >= z.y && cy <= z.y + z.h) out.push(c)
  }
  return out
}

// A zone grows to keep containing any member card that outgrows it —
// resize a card past the border and the zone stretches around it.
function autoGrowZones() {
  const PAD = 28
  let changed = false
  for (const z of zones.values()) {
    for (const c of cards.values()) {
      const cx = c.x + c.w / 2, cy = c.y + c.h / 2
      if (cx < z.x || cx > z.x + z.w || cy < z.y || cy > z.y + z.h) continue
      const nx = Math.min(z.x, c.x - PAD)
      const ny = Math.min(z.y, c.y - PAD)
      const nx2 = Math.max(z.x + z.w, c.x + c.w + PAD)
      const ny2 = Math.max(z.y + z.h, c.y + c.h + PAD)
      if (nx !== z.x || ny !== z.y || nx2 !== z.x + z.w || ny2 !== z.y + z.h) {
        z.x = nx; z.y = ny; z.w = nx2 - nx; z.h = ny2 - ny
        positionZone(z)
        changed = true
      }
    }
  }
  if (changed) { markDirty(); scheduleLayout() }
}

function updateZoneCount(z) {
  const n = cardsInZone(z).length
  const s = n ? String(n) : ''
  if (z.countEl.textContent !== s) z.countEl.textContent = s
}

function startZoneRename(z) {
  z.nameEl.classList.add('hidden')
  z.editEl.classList.remove('hidden')
  z.editEl.value = z.name
  z.editEl.focus()
  z.editEl.select()
}

function endZoneRename(z, commit) {
  if (commit) {
    const v = z.editEl.value.trim()
    if (v && v !== z.name) { z.name = v; markDirty() }
  }
  z.nameEl.textContent = z.name
  z.editEl.classList.add('hidden')
  z.nameEl.classList.remove('hidden')
}

function startZoneDrag(z, e) {
  if (e.button !== 0) return
  e.preventDefault()
  const sx = e.clientX, sy = e.clientY, x0 = z.x, y0 = z.y
  const renameTarget = !!e.target.closest('.zname')
  const members = cardsInZone(z).map(c => {
    c.moveToken++ // cancel any in-flight card animation
    return { c, x0: c.x, y0: c.y }
  })
  let moved = 0
  const move = ev => {
    const dx = (ev.clientX - sx) / V.s
    const dy = (ev.clientY - sy) / V.s
    moved = Math.max(moved, Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy))
    z.x = x0 + dx
    z.y = y0 + dy
    positionZone(z)
    for (const m of members) {
      m.c.x = m.x0 + dx
      m.c.y = m.y0 + dy
      m.c.el.style.left = m.c.x + 'px'
      m.c.el.style.top = m.c.y + 'px'
    }
    scheduleLayout()
  }
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    markDirty()
    if (moved < 5 && renameTarget) startZoneRename(z)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

function startZoneResize(z, e) {
  if (e.button !== 0) return
  e.preventDefault()
  e.stopPropagation()
  const sx = e.clientX, sy = e.clientY, w0 = z.w, h0 = z.h
  const move = ev => {
    z.w = Math.max(320, w0 + (ev.clientX - sx) / V.s)
    z.h = Math.max(240, h0 + (ev.clientY - sy) / V.s)
    positionZone(z)
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
  if (el) { el.path.remove(); el.dot.remove(); el.hit.remove(); edgeEls.delete(edgeKey(e)) }
}

function removeEdge(from, to) {
  const i = edges.findIndex(e => e.from === from && e.to === to)
  if (i < 0) return false
  removeEdgeEl(edges[i])
  edges.splice(i, 1)
  markDirty()
  scheduleLayout()
  return true
}

function edgeBetween(aId, bId) {
  return edges.find(e => (e.from === aId && e.to === bId) || (e.from === bId && e.to === aId))
}

function connectCards(a, b) {
  if (!a || !b || a === b) return
  if (edgeBetween(a.id, b.id)) { toast('Already connected'); return }
  addEdge(a.id, b.id)
  flashCard(b)
  toast('Trail connected — double-click a trail to remove it')
}

// Drag from a card's ○ port onto another card to draw a trail by hand.
function startLinkDrag(c, e) {
  if (e.button !== 0) return
  e.preventDefault()
  e.stopPropagation()
  const temp = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  temp.setAttribute('class', 'linkdrag')
  edgeG.appendChild(temp)
  const p1 = { x: c.x + c.w, y: c.y + c.h / 2 }
  let target = null
  let moved = false
  const move = ev => {
    moved = true
    const p2 = toWorld(ev.clientX, ev.clientY)
    const dx = Math.max(60, Math.abs(p2.x - p1.x) / 2) * (p2.x >= p1.x ? 1 : -1)
    temp.setAttribute('d', `M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y}, ${p2.x - dx} ${p2.y}, ${p2.x} ${p2.y}`)
    const el = document.elementFromPoint(ev.clientX, ev.clientY)
    const cardEl = el && el.closest('.card')
    const t = cardEl ? cards.get(cardEl.dataset.id) : null
    if (target && target !== t) target.el.classList.remove('linktarget')
    target = t && t !== c ? t : null
    if (target) target.el.classList.add('linktarget')
  }
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    temp.remove()
    if (target) {
      target.el.classList.remove('linktarget')
      connectCards(c, target)
    } else if (moved) {
      toast('Drop on another card to connect a trail')
    }
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

function updateEdges() {
  for (const e of edges) {
    const a = cards.get(e.from), b = cards.get(e.to)
    if (!a || !b) continue
    let el = edgeEls.get(edgeKey(e))
    if (!el) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      // A trail is ~2px wide on screen — impossible to double-click. The hit
      // path is an invisible fat twin that takes the pointer events.
      const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      hit.setAttribute('class', 'edgehit')
      hit.addEventListener('dblclick', ev => {
        ev.stopPropagation()
        removeEdge(e.from, e.to)
        toast('Trail removed')
      })
      hit.addEventListener('mouseenter', () => { path.style.stroke = 'var(--accent)' })
      hit.addEventListener('mouseleave', () => { path.style.stroke = '' })
      edgeG.appendChild(path)
      edgeG.appendChild(dot)
      edgeG.appendChild(hit)
      el = { path, dot, hit }
      edgeEls.set(edgeKey(e), el)
    }
    const goRight = (b.x + b.w / 2) >= (a.x + a.w / 2)
    const p1 = { x: goRight ? a.x + a.w : a.x, y: a.y + a.h / 2 }
    const p2 = { x: goRight ? b.x : b.x + b.w, y: b.y + b.h / 2 }
    const dx = Math.max(60, Math.abs(p2.x - p1.x) / 2) * (goRight ? 1 : -1)
    const d = `M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y}, ${p2.x - dx} ${p2.y}, ${p2.x} ${p2.y}`
    // Re-setting identical attributes still invalidates the SVG (a repaint per
    // edge per frame during pans) — write only what actually changed.
    if (el.d !== d) {
      el.path.setAttribute('d', d)
      el.hit.setAttribute('d', d)
      el.dot.setAttribute('cx', p2.x)
      el.dot.setAttribute('cy', p2.y)
      el.d = d
    }
    if (el.zs !== V.s) {
      el.hit.setAttribute('stroke-width', String(16 / V.s))
      el.dot.setAttribute('r', 5 / V.s)
      el.zs = V.s
    }
  }
}

// The connected component around a card — its full trail, both directions.
function trailOf(id) {
  const seen = new Set([id])
  const q = [id]
  while (q.length) {
    const cur = q.shift()
    for (const e of edges) {
      const nxt = e.from === cur ? e.to : e.to === cur ? e.from : null
      if (nxt && !seen.has(nxt)) { seen.add(nxt); q.push(nxt) }
    }
  }
  return seen
}

// Export a trail as a nested Markdown link list, parents above children.
function trailMarkdown(id) {
  const comp = trailOf(id)
  const kids = new Map()
  const hasParent = new Set()
  for (const e of edges) {
    if (!comp.has(e.from) || !comp.has(e.to)) continue
    if (!kids.has(e.from)) kids.set(e.from, [])
    kids.get(e.from).push(e.to)
    hasParent.add(e.to)
  }
  const roots = [...comp].filter(x => !hasParent.has(x))
  const lines = []
  const seen = new Set()
  const emit = (cid, depth) => {
    if (seen.has(cid)) return
    seen.add(cid)
    const c = cards.get(cid)
    if (!c) return
    const title = (c.title || hostOf(c.url) || c.url).replace(/[\[\]]/g, '')
    lines.push('  '.repeat(depth) + `- [${title}](${c.url})`)
    for (const k of kids.get(cid) || []) emit(k, depth + 1)
  }
  for (const r of roots) emit(r, 0)
  for (const cid of comp) emit(cid, 0) // safety net for pure cycles
  return lines.join('\n')
}

// ---------- context menu ----------

function renderCtxMenu(items, x, y) {
  ctxEl.innerHTML = ''
  for (const it of items) {
    const d = document.createElement('div')
    d.className = 'ctxitem' + (it.danger ? ' danger' : '')
    d.textContent = it.label
    d.addEventListener('click', () => { closeCtx(); it.fn() })
    ctxEl.appendChild(d)
  }
  ctxEl.classList.remove('hidden')
  const r = ctxEl.getBoundingClientRect()
  ctxEl.style.left = clamp(x, 8, viewW() - r.width - 8) + 'px'
  ctxEl.style.top = clamp(y, TOOLBAR, innerHeight - r.height - 8) + 'px'
  scheduleLayout() // detach live views so the menu is actually on top
}

function reopenCtxItem() {
  const d = closedStack[closedStack.length - 1]
  if (!d) return null
  return {
    label: `Reopen closed card (“${(d.title || hostOf(d.url)).slice(0, 24)}”)`,
    fn: reopenClosed
  }
}

function openCanvasCtx(x, y) {
  ctxOpenFor = 'canvas'
  const at = toWorld(x, y)
  const items = [
    { label: 'New card here', fn: () => openPalette({ at }) }
  ]
  const reopen = reopenCtxItem()
  if (reopen) items.push(reopen)
  items.push({ label: 'New zone', fn: newZone })
  renderCtxMenu(items, x, y)
}

function openCtx(c, x, y, linkURL) {
  ctxOpenFor = c.id
  const comp = trailOf(c.id)
  // Trail partner: the previously active card if it still exists, otherwise
  // the most recently used other card — so connect/disconnect is always
  // offered once a second card exists.
  const prev = (prevActiveId && prevActiveId !== c.id && cards.get(prevActiveId)) ||
    [...cards.values()].filter(x => x.id !== c.id).sort((a, b) => b.lastActive - a.lastActive)[0] || null
  const items = []
  if (linkURL) {
    items.push({ label: 'Open link as connected card', fn: () => spawnChild(c, linkURL) })
  }
  items.push(
    { label: 'Copy address', fn: () => { copyText(c.url); toast('Address copied') } },
    {
      label: `Copy trail as Markdown (${comp.size} page${comp.size === 1 ? '' : 's'})`,
      fn: () => { copyText(trailMarkdown(c.id)); toast(`Copied trail · ${comp.size} page${comp.size === 1 ? '' : 's'}`) }
    }
  )
  items.push({
    label: bmSet.has(c.url) ? 'Remove bookmark' : 'Bookmark this page',
    fn: () => toggleBookmark(c)
  })
  if (prev) {
    const t = (prev.title || hostOf(prev.url)).slice(0, 26)
    const between = edgeBetween(prev.id, c.id)
    items.push(between
      ? { label: `Disconnect trail to “${t}”`, fn: () => { removeEdge(between.from, between.to); toast('Trail removed') } }
      : { label: `Connect trail to “${t}”`, fn: () => connectCards(prev, c) })
    items.push({ label: `Split focus with “${t}”`, fn: () => focusPair(prev, c) })
  }
  const reopen = reopenCtxItem()
  if (reopen) items.push(reopen)
  items.push({ label: 'Close card', danger: true, fn: () => closeCard(c.id) })

  renderCtxMenu(items, x, y)
}

function closeCtx() {
  if (!ctxOpenFor) return
  ctxEl.classList.add('hidden')
  ctxOpenFor = null
  scheduleLayout()
}

// ---------- layout / liveness ----------

function scheduleLayout() {
  if (!layoutQueued) {
    layoutQueued = true
    requestAnimationFrame(doLayout)
  }
}

// setZoomFactor forces a full relayout inside every live page, so re-zooming
// N views on every frame of a pinch/wheel gesture is N page relayouts per
// frame. Bounds stay exact each frame; the content zoom factor steps at ~8Hz
// and a trailing pass lands the exact value right after the gesture stops.
let zoomSent = null, zoomSentAt = 0, zoomTrail = 0
function throttledZoom(z) {
  const now = performance.now()
  if (zoomSent === null || z === zoomSent || now - zoomSentAt >= 120) {
    if (z !== zoomSent) { zoomSent = z; zoomSentAt = now }
    return z
  }
  clearTimeout(zoomTrail)
  zoomTrail = setTimeout(scheduleLayout, 140 - (now - zoomSentAt))
  return zoomSent
}
// Animations end on a known exact zoom — bypass the throttle so the landing
// frame is crisp (and matches any prezoomed view, avoiding a double relayout).
function flushZoom() { zoomSent = null }

let gridS = 0
let edgeGroupS = 0
function doLayout() {
  layoutQueued = false
  world.style.transform = `translate(${V.ox}px, ${V.oy}px) scale(${V.s})`
  // The dot grid pans by compositor transform (free) instead of background-
  // position (a full-screen repaint per frame). #grid is oversized by one
  // tile (72px inset in CSS) so the translate never exposes a bare edge;
  // only zoom changes still repaint it (the tile pitch really changes then).
  const ts = 24 * V.s
  if (gridS !== V.s) { gridEl.style.backgroundSize = `${ts}px ${ts}px`; gridS = V.s }
  gridEl.style.transform = `translate(${(((V.ox + 72) % ts) + ts) % ts}px, ${(((V.oy + 72) % ts) + ts) % ts}px)`
  if (edgeGroupS !== V.s) { edgeG.setAttribute('stroke-width', String(2.5 / V.s)); edgeGroupS = V.s }
  if (zones.size) {
    // Zone labels counter-scale so they stay readable from orbit.
    zonesEl.style.setProperty('--zfs', clamp(14 / V.s, 13, 60) + 'px')
    for (const z of zones.values()) updateZoneCount(z)
  }
  decideLiveness()
  const items = []
  if (fullId && cards.has(fullId)) {
    // Fullscreen: one page owns the entire area under the toolbar, at 100%.
    const c = cards.get(fullId)
    if (c.live && c.viewReady) {
      // Leave the dock's strip uncovered so chat and the fullscreen page coexist.
      items.push({ id: c.id, x: 0, y: TOOLBAR, w: viewW(), h: innerHeight - TOOLBAR })
    }
  } else {
    for (const c of cards.values()) {
      if (c.live && c.viewReady) {
        const r = screenBodyRect(c)
        items.push({ id: c.id, x: r.x, y: r.y, w: r.w, h: r.h })
      }
    }
  }
  drift.layout({ zoom: throttledZoom(fullId ? 1 : V.s), items })
  zoomPct.textContent = Math.round(V.s * 100) + '%'
  updateEdges()
  drawMinimap()
  if (tourOpen) positionTour() // spotlight tracks its target through pans/zooms
  if (bmOpen) positionBmPanel()
  if (vaultOpen) positionVaultPanel()
  if (settingsOpen) positionSettingsPanel()
  pruneViews()
}

function decideLiveness() {
  const vw = innerWidth, vh = innerHeight
  // Native page views always sit above the DOM, so any interactive overlay
  // (palette, context menu, tour, bookmarks panel) needs the views detached.
  const overlay = paletteOpen || tourOpen || bmOpen || vaultOpen || settingsOpen || !!ctxOpenFor || viewFreeze
  const want = []
  for (const c of cards.values()) {
    const r = screenRect(c)
    const visible = r.x < vw + VIS_MARGIN && r.x + r.w > -VIS_MARGIN &&
                    r.y < vh + VIS_MARGIN && r.y + r.h > -VIS_MARGIN
    const zoomOk = c.live ? V.s >= LIVE_OFF : V.s >= LIVE_ON
    c.wantLive = !overlay && visible && zoomOk
    if (c.wantLive) want.push(c)
  }
  want.sort((a, b) => b.lastActive - a.lastActive)
  want.slice(MAX_LIVE).forEach(c => { c.wantLive = false })
  if (fullId && !overlay) {
    // The fullscreen page stays live regardless of zoom, position, or budget.
    const fc = cards.get(fullId)
    if (fc) fc.wantLive = true
  }
  if (!overlay) {
    // A card the assistant is ACTING on (present_card) must be live+attached at a
    // real viewport regardless of zoom — its fit-scale can land below the live
    // threshold (a large card or a small window), and a non-live card renders at
    // 0×0 so dispatched clicks silently miss. Force only act-pins live (NOT
    // read-pins, which ensure_live keeps deliberately detached). Bounded to
    // ~120s, or cleared the instant the user hits Escape.
    const now = Date.now()
    for (const c of cards.values()) if (c.aiActUntil > now) c.wantLive = true
  }
  // Zooming out across the live threshold retires every live card in the same
  // frame; a fresh parting thumbnail for each would mean up to 10 capturePage
  // readbacks + encodes landing in one gesture frame. Only the most recently
  // used two get a fresh capture — the rest keep their rolling snapshot.
  const toRetire = []
  for (const c of cards.values()) {
    if (c.retiring) continue
    if (c.wantLive && !c.live) goLive(c)
    else if (!c.wantLive && c.live) toRetire.push(c)
  }
  if (toRetire.length) {
    toRetire.sort((a, b) => b.lastActive - a.lastActive)
    toRetire.forEach((c, i) => retire(c, overlay || i >= 2))
  }
}

async function goLive(c) {
  c.live = true
  if (!c.viewCreated) {
    c.viewCreated = true
    const res = await drift.ensureView(c.id, c.url, { panel: !!c.isPanel })
    if (!res || !res.ok) { c.viewCreated = false; c.live = false; return }
  }
  c.viewReady = true
  if (!c.isPanel) mountCardExtActions(c) // panels are an extension's own UI, not a tab with actions
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
    // Never evict a side panel's view: it hosts a live extension surface (and any
    // chrome.debugger/CDP session driving its page dies with the webContents).
    // Nor a card the assistant just pinned to read/act on — its webContents (and
    // any CDP session driving it) must outlive the tool call.
    .filter(c => !c.live && !c.retiring && !c.isPanel && !(c.aiPinnedUntil > Date.now()))
    .sort((a, b) => a.lastActive - b.lastActive)
    .slice(0, alive.length - KEEP_ALIVE)
    .forEach(c => {
      c.viewCreated = false
      c.viewReady = false
      c.mediaPlaying = false // no 'media-paused' arrives once the view is gone
      unmountCardExtActions(c) // its tab id dies with the view
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
      // A rolling refresh only touches this thumbnail — a full multi-MB state
      // save every few seconds for that reads as browsing jank. Persist those
      // lazily (snapDirty); forced captures ride along with real state changes.
      if (force) markDirty()
      else snapDirty = true
    }
  } finally { c.snapPending = false }
}

// ---------- events from live pages ----------

drift.onViewEvent(d => {
  const c = cards.get(d.id)
  if (!c) return
  switch (d.type) {
    case 'title': c.title = d.title; renderHead(c); markDirty(); if (c.id === fullId) updateFullPill(); break
    case 'favicon': c.fav = d.favicon; renderHead(c); markDirty(); break
    case 'url':
      c.url = d.url
      c.canGoBack = d.canGoBack
      c.canGoForward = d.canGoForward
      c.error = null
      // Main-frame navigation stops playback and 'media-paused' isn't
      // guaranteed — reset here, NOT on 'loading' (subframe/ad loads fire
      // that mid-playback and would wrongly clear the flag).
      c.mediaPlaying = false
      renderHead(c)
      markDirty()
      if (c.id === fullId) updateFullPill()
      break
    case 'loading':
      c.loading = d.loading
      renderHead(c)
      if (!d.loading) { c.everLoaded = true; takeSnapshot(c) }
      break
    case 'media': c.mediaPlaying = d.playing; break
    case 'fail': c.error = d.desc; renderHead(c); break
    case 'spawn': spawnChild(c, d.url); break
    case 'focus': setActive(c.id); break
    case 'ctx': {
      // Right-click inside the live page: translate view-local coordinates to
      // screen and open the card menu there.
      let px, py
      if (fullId === c.id) { px = d.x; py = TOOLBAR + d.y }
      else { const r = screenBodyRect(c); px = r.x + d.x; py = r.y + d.y }
      openCtx(c, px, py, d.linkURL)
      break
    }
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

// An extension (or the Web Store) opened a new tab whose native view already
// exists in main — create a card bound to it without asking for a new view.
function adoptCard(id, url) {
  if (cards.has(id)) return cards.get(id)
  const w = 860, h = 600
  const p = toWorld(innerWidth / 2, TOOLBAR + (innerHeight - TOOLBAR) / 2)
  let [x, y] = findFreeSpot(p.x - w / 2, p.y - h / 2, w, h)
  const c = createCard({ id, url: url || 'about:blank', x, y, w, h })
  c.viewCreated = true
  c.viewReady = true
  mountCardExtActions(c)
  setActive(c.id)
  flashCard(c)
  ensureVisible(c)
  scheduleLayout()
  return c
}

// Open an extension's side panel as a card docked beside the page it belongs to,
// linked by a trail. Side-panel extensions call chrome.sidePanel.open from their
// action's onClicked handler; main forwards it here.
const panelCards = new Map() // key `${extId}|${pageId}` -> panel card id

function openSidePanelCard({ extId, driftId, url }) {
  const page = driftId ? cards.get(driftId) : cards.get(activeId)
  const key = extId + '|' + (page ? page.id : 'global')
  const existingId = panelCards.get(key)
  if (existingId && cards.has(existingId)) {
    const ex = cards.get(existingId)
    if (ex.url !== url) navigateCard(ex, url) // tab changed: point the panel at the new page
    setActive(ex.id); drift.raise(ex.id); flashCard(ex); ensureVisible(ex)
    return ex
  }
  const w = 420
  const h = page ? page.h : 600
  let x, y
  if (page) { x = page.x + page.w + 40; y = page.y } else {
    const p = toWorld(innerWidth / 2, TOOLBAR + (innerHeight - TOOLBAR) / 2)
    x = p.x - w / 2; y = p.y - h / 2
  }
  ;[x, y] = findFreeSpot(x, y, w, h)
  const c = createCard({ url, x, y, w, h })
  c.isPanel = true
  c.panelExtId = extId
  c.el.classList.add('panel')
  if (page) addEdge(page.id, c.id)
  panelCards.set(key, c.id)
  setActive(c.id)
  flashCard(c)
  ensureVisible(c)
  scheduleLayout()
  return c
}

function ensureVisible(c) {
  const r = screenRect(c)
  const m = 40
  let dx = 0, dy = 0
  if (r.x + r.w > viewW() - m) dx = viewW() - m - (r.x + r.w)
  if (r.x < m) dx = m - r.x
  if (r.y + r.h > innerHeight - m) dy = innerHeight - m - (r.y + r.h)
  if (r.y < TOOLBAR + m) dy = TOOLBAR + m - r.y
  if (r.w > viewW() - 2 * m || r.h > innerHeight - TOOLBAR - 2 * m) {
    // Card bigger than the window: just center it.
    animateView({
      s: V.s,
      ox: viewW() / 2 - (c.x + c.w / 2) * V.s,
      oy: TOOLBAR + (innerHeight - TOOLBAR) / 2 - (c.y + c.h / 2) * V.s
    })
  } else if (dx || dy) {
    animateView({ s: V.s, ox: V.ox + dx, oy: V.oy + dy })
  }
}

// ---------- view / card animation ----------

function animateView(target, ms = 280, onDone) {
  const from = { ...V }
  // Resizing + re-zooming live pages every frame makes their content reflow
  // mid-flight and looks awful. For zoom-changing animations, freeze pages to
  // their snapshots (pure GPU scaling) and pop the live view in at the end.
  // Pure pans keep pages live — moving without rescaling doesn't reflow.
  viewFreeze = Math.abs(target.s - from.s) / from.s > 0.12
  const tok = ++animToken
  if (viewFreeze && !fullId) {
    // The landing zoom is known now: have every (detached) page relayout to it
    // DURING the flight, behind its snapshot, so nothing pops at touchdown.
    // 50ms in, the first frame has already detached the views. (In fullscreen
    // the visible card lands at zoom 1, not target.s — skip entirely.)
    setTimeout(() => { if (tok === animToken) drift.prezoom('*', target.s) }, 50)
  }
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
    else {
      viewFreeze = false
      flushZoom() // land on the exact zoom (and match any prezoomed page)
      markDirty()
      scheduleLayout()
      if (onDone) onDone() // only on a real landing — cancelled glides skip it
    }
  }
  requestAnimationFrame(step)
}

function animateCard(c, tx, ty, ms = 300) {
  const fx = c.x, fy = c.y
  const tok = ++c.moveToken
  const t0 = performance.now()
  const ease = x => 1 - Math.pow(1 - x, 3)
  function step(now) {
    if (c.moveToken !== tok || !cards.has(c.id)) return
    const k = ease(Math.min(1, (now - t0) / ms))
    c.x = fx + (tx - fx) * k
    c.y = fy + (ty - fy) * k
    c.el.style.left = c.x + 'px'
    c.el.style.top = c.y + 'px'
    scheduleLayout()
    if (k < 1) requestAnimationFrame(step)
    else { autoGrowZones(); markDirty() }
  }
  requestAnimationFrame(step)
}

function worldBBox() { // cards only
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (const c of cards.values()) {
    x1 = Math.min(x1, c.x); y1 = Math.min(y1, c.y)
    x2 = Math.max(x2, c.x + c.w); y2 = Math.max(y2, c.y + c.h)
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

function contentBBox() { // cards + zones
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (const r of [...cards.values(), ...zones.values()]) {
    x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y)
    x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h)
  }
  if (x1 === Infinity) return null
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

function fitAll() {
  const b = contentBBox()
  if (!b) return
  // Belt: a single non-finite coordinate would turn s/ox/oy into NaN and blank
  // the whole canvas. createCard coerces geometry, so this should never fire —
  // but if it does, don't propagate NaN into V.
  if (![b.x, b.y, b.w, b.h].every(Number.isFinite)) return
  const pad = 90
  const s = clamp(Math.min(viewW() / (b.w + pad * 2), (innerHeight - TOOLBAR) / (b.h + pad * 2)), MIN_S, 1)
  animHardUntil = performance.now() + 340
  animateView({
    s,
    ox: viewW() / 2 - (b.x + b.w / 2) * s,
    oy: TOOLBAR + (innerHeight - TOOLBAR) / 2 - (b.y + b.h / 2) * s
  })
}

function focusCard(c) {
  if (!focusState) focusState = { prev: { ...V } }
  setActive(c.id)
  c.lastActive = Date.now()
  const s = clamp(Math.min((viewW() - 90) / c.w, (innerHeight - TOOLBAR - 60) / c.h), 0.2, 2.2)
  // The glide can be deferred ~90ms while a fresh thumbnail is captured. If
  // Escape fires in that window (present_card's zoom-in is exactly when a user
  // hits the brake), exitFocus already started gliding the camera back — this
  // late glide must NOT run and drag them back into the escaped card.
  const brakeEpoch = aiBrakeEpoch
  const go = () => {
    if (aiBrakeEpoch !== brakeEpoch) return
    animHardUntil = performance.now() + 340
    animateView({
      s,
      ox: viewW() / 2 - (c.x + c.w / 2) * s,
      oy: TOOLBAR + (innerHeight - TOOLBAR) / 2 - (c.y + c.h / 2) * s
    })
  }
  // A fresh thumbnail makes the frozen frame match the live page, but the
  // capture round trip can take 100ms+ — never let it hold the click hostage.
  // The animation starts within 90ms either way; a late frame swaps in
  // mid-flight. Cards playing video skip the capture entirely (it steals a
  // frame from the decoder and the picture changes immediately anyway).
  if (c.live && c.viewCreated && !c.mediaPlaying) Promise.race([takeSnapshot(c, true), sleep(90)]).then(go)
  else go()
}

// Split focus: glide card b beside card a, fit both on screen. b returns to
// where it lived when focus ends (unless the user drags it somewhere new).
function focusPair(a, b) {
  if (!b || !cards.has(b.id)) return
  if (!a || a === b || !cards.has(a.id)) { focusCard(b); return }
  if (!focusState) focusState = { prev: { ...V } }
  // If the anchor itself was the previously split-moved card, adopt it where
  // it sits — sending it home mid-computation would misplace the new pair.
  if (splitInfo && splitInfo.movedId === a.id) splitInfo = null
  if (!splitInfo || splitInfo.movedId !== b.id) {
    restoreSplit()
    splitInfo = { movedId: b.id, home: { x: b.x, y: b.y } }
  }
  const gap = 46
  const tx = a.x + a.w + gap
  const ty = a.y
  animateCard(b, tx, ty, 300)
  setActive(b.id)
  const x1 = a.x, y1 = Math.min(a.y, ty)
  const x2 = tx + b.w, y2 = Math.max(a.y + a.h, ty + b.h)
  const pad = 70
  const s = clamp(Math.min((viewW() - pad * 2) / (x2 - x1), (innerHeight - TOOLBAR - pad * 2) / (y2 - y1)), 0.2, 2.2)
  animHardUntil = performance.now() + 340
  animateView({
    s,
    ox: viewW() / 2 - ((x1 + x2) / 2) * s,
    oy: TOOLBAR + (innerHeight - TOOLBAR) / 2 - ((y1 + y2) / 2) * s
  })
  toast('Split focus — esc to leave')
}

function restoreSplit() {
  if (!splitInfo) return
  const b = cards.get(splitInfo.movedId)
  const home = splitInfo.home
  splitInfo = null
  if (b) animateCard(b, home.x, home.y, 300)
}

function exitFocus() {
  if (!focusState) return
  restoreSplit()
  const target = focusState.prev
  // focusState survives until the glide actually lands: if something still
  // cancels it mid-flight, the next Escape retries instead of going dead.
  const go = () => {
    animHardUntil = performance.now() + 340
    animateView(target, 280, () => { focusState = null })
  }
  const c = activeId && cards.get(activeId)
  // Fresh thumbnail of the page you were just reading, then glide out — with
  // the same 90ms deadline as focusCard so leaving never feels sticky.
  if (c && c.live && c.viewCreated && !c.mediaPlaying) Promise.race([takeSnapshot(c, true), sleep(90)]).then(go)
  else go()
}

// True fullscreen: the page's live Chromium view covers the whole window
// (below the toolbar) at 100% zoom. The canvas is untouched underneath, so
// exiting drops you back exactly where you were.
function updateFullPill() {
  const c = fullId && cards.get(fullId)
  if (!c) return
  $('#btnFullUrl').textContent = '⌕ ' + (c.title || hostOf(c.url))
}

function enterFullscreen(c) {
  if (!c || !cards.has(c.id)) return
  fullId = c.id
  setActive(c.id)
  c.lastActive = Date.now()
  $('#fullExitG').classList.remove('hidden')
  updateFullPill()
  drift.raise(c.id)
  scheduleLayout()
}

function exitFullscreen() {
  if (!fullId) return
  fullId = null
  $('#fullExitG').classList.add('hidden')
  scheduleLayout()
}

function zoomAt(px, py, factor) {
  animToken++
  viewFreeze = false // user took over from any animation
  const ns = clamp(V.s * factor, MIN_S, MAX_S)
  V.ox = px - (px - V.ox) * (ns / V.s)
  V.oy = py - (py - V.oy) * (ns / V.s)
  V.s = ns
  markDirty()
  scheduleLayout()
}

// ---------- tidy: auto-arrange trails as trees ----------

function tidy() {
  if (!cards.size) return
  const seenG = new Set()
  const comps = []
  for (const id of cards.keys()) {
    if (seenG.has(id)) continue
    if (cards.get(id).isPanel) continue // side panels are laid out beside their page, not as tree nodes
    const comp = [...trailOf(id)].filter(x => cards.has(x) && !cards.get(x).isPanel)
    for (const x of comp) seenG.add(x)
    comps.push(comp)
  }
  comps.sort((a, b) => b.length - a.length)

  const anchor = worldBBox()
  const GX = 130, GY = 56, COMP_GAP = 170
  let cy = anchor.y
  for (const comp of comps) {
    const compSet = new Set(comp)
    const kids = new Map()
    const hasParent = new Set()
    for (const e of edges) {
      if (!compSet.has(e.from) || !compSet.has(e.to)) continue
      if (!kids.has(e.from)) kids.set(e.from, [])
      kids.get(e.from).push(e.to)
      hasParent.add(e.to)
    }
    const byAge = (p, q) => cards.get(p).createdAt - cards.get(q).createdAt
    const roots = comp.filter(x => !hasParent.has(x)).sort(byAge)
    const depth = new Map()
    const order = []
    const queue = roots.map(r => [r, 0])
    while (queue.length) {
      const [id, d] = queue.shift()
      if (depth.has(id)) continue
      depth.set(id, d)
      order.push(id)
      for (const k of (kids.get(id) || []).sort(byAge)) queue.push([k, d + 1])
    }
    for (const id of comp) if (!depth.has(id)) { depth.set(id, 0); order.push(id) } // pure cycles

    const colW = new Map(), colY = new Map()
    for (const id of order) {
      const d = depth.get(id)
      colW.set(d, Math.max(colW.get(d) || 0, cards.get(id).w))
    }
    const colX = new Map()
    let x = anchor.x
    for (let d = 0; colW.has(d); d++) { colX.set(d, x); x += colW.get(d) + GX }
    for (const id of order) {
      const c = cards.get(id)
      const d = depth.get(id)
      animateCard(c, colX.get(d), cy + (colY.get(d) || 0), 380)
      colY.set(d, (colY.get(d) || 0) + c.h + GY)
    }
    cy += Math.max(0, ...colY.values()) - GY + COMP_GAP
  }
  // Re-dock each open side panel beside the page it belongs to.
  for (const [key, panelId] of panelCards) {
    const panel = cards.get(panelId)
    if (!panel || !panel.isPanel) continue
    const pageId = key.slice(key.indexOf('|') + 1)
    const page = cards.get(pageId)
    if (page) animateCard(panel, page.x + page.w + 40, page.y, 380)
  }
  markDirty()
  setTimeout(fitAll, 400)
  toast(`Tidied ${cards.size} card${cards.size === 1 ? '' : 's'} into ${comps.length} trail${comps.length === 1 ? '' : 's'}`)
}

// ---------- input ----------

function wireGlobalInput() {
  window.addEventListener('wheel', e => {
    if (paletteOpen || tourOpen) return // overlays own the wheel
    if (e.target.closest('.no-pan')) return
    e.preventDefault()
    // Focus/Escape glides are deliberate commands: trackpad momentum keeps
    // emitting wheel events for up to a second after a pan, and one stray
    // tick here would cancel the glide a frame after it starts (Escape then
    // looked dead). Swallow wheel input while such a glide is in flight.
    if (performance.now() < animHardUntil) return
    closeCtx()
    animToken++
    viewFreeze = false
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
    if (tourOpen || e.button !== 0) return
    if (e.target.closest('.card') || e.target.closest('#toolbar') ||
        e.target.closest('#minimap') || e.target.closest('#palette') ||
        e.target.closest('.zone') || e.target.closest('#ctx') ||
        e.target.closest('#bmpanel')) return
    animToken++
    viewFreeze = false
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
    if (tourOpen) return
    if (e.target.closest('.card') || e.target.closest('#toolbar') ||
        e.target.closest('#minimap') || e.target.closest('#palette') ||
        e.target.closest('.zone') || e.target.closest('#ctx') ||
        e.target.closest('#bmpanel') || e.target.closest('#edges')) return
    openPalette({ at: toWorld(e.clientX, e.clientY) })
  })

  window.addEventListener('mousedown', e => {
    if (ctxOpenFor && !e.target.closest('#ctx')) closeCtx()
    if (bmOpen && !e.target.closest('#bmpanel') && !e.target.closest('#btnBookmarks')) closeBmPanel()
    if (vaultOpen && !e.target.closest('#vaultpanel') && !e.target.closest('#btnVault')) closeVaultPanel()
    if (settingsOpen && !e.target.closest('#setpanel') && !e.target.closest('#btnSettings')) closeSettingsPanel()
  }, true)

  // Right-click on empty canvas: quick actions for the spot under the cursor.
  viewport.addEventListener('contextmenu', e => {
    if (tourOpen) return
    if (e.target.closest('.card') || e.target.closest('#toolbar') ||
        e.target.closest('#minimap') || e.target.closest('#palette') ||
        e.target.closest('.zone') || e.target.closest('#ctx') ||
        e.target.closest('#bmpanel') || e.target.closest('#edges')) return
    e.preventDefault()
    openCanvasCtx(e.clientX, e.clientY)
  })

  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return
    if (tourOpen) {
      if (tourPhase === 'intro') {
        if (e.key === 'Escape') endTour()
        else if (e.key === 'Enter' || e.key === 'ArrowRight') beginTourSteps()
        return
      }
      if (e.key === 'Escape') endTour()
      else if (e.key === 'Enter' || e.key === 'ArrowRight') nextTour()
      else if (e.key === 'ArrowLeft') prevTour()
      return
    }
    const pan = 80
    if (e.key === 'Escape') onEscape()
    else if (e.key === 'ArrowLeft') { V.ox += pan; scheduleLayout() }
    else if (e.key === 'ArrowRight') { V.ox -= pan; scheduleLayout() }
    else if (e.key === 'ArrowUp') { V.oy += pan; scheduleLayout() }
    else if (e.key === 'ArrowDown') { V.oy -= pan; scheduleLayout() }
  })

  window.addEventListener('resize', scheduleLayout)

  $('#btnNew').addEventListener('click', () => openPalette({}))
  $('#btnZone').addEventListener('click', newZone)
  $('#btnTidy').addEventListener('click', tidy)
  $('#btnFit').addEventListener('click', fitAll)
  $('#btnBookmarks').addEventListener('click', () => { bmOpen ? closeBmPanel() : openBmPanel() })
  $('#btnBmFolder').addEventListener('click', addFolder)
  $('#btnBmImport').addEventListener('click', importBookmarks)
  $('#btnBmExport').addEventListener('click', exportBookmarks)
  $('#btnBmClear').addEventListener('click', clearAllBookmarks)
  $('#btnSettings').addEventListener('click', () => { settingsOpen ? closeSettingsPanel() : openSettingsPanel() })
  $('#btnAI').addEventListener('click', () => drift.aiToggle())
  $('#btnExt').addEventListener('click', () => drift.extOpenStore())
  if (VAULT_ENABLED) {
    $('#btnVault').classList.remove('hidden')
    $('#btnVault').addEventListener('click', () => { vaultOpen ? closeVaultPanel() : openVaultPanel() })
  }
  $('#btnFullExit').addEventListener('click', exitFullscreen)
  $('#btnUpdate').addEventListener('click', () => drift.openDownloadPage())
  $('#btnUpdateDismiss').addEventListener('click', () => $('#updateG').classList.add('hidden'))
  $('#btnFullUrl').addEventListener('click', () => {
    const c = fullId && cards.get(fullId)
    if (c) openPalette({ navigateId: c.id, prefill: c.url })
  })
  $('#btnZoomIn').addEventListener('click', () => zoomAt(viewW() / 2, TOOLBAR + (innerHeight - TOOLBAR) / 2, 1.25))
  $('#btnZoomOut').addEventListener('click', () => zoomAt(viewW() / 2, TOOLBAR + (innerHeight - TOOLBAR) / 2, 0.8))
  $('#btnHelp').addEventListener('click', startTour)
  $('#tourNext').addEventListener('click', nextTour)
  $('#tourBack').addEventListener('click', prevTour)
  $('#tourSkip').addEventListener('click', endTour)
  $('#introGo').addEventListener('click', beginTourSteps)
  $('#introSkip').addEventListener('click', endTour)
  $('#introMute').addEventListener('click', () => {
    try { localStorage.setItem('drift-intro-sound', introSoundOn() ? 'off' : 'on') } catch {}
    if (introSoundOn()) startIntroSound()
    else stopIntroSound(0.15)
    refreshIntroMute()
  })
  // The intro's constellation stage is a fixed 1100×640 design that scales
  // down to fit small windows; keep it fitted through live resizes.
  window.addEventListener('resize', () => {
    if (tourOpen && tourPhase === 'intro') introFitStage()
  })

  minimap.addEventListener('mousedown', e => {
    const t = minimapTransform()
    if (!t) return
    const r = minimap.getBoundingClientRect()
    const wx = (e.clientX - r.left - t.ox) / t.k
    const wy = (e.clientY - r.top - t.oy) / t.k
    animateView({
      s: V.s,
      ox: viewW() / 2 - wx * V.s,
      oy: TOOLBAR + (innerHeight - TOOLBAR) / 2 - wy * V.s
    })
  })

  // A new query invalidates any arrow/hover selection — Enter should go back
  // to meaning "open what I typed" until the user re-picks a result.
  palInput.addEventListener('input', () => { palSel = -1; renderPalResults() })
  palInput.addEventListener('keydown', e => {
    e.stopPropagation()
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!palRows.length) return
      palSel = e.key === 'ArrowDown'
        ? Math.min(palSel + 1, palRows.length - 1)
        : Math.max(palSel - 1, -1)
      renderPalSelection()
    } else if (e.key === 'Enter') {
      if (palSel >= 0 && palRows[palSel]) {
        pickPalRow(palRows[palSel])
        return
      }
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

function onEscape() {
  // Emergency brake: Escape always stops a running assistant turn. Without
  // this, an assistant that keeps acting (and full-screening the card it acts
  // on) drags the view back the instant you exit — Escape can't win a race
  // against a live agent loop. Stopping the turn first breaks that.
  try { drift.aiStop() } catch {}
  // Fully let go: drop every assistant pin so no card stays force-live, and bump
  // the brake epoch so a present_card caught mid-flight bails instead of
  // re-focusing the card the user just escaped out of.
  aiBrakeEpoch++
  for (const c of cards.values()) { c.aiPinnedUntil = 0; c.aiActUntil = 0 }
  if (tourOpen) endTour()
  else if (paletteOpen) closePalette()
  else if (bmOpen) closeBmPanel()
  else if (vaultOpen) closeVaultPanel()
  else if (settingsOpen) closeSettingsPanel()
  else if (fullId) exitFullscreen()
  else if (ctxOpenFor) closeCtx()
  else exitFocus()
}

// Swallow the click that the browser fires right after a real drag, so
// releasing a title-drag doesn't also open the URL editor.
function suppressNextClick() {
  const kill = ev => { ev.stopPropagation(); ev.preventDefault() }
  window.addEventListener('click', kill, true)
  setTimeout(() => window.removeEventListener('click', kill, true), 0)
}

function startCardDrag(c, e) {
  if (e.button !== 0) return // right-click means menu, never drag or focus
  e.preventDefault()
  setActive(c.id)
  c.moveToken++ // cancel any in-flight animation fighting the drag
  if (splitInfo && splitInfo.movedId === c.id) splitInfo = null // user re-homed it
  const wasTitle = !!e.target.closest('.ctitle') // title click = edit URL, not focus
  const sx = e.clientX, sy = e.clientY, x0 = c.x, y0 = c.y
  let moved = 0
  const move = ev => {
    moved = Math.max(moved, Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy))
    c.x = x0 + (ev.clientX - sx) / V.s
    c.y = y0 + (ev.clientY - sy) / V.s
    c.el.style.left = c.x + 'px'
    c.el.style.top = c.y + 'px'
    scheduleLayout()
  }
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    if (moved >= 5) suppressNextClick()
    // A clean click on the header (no drag) zooms into the card, so live
    // pages focus with a single click, like clicking a tab.
    else if (!wasTitle) focusCard(c)
    autoGrowZones()
    markDirty()
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

function startCardResize(c, e) {
  if (e.button !== 0) return
  e.preventDefault()
  e.stopPropagation()
  setActive(c.id)
  const sx = e.clientX, sy = e.clientY, w0 = c.w, h0 = c.h
  const move = ev => {
    c.w = Math.max(340, w0 + (ev.clientX - sx) / V.s)
    c.h = Math.max(240, h0 + (ev.clientY - sy) / V.s)
    c.el.style.width = c.w + 'px'
    c.el.style.height = c.h + 'px'
    autoGrowZones() // zones stretch live as a card outgrows them
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

// ---------- bookmarks ----------

function saveBookmarks() {
  drift.bookmarksSave({ v: 2, folders: bmFolders, items: bookmarks.slice(0, 500) })
}

function refreshBookmarkUI() {
  bmSet = new Set(bookmarks.map(b => b.url))
  for (const c of cards.values()) renderHead(c)
}

function toggleBookmark(c) {
  if (bmSet.has(c.url)) {
    bookmarks = bookmarks.filter(b => b.url !== c.url)
    toast('Bookmark removed')
  } else {
    // Skip data: favicons — the bookmarks file should stay tiny.
    const fav = (c.fav && /^https?:/i.test(c.fav)) ? c.fav : null
    bookmarks.unshift({ url: c.url, title: c.title || hostOf(c.url), fav, t: Date.now(), folder: null })
    if (bookmarks.length > 500) bookmarks.length = 500
    toast('Bookmarked ★ — find it in ⌘T')
  }
  saveBookmarks()
  refreshBookmarkUI()
  if (bmOpen) renderBmPanel()
}

function addFolder() {
  // Electron has no window.prompt(); use an inline input in the panel instead.
  if (!bmOpen) openBmPanel()
  if (bmList.querySelector('.bmnewfolder')) { bmList.querySelector('.bmnewfolder').focus(); return }
  const input = document.createElement('input')
  input.className = 'bmnewfolder'
  input.placeholder = 'Folder name — ↵ to add'
  input.spellcheck = false
  const commit = () => {
    const name = input.value.trim()
    input.remove()
    if (name && !bmFolders.includes(name)) { bmFolders.push(name); saveBookmarks() }
    renderBmPanel()
  }
  input.addEventListener('keydown', e => {
    e.stopPropagation()
    if (e.key === 'Enter') commit()
    else if (e.key === 'Escape') { input.remove() }
  })
  input.addEventListener('blur', commit)
  bmList.insertBefore(input, bmList.firstChild)
  input.focus()
}

function moveBookmark(url, folder) {
  const b = bookmarks.find(x => x.url === url)
  if (!b) return
  b.folder = folder || null
  saveBookmarks()
  renderBmPanel()
}

function removeFolder(name) {
  bmFolders = bmFolders.filter(f => f !== name)
  for (const b of bookmarks) if (b.folder === name) b.folder = null
  saveBookmarks()
  renderBmPanel()
}

// ---------- bookmark import / export (Netscape HTML) ----------

// Folder paths use " / " to keep nesting in Drift's flat folder model, e.g.
// "News / Tech". The top-level container roots browsers wrap everything in
// aren't real user folders, so their names are dropped.
const BM_SEP = ' / '
const BM_CONTAINERS = new Set([
  'bookmarks bar', 'bookmarks toolbar', 'other bookmarks', 'bookmarks menu',
  'mobile bookmarks', 'favorites bar', 'favorites', 'bookmarks'
])

function bookmarksToHTML() {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // Rebuild the folder tree from the " / " path strings so the export nests
  // properly and any other browser can re-import the structure.
  const root = { kids: new Map(), items: [] }
  const ensure = pathStr => {
    let node = root
    if (pathStr) for (const seg of pathStr.split(BM_SEP)) {
      if (!node.kids.has(seg)) node.kids.set(seg, { kids: new Map(), items: [] })
      node = node.kids.get(seg)
    }
    return node
  }
  for (const f of bmFolders) ensure(f) // keep empty folders
  for (const b of bookmarks) ensure(bmFolders.includes(b.folder) ? b.folder : '').items.push(b)

  const link = (b, ind) => `${ind}<DT><A HREF="${esc(b.url)}"` +
    (b.t ? ` ADD_DATE="${Math.floor(b.t / 1000)}"` : '') +
    (b.fav ? ` ICON="${esc(b.fav)}"` : '') +
    `>${esc(b.title || b.url)}</A>\n`
  const ser = (node, ind) => {
    let out = ''
    for (const [name, kid] of node.kids) {
      out += `${ind}<DT><H3>${esc(name)}</H3>\n${ind}<DL><p>\n${ser(kid, ind + '    ')}${ind}</DL><p>\n`
    }
    for (const b of node.items) out += link(b, ind)
    return out
  }
  return '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n' +
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n' +
    '<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n' + ser(root, '    ') + '</DL><p>\n'
}

// Parse a browser bookmark HTML file, keeping nested folder paths and the
// embedded favicon (ICON="data:...") that Chromium browsers write per link.
function parseBookmarksHTML(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const items = []
  const folders = new Set()
  const iconOf = a => {
    const ic = a.getAttribute('icon') || ''
    return (/^data:image\//i.test(ic) && ic.length <= 4096) ? ic : null
  }
  const addLink = (a, path) => {
    const href = a.getAttribute('href')
    if (!href || !/^https?:/i.test(href)) return
    const ad = parseInt(a.getAttribute('add_date') || '', 10)
    items.push({
      title: a.textContent.trim() || href,
      url: href,
      folder: path.length ? path.join(BM_SEP) : null,
      fav: iconOf(a),
      t: Number.isFinite(ad) && ad > 0 ? ad * 1000 : Date.now()
    })
  }
  const topDL = doc.querySelector('dl')
  if (!topDL) {
    for (const a of doc.querySelectorAll('a[href]')) addLink(a, [])
    return { items, folders: [] }
  }
  const walk = (dl, path, depth) => {
    let node = dl.firstElementChild
    while (node) {
      if (node.tagName === 'DT') {
        const h3 = node.querySelector(':scope > h3')
        const a = node.querySelector(':scope > a')
        if (h3) {
          const name = h3.textContent.trim()
          // Drop the browser's root container names; keep real user folders.
          const isContainer = depth === 0 && BM_CONTAINERS.has(name.toLowerCase())
          const childPath = (isContainer || !name) ? path : [...path, name]
          if (childPath.length) folders.add(childPath.join(BM_SEP))
          const sub = node.querySelector(':scope > dl') ||
            (node.nextElementSibling && node.nextElementSibling.tagName === 'DL' ? node.nextElementSibling : null)
          if (sub) walk(sub, childPath, depth + 1)
        } else if (a) {
          addLink(a, path)
        }
      }
      node = node.nextElementSibling
    }
  }
  walk(topDL, [], 0)
  return { items, folders: [...folders] }
}

async function exportBookmarks() {
  if (!bookmarks.length) { toast('No bookmarks to export yet'); return }
  const res = await drift.bookmarksExport(bookmarksToHTML())
  if (res && res.ok) toast(`Exported ${bookmarks.length} bookmark${bookmarks.length === 1 ? '' : 's'}`)
}

async function importBookmarks() {
  const html = await drift.bookmarksImport()
  if (!html) return
  const { items, folders } = parseBookmarksHTML(html)
  for (const f of folders) if (f && !bmFolders.includes(f)) bmFolders.push(f)
  let added = 0
  for (const it of items) {
    if (bmSet.has(it.url)) continue // don't duplicate what you already have
    bookmarks.push({
      url: it.url,
      title: it.title || hostOf(it.url),
      fav: it.fav || null,          // embedded favicon from the export
      t: it.t || Date.now(),
      folder: it.folder || null     // nested path like "News / Tech"
    })
    bmSet.add(it.url)
    added++
  }
  if (bookmarks.length > 500) bookmarks.length = 500
  saveBookmarks()
  refreshBookmarkUI()
  if (bmOpen) renderBmPanel()
  toast(added ? `Imported ${added} bookmark${added === 1 ? '' : 's'} · ${bmFolders.length} folder${bmFolders.length === 1 ? '' : 's'}` : 'Nothing new to import')
}

function clearAllBookmarks() {
  if (!bookmarks.length && !bmFolders.length) { toast('No bookmarks to clear'); return }
  // Inline confirm at the top of the list (Electron has no window.confirm here).
  const existing = bmList.querySelector('.bmconfirm')
  if (existing) { existing.remove(); return }
  const bar = document.createElement('div')
  bar.className = 'bmconfirm'
  const txt = document.createElement('span')
  txt.textContent = `Remove all ${bookmarks.length} bookmark${bookmarks.length === 1 ? '' : 's'}?`
  const yes = document.createElement('button')
  yes.className = 'bmcyes'
  yes.textContent = 'Remove all'
  yes.addEventListener('click', () => {
    bookmarks = []
    bmFolders = []
    saveBookmarks()
    refreshBookmarkUI()
    renderBmPanel()
    toast('All bookmarks removed')
  })
  const no = document.createElement('button')
  no.className = 'bmcno'
  no.textContent = 'Cancel'
  no.addEventListener('click', () => renderBmPanel())
  bar.append(txt, yes, no)
  bmList.insertBefore(bar, bmList.firstChild)
}

// ---------- bookmarks panel (toolbar ★) ----------

const bmPanel = $('#bmpanel')
const bmList = $('#bmlist')

function positionBmPanel() {
  const r = $('#btnBookmarks').getBoundingClientRect()
  const w = bmPanel.offsetWidth
  bmPanel.style.left = clamp(r.left, 8, viewW() - w - 8) + 'px'
  bmPanel.style.top = (r.bottom + 10) + 'px'
}

function bmRow(b) {
  const row = palRowDom('★', b.fav, b.title || b.url, hostOf(b.url), true)

  // Move-to-folder dropdown (only rendered when folders exist).
  if (bmFolders.length) {
    const sel = document.createElement('select')
    sel.className = 'bmmove'
    sel.title = 'Move to folder'
    const opt0 = document.createElement('option')
    opt0.value = ''
    opt0.textContent = 'Unsorted'
    sel.appendChild(opt0)
    for (const f of bmFolders) {
      const o = document.createElement('option')
      o.value = f
      o.textContent = f
      sel.appendChild(o)
    }
    sel.value = b.folder || ''
    sel.addEventListener('click', ev => ev.stopPropagation())
    sel.addEventListener('change', ev => { ev.stopPropagation(); moveBookmark(b.url, sel.value) })
    row.appendChild(sel)
  }

  const del = document.createElement('button')
  del.className = 'bmdel'
  del.title = 'Remove bookmark'
  del.textContent = '×'
  del.addEventListener('click', ev => {
    ev.stopPropagation()
    bookmarks = bookmarks.filter(x => x.url !== b.url)
    saveBookmarks()
    refreshBookmarkUI()
    renderBmPanel()
    toast('Bookmark removed')
  })
  row.appendChild(del)
  row.addEventListener('click', () => {
    closeBmPanel()
    const c = newCard(b.url)
    flashCard(c)
  })
  return row
}

function renderBmPanel() {
  bmList.innerHTML = ''
  if (!bookmarks.length && !bmFolders.length) {
    const d = document.createElement('div')
    d.className = 'bmempty'
    d.textContent = 'No bookmarks yet — hit ☆ on any card.'
    bmList.appendChild(d)
    return
  }

  const groupEl = (name, items, removable) => {
    const collapsed = bmCollapsed.has(name)
    const head = document.createElement('div')
    head.className = 'bmgroup'
    const tw = document.createElement('span')
    tw.className = 'bmtwist'
    tw.textContent = collapsed ? '▸' : '▾'
    const lbl = document.createElement('span')
    lbl.className = 'bmglabel'
    lbl.textContent = `${name}  ·  ${items.length}`
    head.append(tw, lbl)
    if (removable) {
      const rm = document.createElement('button')
      rm.className = 'bmfdel'
      rm.title = 'Delete folder (bookmarks move to Unsorted)'
      rm.textContent = '×'
      rm.addEventListener('click', ev => { ev.stopPropagation(); removeFolder(name) })
      head.appendChild(rm)
    }
    head.addEventListener('click', () => {
      collapsed ? bmCollapsed.delete(name) : bmCollapsed.add(name)
      renderBmPanel()
    })
    bmList.appendChild(head)
    if (!collapsed) for (const b of items) bmList.appendChild(bmRow(b))
  }

  // Named folders first (in order), then anything unsorted.
  for (const f of bmFolders) groupEl(f, bookmarks.filter(b => b.folder === f), true)
  const unsorted = bookmarks.filter(b => !b.folder || !bmFolders.includes(b.folder))
  if (bmFolders.length) {
    if (unsorted.length) groupEl('Unsorted', unsorted, false)
  } else {
    for (const b of unsorted) bmList.appendChild(bmRow(b))
  }
}

function openBmPanel() {
  closeCtx()
  if (paletteOpen) closePalette()
  renderBmPanel()
  bmPanel.classList.remove('hidden')
  bmOpen = true
  positionBmPanel()
  scheduleLayout() // detach live views so the panel sits on top
}

function closeBmPanel() {
  if (!bmOpen) return
  bmPanel.classList.add('hidden')
  bmOpen = false
  scheduleLayout()
}

// ---------- password vault ----------
// A local, encrypted credential store. The master password is never saved;
// it derives (PBKDF2) an AES-GCM key that encrypts the vault at rest. The key
// lives only in memory for the session and is cleared on lock. Each entry is
// bound to a site origin, so autofill is only offered on the matching site.

// The vault is fully built and tested but stays hidden until it's hardened for
// real-world use. Flip this to true (the toolbar button unhides) to re-enable.
const VAULT_ENABLED = false
const VAULT_ITER = 310000
let vaultBlob = null        // { v, salt, iter, iv, ct } persisted, or null if not set up
let vaultKey = null         // CryptoKey while unlocked, else null
let vaultEntries = []       // decrypted entries while unlocked: {id,label,origin,url,username,password,t}
let vaultOpen = false

const te = new TextEncoder(), td = new TextDecoder()
const toB64 = u => btoa(String.fromCharCode(...new Uint8Array(u)))
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0))

function originOf(url) {
  try { return new URL(url).origin } catch { return '' }
}

async function vaultDeriveKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: VAULT_ITER, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

async function vaultEncrypt() {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = te.encode(JSON.stringify({ entries: vaultEntries }))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, vaultKey, data)
  vaultBlob = { ...vaultBlob, iv: toB64(iv), ct: toB64(ct) }
  drift.vaultSave(vaultBlob)
}

async function vaultLoadState() {
  vaultBlob = await drift.vaultLoad()
}

async function vaultSetup(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  vaultKey = await vaultDeriveKey(password, salt)
  vaultBlob = { v: 1, salt: toB64(salt), iter: VAULT_ITER }
  vaultEntries = []
  await vaultEncrypt()
}

async function vaultUnlock(password) {
  if (!vaultBlob) return false
  try {
    const key = await vaultDeriveKey(password, fromB64(vaultBlob.salt))
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(vaultBlob.iv) }, key, fromB64(vaultBlob.ct))
    const obj = JSON.parse(td.decode(pt))
    vaultKey = key
    vaultEntries = Array.isArray(obj.entries) ? obj.entries : []
    return true
  } catch { return false } // wrong password (or corrupt blob)
}

function vaultLock() {
  vaultKey = null
  vaultEntries = []
}

async function vaultAddEntry(e) {
  vaultEntries.unshift({
    id: uid('v'),
    label: e.label || hostOf(e.url) || e.origin,
    origin: e.origin || originOf(e.url),
    url: e.url || '',
    username: e.username || '',
    password: e.password || '',
    t: Date.now()
  })
  await vaultEncrypt()
}

async function vaultDeleteEntry(id) {
  vaultEntries = vaultEntries.filter(x => x.id !== id)
  await vaultEncrypt()
}

// ---------- vault panel (toolbar 🔒) ----------

const vaultPanel = () => $('#vaultpanel')

function positionVaultPanel() {
  const p = vaultPanel()
  const r = $('#btnVault').getBoundingClientRect()
  const w = p.offsetWidth
  p.style.left = clamp(r.right - w, 8, viewW() - w - 8) + 'px'
  p.style.top = (r.bottom + 10) + 'px'
}

function vEl(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

function renderVaultPanel() {
  const p = vaultPanel()
  p.innerHTML = ''
  p.appendChild(vEl('div', 'vhead', 'Vault'))
  const body = vEl('div', 'vbody')
  p.appendChild(body)

  if (!vaultBlob) {
    // First run: create a master password.
    body.appendChild(vEl('div', 'vnote', 'Create a master password. It encrypts every saved login and is never stored — if you forget it, the vault can’t be recovered.'))
    const pw = vEl('input', 'vinput'); pw.type = 'password'; pw.placeholder = 'Master password'
    const pw2 = vEl('input', 'vinput'); pw2.type = 'password'; pw2.placeholder = 'Confirm password'
    const err = vEl('div', 'verr')
    const btn = vEl('button', 'vbtn primary', 'Create vault')
    const submit = async () => {
      err.textContent = ''
      if (pw.value.length < 6) { err.textContent = 'Use at least 6 characters.'; return }
      if (pw.value !== pw2.value) { err.textContent = 'Passwords don’t match.'; return }
      await vaultSetup(pw.value)
      renderVaultPanel()
      toast('Vault created')
    }
    btn.addEventListener('click', submit)
    pw2.addEventListener('keydown', e => { if (e.key === 'Enter') submit() })
    body.append(pw, pw2, err, btn)
    setTimeout(() => pw.focus(), 60)
    return
  }

  if (!vaultKey) {
    // Locked: ask for the master password.
    body.appendChild(vEl('div', 'vnote', 'Vault is locked.'))
    const pw = vEl('input', 'vinput'); pw.type = 'password'; pw.placeholder = 'Master password'
    const err = vEl('div', 'verr')
    const btn = vEl('button', 'vbtn primary', 'Unlock')
    const submit = async () => {
      err.textContent = ''
      btn.disabled = true
      const ok = await vaultUnlock(pw.value)
      btn.disabled = false
      if (ok) { renderVaultPanel() } else { err.textContent = 'Wrong password.'; pw.select() }
    }
    btn.addEventListener('click', submit)
    pw.addEventListener('keydown', e => { if (e.key === 'Enter') submit() })
    body.append(pw, err, btn)
    setTimeout(() => pw.focus(), 60)
    return
  }

  // Unlocked.
  const bar = vEl('div', 'vbar')
  const add = vEl('button', 'vbtn', '+ Add login')
  add.addEventListener('click', () => showVaultAddForm(body))
  const lock = vEl('button', 'vbtn', 'Lock')
  lock.addEventListener('click', () => { vaultLock(); renderVaultPanel() })
  bar.append(add, lock)
  body.appendChild(bar)

  const activeOrigin = activeId && cards.get(activeId) ? originOf(cards.get(activeId).url) : ''
  const list = vEl('div', 'vlist')
  body.appendChild(list)
  if (!vaultEntries.length) {
    list.appendChild(vEl('div', 'vempty', 'No logins saved yet.'))
  }
  for (const e of vaultEntries) {
    const row = vEl('div', 'vrow')
    const main = vEl('div', 'vmain')
    main.appendChild(vEl('div', 'vlabel', e.label))
    const sub = vEl('div', 'vsub')
    sub.textContent = e.username || '—'
    main.appendChild(sub)
    row.appendChild(main)

    const acts = vEl('div', 'vacts')
    const reveal = vEl('button', 'vmini', '👁')
    reveal.title = 'Show password'
    reveal.addEventListener('click', () => {
      const shown = sub.dataset.shown === '1'
      sub.dataset.shown = shown ? '0' : '1'
      sub.textContent = shown ? (e.username || '—') : e.password
    })
    const copy = vEl('button', 'vmini', '⧉')
    copy.title = 'Copy password'
    copy.addEventListener('click', () => { copyText(e.password); toast('Password copied') })
    acts.append(reveal, copy)

    if (activeOrigin && e.origin === activeOrigin) {
      const fill = vEl('button', 'vmini fill', '↥')
      fill.title = 'Fill on this page'
      fill.addEventListener('click', async () => {
        const res = await drift.vaultFill(activeId, e.username, e.password)
        toast(res && res.ok ? 'Filled login' : 'Couldn’t find a login form here')
      })
      acts.appendChild(fill)
    }

    const del = vEl('button', 'vmini danger', '×')
    del.title = 'Delete login'
    del.addEventListener('click', async () => { await vaultDeleteEntry(e.id); renderVaultPanel() })
    acts.appendChild(del)
    row.appendChild(acts)
    list.appendChild(row)
  }
  positionVaultPanel()
}

function showVaultAddForm(body) {
  const c = activeId && cards.get(activeId)
  const form = vEl('div', 'vform')
  const site = vEl('input', 'vinput'); site.placeholder = 'Site (e.g. github.com)'
  site.value = c ? hostOf(c.url) : ''
  const user = vEl('input', 'vinput'); user.placeholder = 'Username or email'
  const pass = vEl('input', 'vinput'); pass.type = 'password'; pass.placeholder = 'Password'
  const row = vEl('div', 'vformbtns')
  const save = vEl('button', 'vbtn primary', 'Save')
  const cancel = vEl('button', 'vbtn', 'Cancel')
  save.addEventListener('click', async () => {
    if (!pass.value) { pass.focus(); return }
    // Prefer the active card's exact origin when the site field matches it.
    let url = ''
    if (c && hostOf(c.url) === site.value.trim()) url = c.url
    else if (site.value.trim()) url = 'https://' + site.value.trim().replace(/^https?:\/\//, '')
    await vaultAddEntry({ label: site.value.trim() || hostOf(url), url, origin: originOf(url), username: user.value, password: pass.value })
    renderVaultPanel()
    toast('Login saved')
  })
  cancel.addEventListener('click', renderVaultPanel)
  row.append(save, cancel)
  form.append(site, user, pass, row)
  body.insertBefore(form, body.querySelector('.vlist'))
  setTimeout(() => user.focus(), 40)
}

function openVaultPanel() {
  closeCtx()
  if (paletteOpen) closePalette()
  if (bmOpen) closeBmPanel()
  vaultOpen = true
  vaultPanel().classList.remove('hidden')
  renderVaultPanel()
  positionVaultPanel()
  scheduleLayout()
}

function closeVaultPanel() {
  if (!vaultOpen) return
  vaultOpen = false
  vaultPanel().classList.add('hidden')
  scheduleLayout()
}

// ---------- settings panel (toolbar ⚙) ----------

const SOLID_COLORS = [
  { name: 'White', v: '#ffffff' },
  { name: 'Off-white', v: '#f4f1ec' },
  { name: 'Light grey', v: '#e7e5ea' },
  { name: 'Slate', v: '#2b303c' },
  { name: 'Black', v: '#0d0b10' },
  { name: 'Navy', v: '#111d33' },
  { name: 'Forest', v: '#122019' },
  { name: 'Plum', v: '#1d1526' }
]

function settingsPanelEl() { return $('#setpanel') }

function positionSettingsPanel() {
  const p = settingsPanelEl()
  const r = $('#btnSettings').getBoundingClientRect()
  const w = p.offsetWidth
  // The AI dock is a native view that paints over DOM — keep the panel out of
  // its strip or most of it would be invisible and unclickable.
  p.style.left = clamp(r.right - w, 8, viewW() - w - 8) + 'px'
  p.style.top = (r.bottom + 10) + 'px'
}

async function saveSettings() {
  await drift.settingsSave(settings)
}

async function setBackground(bg) {
  settings.bg = bg
  applyBackground()
  await saveSettings()
  renderSettingsPanel()
}

function pickBackgroundImage() {
  const inp = document.createElement('input')
  inp.type = 'file'
  inp.accept = 'image/*'
  inp.addEventListener('change', () => {
    const file = inp.files && inp.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setBackground({ mode: 'image', image: String(reader.result) })
    reader.readAsDataURL(file)
  })
  inp.click()
}

async function renderSettingsPanel() {
  const p = settingsPanelEl()
  p.innerHTML = ''
  p.appendChild(vEl('div', 'vhead', 'Settings'))
  const body = vEl('div', 'setbody')
  p.appendChild(body)

  // ---- Background ----
  body.appendChild(vEl('div', 'setsec', 'Background'))
  const mode = (settings.bg && settings.bg.mode) || 'photos'
  const row = vEl('div', 'setrow')
  const photosBtn = vEl('button', 'setbtn' + (mode === 'photos' ? ' on' : ''), 'Drift photos')
  photosBtn.addEventListener('click', () => setBackground({ mode: 'photos' }))
  const uploadBtn = vEl('button', 'setbtn' + (mode === 'image' ? ' on' : ''), mode === 'image' ? 'Change image' : 'Upload image')
  uploadBtn.addEventListener('click', pickBackgroundImage)
  row.append(photosBtn, uploadBtn)
  body.appendChild(row)

  if (mode === 'image' && settings.bg.image) {
    const prev = vEl('div', 'setpreview')
    const im = document.createElement('img')
    im.src = settings.bg.image
    prev.appendChild(im)
    const rm = vEl('button', 'setbtn small', 'Remove image')
    rm.addEventListener('click', () => setBackground({ mode: 'photos' }))
    prev.appendChild(rm)
    body.appendChild(prev)
  }

  body.appendChild(vEl('div', 'setlabel', 'Solid color'))
  const sw = vEl('div', 'setswatches')
  for (const c of SOLID_COLORS) {
    const s = vEl('button', 'swatch' + (mode === 'color' && settings.bg.color === c.v ? ' on' : ''))
    s.style.background = c.v
    s.title = c.name
    s.addEventListener('click', () => setBackground({ mode: 'color', color: c.v }))
    sw.appendChild(s)
  }
  const custom = document.createElement('input')
  custom.type = 'color'
  custom.className = 'swatch customswatch'
  custom.title = 'Custom color'
  custom.value = (mode === 'color' && settings.bg.color) || '#1d1526'
  custom.addEventListener('input', () => setBackground({ mode: 'color', color: custom.value }))
  sw.appendChild(custom)
  body.appendChild(sw)

  // ---- Extensions ----
  body.appendChild(vEl('div', 'setsec', 'Extensions'))
  body.appendChild(vEl('div', 'setnote',
    'Install extensions from the Chrome Web Store. Icons appear in the toolbar and on each card’s header — click the one on a card to use the extension on that page. Some newer extensions may not fully work yet.'))
  const store = vEl('button', 'setbtn', '🧩 Browse the Chrome Web Store')
  store.addEventListener('click', () => { drift.extOpenStore(); closeSettingsPanel() })
  body.appendChild(store)

  const list = vEl('div', 'setextlist')
  body.appendChild(list)
  let exts = []
  try { exts = await drift.extList() } catch {}
  if (!exts.length) list.appendChild(vEl('div', 'setnote', 'No extensions installed yet.'))
  for (const e of exts) {
    const r2 = vEl('div', 'setextrow')
    const main = vEl('div', 'setextmain')
    main.appendChild(vEl('div', 'setextname', e.name || e.id))
    main.appendChild(vEl('div', 'setextver', 'v' + (e.version || '?')))
    r2.appendChild(main)
    const del = vEl('button', 'vmini danger', '×')
    del.title = 'Remove extension'
    del.addEventListener('click', async () => { await drift.extRemove(e.id); renderSettingsPanel() })
    r2.appendChild(del)
    list.appendChild(r2)
  }
  positionSettingsPanel()
}

function openSettingsPanel() {
  closeCtx()
  if (paletteOpen) closePalette()
  if (bmOpen) closeBmPanel()
  settingsOpen = true
  settingsPanelEl().classList.remove('hidden')
  renderSettingsPanel()
  positionSettingsPanel()
  scheduleLayout()
}

function closeSettingsPanel() {
  if (!settingsOpen) return
  settingsOpen = false
  settingsPanelEl().classList.add('hidden')
  scheduleLayout()
}

// ---------- palette (open + search) ----------

function openPalette(mode) {
  closeCtx()
  paletteMode = mode || {}
  palette.classList.remove('hidden')
  palInput.value = paletteMode.prefill || ''
  palHint.textContent = paletteMode.navigateId
    ? '↵ set this card’s address · esc cancel'
    : '↵ open on the canvas · ↑↓ pick a card or bookmark · esc cancel'
  paletteOpen = true
  palSel = -1
  renderPalResults()
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
  clearHits()
  palResults.classList.add('hidden')
  palResults.innerHTML = ''
  palHits = []
  palRows = []
  palRowEls = []
  palSel = -1
  scheduleLayout()
}

function clearHits() {
  for (const id of hitSet) cards.get(id)?.el.classList.remove('hit')
  hitSet = new Set()
}

function pickPalRow(row) {
  const mode = paletteMode
  closePalette()
  if (row.type === 'card') jumpToCard(row.c)
  else newCard(row.b.url, mode.at)
}

function palRowDom(iconText, favUrl, titleText, hostText, isBm) {
  const row = document.createElement('div')
  row.className = 'palrow' + (isBm ? ' bm' : '')
  const fav = document.createElement('span')
  fav.className = 'prfav'
  if (favUrl) {
    const img = document.createElement('img')
    img.src = favUrl
    img.onerror = () => { img.remove(); fav.textContent = iconText }
    fav.appendChild(img)
  } else fav.textContent = iconText
  const title = document.createElement('span')
  title.className = 'prtitle'
  title.textContent = titleText
  const host = document.createElement('span')
  host.className = 'prhost'
  host.textContent = hostText
  row.append(fav, title, host)
  return row
}

function renderPalResults() {
  clearHits()
  const q = palInput.value.trim().toLowerCase()
  palHits = []
  palRows = []
  palRowEls = []
  palResults.innerHTML = ''
  if (paletteMode.navigateId) {
    palResults.classList.add('hidden')
    palSel = -1
    drawMinimap()
    return
  }

  const addSection = label => {
    const s = document.createElement('div')
    s.className = 'palsec'
    s.textContent = label
    palResults.appendChild(s)
  }
  const addRow = (rowEl, rowData) => {
    const i = palRows.length
    palRows.push(rowData)
    palRowEls.push(rowEl)
    rowEl.addEventListener('mouseenter', () => { palSel = i; renderPalSelection() })
    rowEl.addEventListener('click', () => pickPalRow(rowData))
    palResults.appendChild(rowEl)
  }

  if (q) {
    palHits = [...cards.values()]
      .filter(c => (c.title || '').toLowerCase().includes(q) || (c.url || '').toLowerCase().includes(q))
      .sort((a, b) => b.lastActive - a.lastActive)
      .slice(0, 6)
    hitSet = new Set(palHits.map(c => c.id))
    for (const c of palHits) c.el.classList.add('hit')
    if (palHits.length) {
      addSection('On your canvas')
      for (const c of palHits) {
        addRow(palRowDom((hostOf(c.url)[0] || '?').toUpperCase(), c.fav, c.title || c.url, hostOf(c.url), false), { type: 'card', c })
      }
    }
    const bmHits = bookmarks
      .filter(b => (b.title || '').toLowerCase().includes(q) || (b.url || '').toLowerCase().includes(q))
      .slice(0, 6)
    if (bmHits.length) {
      addSection('Bookmarks')
      for (const b of bmHits) {
        addRow(palRowDom('★', b.fav, b.title || b.url, hostOf(b.url), true), { type: 'bm', b })
      }
    }
  } else if (bookmarks.length) {
    // Empty query: the palette doubles as your bookmarks shelf.
    addSection('Bookmarks')
    for (const b of bookmarks.slice(0, 8)) {
      addRow(palRowDom('★', b.fav, b.title || b.url, hostOf(b.url), true), { type: 'bm', b })
    }
  }

  palSel = clamp(palSel, -1, palRows.length - 1)
  palResults.classList.toggle('hidden', palRows.length === 0)
  renderPalSelection()
  drawMinimap()
}

function renderPalSelection() {
  palRowEls.forEach((el, i) => el.classList.toggle('sel', i === palSel))
}

function jumpToCard(c) {
  if (!cards.has(c.id)) return
  focusCard(c)
  flashCard(c)
}

// ---------- shortcuts from the app menu / page views ----------

drift.onUpdateAvailable(({ version }) => {
  $('#btnUpdate').textContent = `⬇ Drift ${version} is out — get the update`
  $('#updateG').classList.remove('hidden')
})

// Extension tab lifecycle (chrome.tabs.* and Web Store).
drift.onExtAdoptTab(({ id, url }) => adoptCard(id, url))
drift.onExtOpenSidePanel(d => openSidePanelCard(d))
drift.onExtSelectTab(({ id }) => {
  // The extension system activated a tab — reflect it in the UI. Guard against the
  // echo: main calls selectExtTab whenever a view is raised, and the library echoes
  // that straight back as another ext:selectTab. Re-raising here would bounce it back
  // to main forever — an infinite loop that pans the canvas on every turn (the "shake
  // and drift" bug). Skip if it's already the active card, and don't re-raise.
  if (id === activeId) return
  const c = cards.get(id)
  if (c) { setActive(id); ensureVisible(c) }
})
drift.onExtRemoveTab(({ id }) => { if (cards.has(id)) closeCard(id) })
drift.onExtReady(() => {
  extReady = true
  for (const c of cards.values()) mountCardExtActions(c)
})
drift.onSpawnUrl(({ url }) => { const c = newCard(url); if (c) flashCard(c) })

// ---------- AI assistant (chat dock lives in main as a native view) ----------

// The dock reserves a strip on the right; reframe the canvas so focused cards
// and the minimap stay clear of it.
drift.onAIDock(({ open, width }) => {
  aiDockW = open ? (width || 400) : 0
  minimap.style.right = (16 + aiDockW) + 'px'
  mmRect = null // the minimap just moved — its cached occlusion rect is stale
  $('#btnAI').classList.toggle('on', !!open)
  scheduleLayout()
})

// Verbs the assistant runs against the canvas. Each resolves back to main via
// drift.aiCanvasResult so a tool call can await the outcome.
async function runAICanvas(verb, args = {}) {
  switch (verb) {
    case 'list_cards':
      return [...cards.values()].map(c => {
        const zone = [...zones.values()].find(z => {
          const cx = c.x + c.w / 2, cy = c.y + c.h / 2
          return cx >= z.x && cx <= z.x + z.w && cy >= z.y && cy <= z.y + z.h
        })
        return {
          id: c.id, title: c.title, url: c.url,
          zone: zone ? (zone.name || 'zone') : null,
          edges: edges.filter(e => e.from === c.id || e.to === c.id)
            .map(e => (e.from === c.id ? e.to : e.from)),
          active: c.id === activeId, focused: c.id === fullId,
          live: !!c.live, panel: !!c.isPanel
        }
      })
    case 'open_card': {
      const u = normalizeInput(String(args.url || ''))
      if (!u) throw new Error('no valid url')
      // A fullscreen page covers the whole canvas — anything opened behind it
      // would be invisible while the tool reports success.
      if (fullId) exitFullscreen()
      const parent = args.parent_id && cards.get(args.parent_id)
      const c = parent ? spawnChild(parent, u) : newCard(u)
      if (c && !parent) flashCard(c)
      return { id: c ? c.id : null }
    }
    case 'navigate_card': {
      const c = cards.get(args.card_id)
      if (!c) throw new Error('no such card')
      if (args.action === 'url') {
        const u = normalizeInput(String(args.url || ''))
        if (!u) throw new Error('no valid url')
        navigateCard(c, u)
      } else if (['back', 'forward', 'reload'].includes(args.action)) {
        if (c.viewCreated) drift.navAction(c.id, args.action)
      }
      return { ok: true }
    }
    case 'focus_card': {
      const c = cards.get(args.card_id)
      if (!c) throw new Error('no such card')
      if (fullId && fullId !== c.id) exitFullscreen()
      jumpToCard(c)
      return { ok: true }
    }
    case 'ensure_live': {
      // Bring a card's page to life (creating its view if needed) and pin it so
      // pruneViews can't destroy it out from under an in-progress read.
      const c = cards.get(args.id || args.card_id)
      if (!c) throw new Error('no such card')
      c.lastActive = Date.now()
      c.aiPinnedUntil = Date.now() + 120000
      // Cap concurrent pins at 3: an unbounded set would suspend the
      // KEEP_ALIVE prune budget entirely ("summarize all 30 cards" would hold
      // 30 background Chromium processes alive at once).
      const pinned = [...cards.values()]
        .filter(x => x !== c && x.aiPinnedUntil > Date.now())
        .sort((a, b) => b.aiPinnedUntil - a.aiPinnedUntil)
      for (const x of pinned.slice(2)) x.aiPinnedUntil = 0
      setTimeout(scheduleLayout, 121000) // prune sweep once the pin lapses
      if (!c.viewCreated) {
        // A recreated view reloads from scratch — a stale everLoaded from its
        // previous life would end the wait loop before the page arrives.
        c.everLoaded = false
        await goLive(c)
        if (!c.viewCreated) throw new Error('could not create the page view')
      }
      // No c.live here: reads work on a detached webContents, and forcing
      // liveness on an off-screen card just churns attach/detach each frame.
      const t0 = Date.now()
      while (Date.now() - t0 < 12000) {
        if (c.error) throw new Error('the page failed to load: ' + c.error)
        if (!c.viewCreated) throw new Error('the page view went away while loading')
        if (c.everLoaded && c.viewReady) break
        await sleep(200)
      }
      return { ok: true, loaded: !!c.everLoaded }
    }
    case 'present_card': {
      // Interactions (click/type) need the card's native view attached at a
      // REAL viewport — a merely-live-but-off-screen card renders at 0×0, so
      // every element reads as off-screen and dispatched clicks hit nothing.
      // Focus (zoom to the card) brings it front-and-centre and live WITHOUT
      // taking over the whole screen the way fullscreen did — the canvas stays
      // visible around it and Escape gently returns the user.
      const c = cards.get(args.card_id || args.id)
      if (!c) throw new Error('no such card')
      const epoch = aiBrakeEpoch // if Escape fires while we work, bail out
      const nowPin = Date.now()
      c.lastActive = nowPin
      c.aiPinnedUntil = nowPin + 120000 // exempt its webContents from pruning
      c.aiActUntil = nowPin + 120000    // + force it live/attached so clicks land
      setTimeout(scheduleLayout, 121000)    // sweep once the pin lapses (parity with ensure_live)
      // Cap concurrent act-pins the way ensure_live caps read-pins: only the card
      // being acted on stays force-attached, and total prune-exempt cards stay
      // <=3 — else a multi-card action run ("reply to each of these threads")
      // force-attaches an unbounded set of Chromium views past the MAX_LIVE budget.
      for (const x of cards.values()) if (x !== c && x.aiActUntil > nowPin) x.aiActUntil = 0
      const otherPins = [...cards.values()].filter(x => x !== c && x.aiPinnedUntil > nowPin).sort((a, b) => b.aiPinnedUntil - a.aiPinnedUntil)
      for (const x of otherPins.slice(2)) x.aiPinnedUntil = 0
      // Any open overlay (walkthrough, palette, settings, bookmarks, context
      // menu) makes decideLiveness detach every page view — a detached view is
      // 0×0 and can't be clicked. Clear them so the card can actually go live.
      if (tourOpen) endTour()
      if (paletteOpen) closePalette()
      if (bmOpen) closeBmPanel()
      if (settingsOpen) closeSettingsPanel()
      if (typeof vaultOpen !== 'undefined' && vaultOpen) closeVaultPanel()
      if (ctxOpenFor) closeCtx()
      if (fullId && fullId !== c.id) exitFullscreen() // don't leave another card blown up
      if (!c.viewCreated) { c.everLoaded = false; await goLive(c); if (!c.viewCreated) throw new Error('could not create the page view') }
      if (aiBrakeEpoch !== epoch) throw new Error('interrupted — the user pressed Escape')
      if (fullId !== c.id) focusCard(c)
      const t0 = Date.now()
      while (Date.now() - t0 < 10000) {
        if (aiBrakeEpoch !== epoch) throw new Error('interrupted — the user pressed Escape')
        if (c.error) throw new Error('the page failed to load: ' + c.error)
        if (c.everLoaded && c.viewReady && c.live) break
        await sleep(120)
      }
      // The view must be live+attached at a real viewport or a dispatched click
      // hits a 0×0 phantom and silently misses (which reads to the assistant as
      // success, so it loops). If it never attached, fail loudly instead.
      if (!c.live || !c.viewReady) throw new Error('could not bring the card front-and-centre to act on it — its view did not attach; try again')
      await sleep(320) // let the focus glide + zoom settle before we click
      if (aiBrakeEpoch !== epoch) throw new Error('interrupted — the user pressed Escape')
      return { ok: true, loaded: !!c.everLoaded }
    }
    case 'card_glow': {
      const c = cards.get(args.card_id)
      if (c) c.el.classList.toggle('aiglow', !!args.on)
      return { ok: true }
    }
    default:
      throw new Error('unknown canvas verb: ' + verb)
  }
}

drift.onAICanvas(async ({ rpcId, verb, args }) => {
  try {
    const result = await runAICanvas(verb, args || {})
    drift.aiCanvasResult({ rpcId, ok: true, result })
  } catch (err) {
    drift.aiCanvasResult({ rpcId, ok: false, error: String((err && err.message) || err) })
  }
})

drift.onUIKey(({ key }) => {
  if (tourOpen && key !== 'escape' && key !== 'tour' && key !== 'brake') return
  switch (key) {
    case 'escape': onEscape(); break
    case 'brake':
      // Dock Escape mid-turn: the turn is already aborted in main. Take the
      // canvas back only if the assistant is actually holding it (a card it
      // zoomed in to act on) — otherwise leave the user's own view untouched.
      if ([...cards.values()].some(c => c.aiActUntil > Date.now())) onEscape()
      break
    case 'tour': tourOpen ? endTour() : startTour(); break
    case 'newcard': openPalette({}); break
    case 'search': openPalette({}); break
    case 'newzone': newZone(); break
    case 'reopen': reopenClosed(); break
    case 'tidy': tidy(); break
    case 'closecard': if (activeId) closeCard(activeId); break
    case 'fit': fitAll(); break
    case 'zoomin': zoomAt(viewW() / 2, innerHeight / 2, 1.25); break
    case 'zoomout': zoomAt(viewW() / 2, innerHeight / 2, 0.8); break
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
  const b = contentBBox()
  if (!b) return null
  // Include the current viewport in the bounds so the view rect stays on-map.
  const v1 = toWorld(0, 0), v2 = toWorld(innerWidth, innerHeight)
  const x1 = Math.min(b.x, v1.x), y1 = Math.min(b.y, v1.y)
  const x2 = Math.max(b.x + b.w, v2.x), y2 = Math.max(b.y + b.h, v2.y)
  const W = 180, H = 120, pad = 8
  const k = Math.min((W - pad * 2) / (x2 - x1), (H - pad * 2) / (y2 - y1))
  return { k, ox: pad + ((W - pad * 2) - (x2 - x1) * k) / 2 - x1 * k, oy: pad + ((H - pad * 2) - (y2 - y1) * k) / 2 - y1 * k }
}

// The minimap is DOM, but live pages are native views that always paint on
// top of the DOM — so a page overlapping the minimap corner clips it and looks
// broken. Hide the minimap whenever a live view (or fullscreen page) covers it.

// It's position:fixed at a constant size, so measure once per window size —
// getBoundingClientRect every frame forces a synchronous layout right after
// doLayout's style writes.
let mmRect = null, mmRectW = 0, mmRectH = 0
function minimapRect() {
  // Hidden minimap occludes nothing (and measures as a zero rect anyway) —
  // matches the pre-cache behavior so it can re-show itself next frame.
  if (minimap.classList.contains('hidden')) return null
  if (mmRect && mmRectW === innerWidth && mmRectH === innerHeight) return mmRect
  const r = minimap.getBoundingClientRect()
  if (!r.width) return null // display:none — not measurable yet
  mmRectW = innerWidth
  mmRectH = innerHeight
  mmRect = { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
  return mmRect
}

function minimapOccluded() {
  if (fullId && cards.get(fullId)?.viewReady) return true
  const r = minimapRect()
  if (!r) return false
  for (const c of cards.values()) {
    if (!c.live || !c.viewReady) continue
    const b = screenBodyRect(c)
    if (b.x < r.right && b.x + b.w > r.left && b.y < r.bottom && b.y + b.h > r.top) return true
  }
  return false
}

function drawMinimap() {
  const show = (cards.size > 0 || zones.size > 0) && !minimapOccluded()
  minimap.classList.toggle('hidden', !show)
  if (!show) return
  const ctx = minimap.getContext('2d')
  const t = minimapTransform()
  if (!t) return
  ctx.setTransform(2, 0, 0, 2, 0, 0) // canvas is 360x240 for 180x120 css px
  ctx.clearRect(0, 0, 180, 120)
  for (const z of zones.values()) {
    ctx.fillStyle = hexToRgba(z.color, 0.16)
    ctx.strokeStyle = hexToRgba(z.color, 0.5)
    ctx.lineWidth = 1
    ctx.fillRect(t.ox + z.x * t.k, t.oy + z.y * t.k, z.w * t.k, z.h * t.k)
    ctx.strokeRect(t.ox + z.x * t.k, t.oy + z.y * t.k, z.w * t.k, z.h * t.k)
  }
  for (const c of cards.values()) {
    ctx.fillStyle = hitSet.has(c.id) ? 'rgba(255,214,90,0.95)'
      : c.id === activeId ? 'rgba(255,180,105,0.95)' : 'rgba(214,206,222,0.5)'
    ctx.fillRect(t.ox + c.x * t.k, t.oy + c.y * t.k, Math.max(3, c.w * t.k), Math.max(2, c.h * t.k))
  }
  const v1 = toWorld(0, 0), v2 = toWorld(innerWidth, innerHeight)
  ctx.strokeStyle = 'rgba(255,180,105,0.9)'
  ctx.lineWidth = 1
  ctx.strokeRect(t.ox + v1.x * t.k, t.oy + v1.y * t.k, (v2.x - v1.x) * t.k, (v2.y - v1.y) * t.k)
}

// ---------- walkthrough ----------
// First-launch experience: a cinematic full-screen intro scene (aurora, ember
// particles, a drifting mini-constellation of glass cards, mouse parallax),
// then a guided coach-mark tour — a glass card with an animated vignette per
// step plus a sliding spotlight over the real UI. Shown once (localStorage
// flag), replayable via ? or the View menu.

const TOUR_STEPS = [
  {
    title: 'Glide around',
    body: 'Scroll with two fingers to <b>pan</b>. Pinch or <kbd>⌘</kbd>+scroll to <b>zoom</b> — pull back far enough and your pages become a constellation of thumbnails. <kbd>⌘0</kbd> fits everything on screen.',
    viz: `<svg viewBox="0 0 390 116">
      <rect class="vzdim" x="128" y="16" width="134" height="84" rx="10" stroke-dasharray="4 5"/>
      <g class="vzPan">
        <rect class="vzcard" x="58" y="28" width="84" height="56" rx="7"/>
        <rect class="vzbar" x="66" y="36" width="40" height="5" rx="2.5"/>
        <rect class="vzline" x="66" y="48" width="62" height="4" rx="2"/>
        <rect class="vzline" x="66" y="57" width="48" height="4" rx="2"/>
        <path class="vzdim" d="M 142 52 C 158 46, 162 42, 176 38"/>
        <rect class="vzcard" x="176" y="14" width="76" height="50" rx="7"/>
        <rect class="vzbar" x="184" y="22" width="34" height="5" rx="2.5"/>
        <rect class="vzline" x="184" y="34" width="56" height="4" rx="2"/>
        <rect class="vzline" x="184" y="43" width="42" height="4" rx="2"/>
        <path class="vzdim" d="M 214 64 C 222 74, 230 78, 244 82"/>
        <rect class="vzcard" x="244" y="66" width="72" height="44" rx="7"/>
        <rect class="vzbar" x="252" y="74" width="32" height="5" rx="2.5"/>
        <rect class="vzline" x="252" y="86" width="52" height="4" rx="2"/>
      </g>
    </svg>`
  },
  {
    title: 'This is a page card',
    body: 'Drag the <b>header</b> to move it, the corner grip to resize. <b>Double-click the header</b> to focus it — and <b>⛶</b> takes the page truly full-screen. <kbd>esc</kbd> floats you back out. Click its title to change the address.',
    target: () => [...cards.values()][0]?.el,
    viz: `<svg viewBox="0 0 390 116">
      <rect class="vzcard lit" x="138" y="16" width="114" height="84" rx="9"/>
      <rect class="vzbar vzPulse" x="146" y="24" width="98" height="11" rx="4"/>
      <rect class="vzline" x="146" y="46" width="82" height="5" rx="2.5"/>
      <rect class="vzline" x="146" y="58" width="64" height="5" rx="2.5"/>
      <rect class="vzline" x="146" y="70" width="74" height="5" rx="2.5"/>
      <circle class="vzdot vzGripDot" cx="248" cy="96" r="4.5"/>
    </svg>`
  },
  {
    title: 'Open anything',
    body: 'Press <kbd>⌘T</kbd> or double-click any empty spot on the canvas. Type an address or just search. Hit <b>☆</b> on any card to bookmark it — your bookmarks live right here in <kbd>⌘T</kbd>.',
    target: () => $('#btnNew'),
    viz: `<svg viewBox="0 0 390 116">
      <rect class="vzcard" x="93" y="40" width="204" height="36" rx="18"/>
      <circle class="vzdim" cx="114" cy="58" r="5"/>
      <path class="vzdim" d="M 118 62 L 123 67"/>
      <rect class="vzbar vzType" x="134" y="54" width="86" height="8" rx="4"/>
      <rect class="vzCaret" x="226" y="49" width="2" height="18" rx="1" fill="#ffb469"/>
    </svg>`
  },
  {
    title: 'Trails, not history',
    body: 'When a page opens a link "in a new tab", Drift spawns a <b>child card with a trail line</b> back to its parent. Draw one yourself: <b>drag the ○ on a card\'s right edge onto another card</b>. Double-click a trail to remove it, right-click a card to copy a whole trail as Markdown.',
    target: () => [...cards.values()][1]?.el,
    viz: `<svg viewBox="0 0 390 116">
      <rect class="vzcard" x="52" y="34" width="66" height="48" rx="7"/>
      <rect class="vzbar" x="60" y="42" width="30" height="5" rx="2.5"/>
      <rect class="vzline" x="60" y="54" width="48" height="4" rx="2"/>
      <rect class="vzline" x="60" y="63" width="38" height="4" rx="2"/>
      <rect class="vzcard lit" x="272" y="32" width="66" height="48" rx="7"/>
      <rect class="vzbar" x="280" y="40" width="30" height="5" rx="2.5"/>
      <rect class="vzline" x="280" y="52" width="48" height="4" rx="2"/>
      <rect class="vzline" x="280" y="61" width="38" height="4" rx="2"/>
      <path class="vztrail vzDraw" d="M 118 58 C 165 30, 225 30, 272 56"/>
      <!-- no cx/cy: offset-path translates additively from the element's own
           position in Chromium, so the dot must start at 0,0 to ride the path -->
      <circle class="vzdot vzTravel" r="4"/>
      <circle class="vzdot" cx="118" cy="58" r="3.2"/>
      <circle class="vzdot" cx="272" cy="56" r="3.2"/>
    </svg>`
  },
  {
    title: 'Zones keep you organized',
    body: 'Zones are named regions — "Trip planning", "Job hunt". <b>Drag the label</b> and every card inside travels along. Click the dot to recolor, the name to rename. <kbd>⇧⌘N</kbd> makes a new one.',
    target: () => [...zones.values()][0]?.el.querySelector('.zlabel') || $('#btnZone'),
    viz: `<svg viewBox="0 0 390 116">
      <rect class="vzZone" x="110" y="22" width="170" height="84" rx="10"/>
      <g class="vzZoneLabel">
        <rect x="122" y="14" width="62" height="15" rx="7.5" fill="rgba(255,154,94,0.85)"/>
        <rect x="132" y="20" width="42" height="3.5" rx="1.75" fill="rgba(35,19,13,0.7)"/>
      </g>
      <rect class="vzcard" x="128" y="44" width="58" height="42" rx="6"/>
      <rect class="vzbar" x="135" y="51" width="26" height="4" rx="2"/>
      <rect class="vzline" x="135" y="61" width="40" height="3.5" rx="1.75"/>
      <rect class="vzcard" x="204" y="52" width="58" height="42" rx="6"/>
      <rect class="vzbar" x="211" y="59" width="26" height="4" rx="2"/>
      <rect class="vzline" x="211" y="69" width="40" height="3.5" rx="1.75"/>
    </svg>`
  },
  {
    title: 'Find and tidy',
    body: '<kbd>⌘F</kbd> searches every card on your canvas — matches light up on the map. <b>Tidy</b> (<kbd>⇧⌘T</kbd>) auto-arranges your trails into clean trees.',
    target: () => $('#btnTidy'),
    viz: `<svg viewBox="0 0 390 116">
      <g class="vzScatter">
        <circle class="vzdot" cx="132" cy="30" r="5"/>
        <circle class="vzdot" cx="258" cy="84" r="5"/>
        <circle class="vzdot" cx="178" cy="90" r="5"/>
        <circle class="vzdot" cx="288" cy="26" r="5"/>
        <circle class="vzdot" cx="216" cy="46" r="5"/>
        <circle class="vzdot" cx="148" cy="66" r="5"/>
      </g>
      <g class="vzTree">
        <path class="vzdim" d="M 132 58 C 158 58, 172 26, 200 26"/>
        <path class="vzdim" d="M 132 58 L 200 58"/>
        <path class="vzdim" d="M 132 58 C 158 58, 172 90, 200 90"/>
        <path class="vzdim" d="M 200 26 L 268 26"/>
        <circle class="vzdot" cx="132" cy="58" r="5"/>
        <circle class="vzdot" cx="200" cy="26" r="5"/>
        <circle class="vzdot" cx="200" cy="58" r="5"/>
        <circle class="vzdot" cx="200" cy="90" r="5"/>
        <circle class="vzdot" cx="268" cy="26" r="5"/>
      </g>
    </svg>`
  },
  {
    title: 'It all just stays',
    body: 'Cards, trails, zones, bookmarks — everything lives <b>on your machine</b> and is right where you left it next launch. Closed something by accident? <b>Right-click → Reopen closed card</b>. Replay this tour anytime with <kbd>?</kbd>. Now go drift. ◍',
    target: () => $('#btnHelp'),
    viz: `<svg viewBox="0 0 390 116">
      <path class="vzdim" d="M 195 58 L 122 34"/>
      <path class="vzdim" d="M 195 58 L 272 30"/>
      <path class="vzdim" d="M 195 58 L 262 88"/>
      <circle class="istar" cx="122" cy="34" r="3"/>
      <circle class="istar" cx="272" cy="30" r="3"/>
      <circle class="istar" cx="262" cy="88" r="3"/>
      <circle class="istar" cx="104" cy="82" r="2.2"/>
      <circle class="istar" cx="300" cy="62" r="2.2"/>
      <circle class="vzRing" cx="195" cy="58" r="26"/>
      <circle class="vzRing r2" cx="195" cy="58" r="26"/>
      <circle cx="195" cy="58" r="12" fill="none" stroke="#ffb469" stroke-width="2"/>
      <circle class="vzdot" cx="195" cy="58" r="4.5"/>
    </svg>`
  }
]

function startTour() {
  closeCtx()
  if (paletteOpen) closePalette()
  tourOpen = true
  tourIdx = 0
  tourPhase = 'intro'
  tourEl.classList.remove('hidden')
  tourSpot.classList.add('hidden')
  tourCard.classList.add('hidden')
  introEnter()
  scheduleLayout() // detach live views under the overlay
}

// Hand-off from the intro scene to the coach-mark steps: the scene fades and
// gently scales away, revealing the spotlighted UI beneath.
let introHideT = 0

function beginTourSteps() {
  if (!tourOpen || tourPhase !== 'intro') return
  tourPhase = 'steps'
  introLeave()
  stopIntroSound(1.1, true) // fade the bed out under a soft hand-off whoosh
  introEl.classList.add('leaving')
  clearTimeout(introHideT)
  introHideT = setTimeout(() => introEl.classList.add('hidden'), 750)
  tourSpot.classList.remove('hidden')
  tourCard.classList.remove('hidden')
  renderTourStep()
}

function endTour() {
  if (!tourOpen) return
  tourOpen = false
  introLeave()
  stopIntroSound(0.5)
  clearTimeout(introHideT)
  introEl.classList.add('hidden')
  introEl.classList.remove('leaving', 'play')
  tourEl.classList.add('hidden')
  try { localStorage.setItem('drift-tour-done', '1') } catch {}
  scheduleLayout()
}

function nextTour() {
  if (!tourOpen) return
  if (tourPhase === 'intro') { beginTourSteps(); return } // advancing the intro = entering the steps
  if (tourIdx >= TOUR_STEPS.length - 1) { endTour(); return }
  tourIdx++
  renderTourStep()
}

function prevTour() {
  if (tourPhase !== 'steps') return
  if (tourIdx > 0) { tourIdx--; renderTourStep() }
}

function renderTourStep() {
  const step = TOUR_STEPS[tourIdx]
  if (!step) return
  $('#tourDots').innerHTML = TOUR_STEPS.map((_, i) =>
    `<span class="${i === tourIdx ? 'on' : i < tourIdx ? 'done' : ''}"></span>`).join('')
  $('#tourViz').innerHTML = step.viz || ''
  $('#tourTitle').textContent = step.title
  $('#tourBody').innerHTML = step.body
  $('#tourNext').textContent = tourIdx === TOUR_STEPS.length - 1 ? 'Start drifting ◍' : 'Next ›'
  $('#tourBack').classList.toggle('hidden', tourIdx === 0)
  tourCard.classList.toggle('center', !stepTarget(step))
  tourCard.classList.remove('anim')
  void tourCard.offsetWidth // restart the step-in animation
  tourCard.classList.add('anim')
  positionTour()
}

// ----- intro scene machinery -----

let introRAF = 0
let introTx = 0, introTy = 0, introCx = 0, introCy = 0
let introBuilt = false

function introEnter() {
  clearTimeout(introHideT) // a still-pending hand-off fade must not hide a replayed intro
  introEl.classList.remove('hidden', 'leaving')
  buildIntroParticles()
  introFitStage()
  startIntroSound()
  refreshIntroMute()
  // Restart the staged entrance animations on every (re)play.
  introEl.classList.remove('play')
  void introEl.offsetWidth
  introEl.classList.add('play')
  introTx = introTy = introCx = introCy = 0
  introEl.style.setProperty('--mx', '0')
  introEl.style.setProperty('--my', '0')
  tourEl.addEventListener('pointermove', introPointer)
  cancelAnimationFrame(introRAF)
  introRAF = requestAnimationFrame(introTick)
}

function introLeave() {
  tourEl.removeEventListener('pointermove', introPointer)
  cancelAnimationFrame(introRAF)
  introRAF = 0
}

function introPointer(e) {
  introTx = clamp((e.clientX / innerWidth) * 2 - 1, -1, 1)
  introTy = clamp((e.clientY / innerHeight) * 2 - 1, -1, 1)
}

function introTick() {
  // Ease toward the pointer so the parallax layers glide instead of jitter.
  introCx += (introTx - introCx) * 0.06
  introCy += (introTy - introCy) * 0.06
  introEl.style.setProperty('--mx', introCx.toFixed(4))
  introEl.style.setProperty('--my', introCy.toFixed(4))
  introRAF = requestAnimationFrame(introTick)
}

function introFitStage() {
  const s = Math.min(1, innerWidth / 1150, (innerHeight - 40) / 680)
  $('#introStage').style.setProperty('--ss', s.toFixed(3))
}

// ----- intro sound -----
// A synthesized ambient bed for the arrival scene: a warm detuned pad that
// swells in under an opening lowpass ("sunrise"), a soft two-note bloom timed
// to the wordmark reveal, and a filtered-noise whoosh on the hand-off. Pure
// WebAudio — no assets, nothing fetched. Mutable via the speaker button
// (persisted); never plays in staged (selftest/promo) runs.

let introAC = null // { ctx, master } while the bed is playing

function introSoundOn() {
  try { return localStorage.getItem('drift-intro-sound') !== 'off' } catch { return true }
}

function refreshIntroMute() {
  const b = $('#introMute')
  if (b) b.textContent = introSoundOn() ? '🔊' : '🔇'
}

function startIntroSound() {
  if (HEADLESS || !introSoundOn() || introAC) return
  let ctx
  try { ctx = new AudioContext() } catch { return }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  const t0 = ctx.currentTime
  const master = ctx.createGain()
  master.gain.setValueAtTime(0.0001, t0)
  master.gain.exponentialRampToValueAtTime(0.14, t0 + 4.5)
  master.connect(ctx.destination)

  // Warm pad: an A-major spread with gently detuned pairs (slow beating).
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.setValueAtTime(420, t0)
  lp.frequency.linearRampToValueAtTime(950, t0 + 5.5)
  lp.Q.value = 0.4
  lp.connect(master)
  const padGain = ctx.createGain()
  padGain.gain.value = 0.5
  padGain.connect(lp)
  for (const [f, g] of [[55, 0.5], [110, 0.6], [110.5, 0.35], [164.8, 0.4], [165.4, 0.25], [220, 0.3], [277.2, 0.16]]) {
    const o = ctx.createOscillator()
    o.type = f < 100 ? 'sine' : 'triangle'
    o.frequency.value = f
    const og = ctx.createGain()
    og.gain.value = g
    o.connect(og)
    og.connect(padGain)
    o.start(t0)
  }

  // A faint high shimmer that breathes on a slow LFO.
  const sh = ctx.createOscillator()
  sh.type = 'sine'
  sh.frequency.value = 1760
  const shg = ctx.createGain()
  shg.gain.value = 0.0001
  const lfo = ctx.createOscillator()
  lfo.frequency.value = 0.13
  const lfog = ctx.createGain()
  lfog.gain.value = 0.006
  lfo.connect(lfog)
  lfog.connect(shg.gain)
  sh.connect(shg)
  shg.connect(master)
  sh.start(t0)
  lfo.start(t0)

  // Bloom: two soft sine notes as the wordmark lands (~2.45s in).
  for (const [f, at, dur, g] of [[880, 2.45, 2.6, 0.05], [1108.7, 2.6, 2.4, 0.035]]) {
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.value = f
    const og = ctx.createGain()
    og.gain.setValueAtTime(0.0001, t0 + at)
    og.gain.exponentialRampToValueAtTime(g, t0 + at + 0.08)
    og.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur)
    o.connect(og)
    og.connect(master)
    o.start(t0 + at)
    o.stop(t0 + at + dur + 0.1)
  }
  introAC = { ctx, master }
}

function stopIntroSound(fade = 0.6, whoosh = false) {
  const a = introAC
  if (!a) return
  introAC = null
  const t = a.ctx.currentTime
  if (whoosh) {
    // Filtered-noise sweep: the "release" into the canvas.
    const len = Math.floor(a.ctx.sampleRate)
    const buf = a.ctx.createBuffer(1, len, a.ctx.sampleRate)
    const ch = buf.getChannelData(0)
    for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / len)
    const src = a.ctx.createBufferSource()
    src.buffer = buf
    const bp = a.ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.setValueAtTime(1400, t)
    bp.frequency.exponentialRampToValueAtTime(180, t + 0.9)
    bp.Q.value = 0.8
    const g = a.ctx.createGain()
    g.gain.setValueAtTime(0.06, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.95)
    src.connect(bp)
    bp.connect(g)
    g.connect(a.ctx.destination)
    src.start(t)
  }
  a.master.gain.cancelScheduledValues(t)
  a.master.gain.setValueAtTime(Math.max(a.master.gain.value, 0.0001), t)
  a.master.gain.exponentialRampToValueAtTime(0.0001, t + fade)
  setTimeout(() => a.ctx.close().catch(() => {}), fade * 1000 + 500)
}

function buildIntroParticles() {
  if (introBuilt) return
  introBuilt = true
  const host = $('#introParticles')
  const frag = document.createDocumentFragment()
  const tones = ['255,190,140', '255,150,150', '255,220,190', '235,180,255']
  for (let i = 0; i < 26; i++) {
    const p = document.createElement('span')
    p.className = 'ipart'
    const size = 1.5 + Math.random() * 2.5
    const tone = tones[i % tones.length]
    p.style.width = p.style.height = size.toFixed(1) + 'px'
    p.style.left = (Math.random() * 100).toFixed(2) + 'vw'
    p.style.background = `rgb(${tone})`
    p.style.boxShadow = `0 0 ${(size * 3).toFixed(0)}px rgba(${tone},0.5)`
    p.style.setProperty('--pd', (16 + Math.random() * 18).toFixed(1) + 's')
    p.style.setProperty('--pl', (-Math.random() * 34).toFixed(1) + 's')
    p.style.setProperty('--po', (0.25 + Math.random() * 0.5).toFixed(2))
    p.style.setProperty('--pxs', ((Math.random() - 0.5) * 120).toFixed(0) + 'px')
    frag.appendChild(p)
  }
  host.appendChild(frag)
}

function stepTarget(step) {
  const t = step.target && step.target()
  return t && t.getBoundingClientRect ? t : null
}

// Positions are re-derived every layout frame, so the spotlight tracks its
// target through pans, zooms, and window resizes.
function positionTour() {
  if (!tourOpen || tourPhase !== 'steps') return
  const step = TOUR_STEPS[tourIdx]
  const t = stepTarget(step)
  if (t) {
    const r = t.getBoundingClientRect()
    const pad = 10
    tourSpot.style.left = (r.left - pad) + 'px'
    tourSpot.style.top = (r.top - pad) + 'px'
    tourSpot.style.width = (r.width + pad * 2) + 'px'
    tourSpot.style.height = (r.height + pad * 2) + 'px'
  } else {
    tourSpot.style.left = innerWidth / 2 + 'px'
    tourSpot.style.top = innerHeight / 2 + 'px'
    tourSpot.style.width = '0px'
    tourSpot.style.height = '0px'
  }
  const cw = tourCard.offsetWidth, ch = tourCard.offsetHeight
  let x, y
  if (t) {
    // Prefers below → above → beside; targets taller than ~45% of the canvas
    // (spotlighted page cards) prefer the side instead, so the coach card
    // never buries the thing it's pointing at.
    const r = t.getBoundingClientRect()
    const m = 22, pad = 16
    const vw = viewW() // keep the card off the native AI dock strip
    const cx = clamp(r.left + r.width / 2 - cw / 2, pad, vw - cw - pad)
    const cy = clamp(r.top + r.height / 2 - ch / 2, TOOLBAR + pad, innerHeight - ch - pad)
    const fits = {
      below: r.bottom + m + ch <= innerHeight - pad,
      above: r.top - m - ch >= TOOLBAR + pad,
      right: r.right + m + cw <= vw - pad,
      left: r.left - m - cw >= pad
    }
    const big = r.height > (innerHeight - TOOLBAR) * 0.45
    const order = big ? ['right', 'left', 'below', 'above'] : ['below', 'above', 'right', 'left']
    switch (order.find(k => fits[k])) {
      case 'below': x = cx; y = r.bottom + m; break
      case 'above': x = cx; y = r.top - m - ch; break
      case 'right': x = r.right + m; y = cy; break
      case 'left': x = r.left - m - cw; y = cy; break
      default: x = cx; y = clamp(innerHeight / 2 - ch / 2, TOOLBAR + pad, innerHeight - ch - pad)
    }
    // A spotlit card can sit (partly) off-viewport on an inherited canvas —
    // the coach card itself must always stay readable on screen.
    x = clamp(x, pad, vw - cw - pad)
    y = clamp(y, TOOLBAR + pad, innerHeight - ch - pad)
  } else {
    x = (viewW() - cw) / 2
    y = clamp(innerHeight * 0.42 - ch / 2, 16, innerHeight - ch - 16)
  }
  tourCard.style.left = x + 'px'
  tourCard.style.top = y + 'px'
}

// ---------- persistence ----------

function serialize() {
  return {
    v: 2,
    seq,
    view: { ...V },
    // Extension side-panel cards host a chrome-extension:// page bound to a live
    // tab id; they're transient UI, not saved artifacts, so they're never persisted.
    cards: [...cards.values()].filter(c => !c.isPanel).map(c => ({
      id: c.id, url: c.url, title: c.title, fav: c.fav,
      x: c.x, y: c.y, w: c.w, h: c.h,
      snapshot: c.snapshot, createdAt: c.createdAt, lastActive: c.lastActive
    })),
    zones: [...zones.values()].map(z => ({
      id: z.id, name: z.name, x: z.x, y: z.y, w: z.w, h: z.h, color: z.color
    })),
    edges: edges.filter(e => {
      const a = cards.get(e.from), b = cards.get(e.to)
      return (!a || !a.isPanel) && (!b || !b.isPanel)
    }).map(e => ({ ...e }))
  }
}

function restore(st) {
  if (!st || typeof st !== 'object') { firstRun(); return }
  seq = num(st.seq, 0)
  if (st.view && Number.isFinite(st.view.s)) {
    V.s = clamp(st.view.s, MIN_S, MAX_S)
    // Only adopt finite offsets; a NaN here would blank the canvas and the
    // offscreen check below can't recompute from it.
    V.ox = num(st.view.ox, V.ox)
    V.oy = num(st.view.oy, V.oy)
  }
  for (const zd of (Array.isArray(st.zones) ? st.zones : [])) { try { createZone(zd) } catch {} }
  for (const d of (Array.isArray(st.cards) ? st.cards : [])) { try { createCard(d, { restored: true }) } catch {} }
  for (const e of (Array.isArray(st.edges) ? st.edges : [])) { if (e) addEdge(e.from, e.to, true) }
  // Recover from a corrupted/runaway view offset. The pre-0.3.1 canvas-drift bug
  // could push the saved view millions of pixels from the content; restoring that
  // verbatim would show an empty void. If nothing would be on screen, fit to content.
  const bb = contentBBox()
  if (bb && Number.isFinite(V.ox) && Number.isFinite(V.oy)) {
    const sx = bb.x * V.s + V.ox, sy = bb.y * V.s + V.oy, sw = bb.w * V.s, sh = bb.h * V.s
    const offScreen = sx + sw < 40 || sx > innerWidth - 40 || sy + sh < TOOLBAR + 40 || sy > innerHeight - 40
    if (offScreen) fitAll()
  } else if (bb) {
    fitAll() // non-finite saved offset
  }
  dirty = false
}

function firstRun() {
  // A tiny demo trail: the idea Drift is built on, and the essay it came from.
  const a = createCard({ url: 'https://en.wikipedia.org/wiki/Memex', x: 0, y: 0, w: 820, h: 580 })
  const b = createCard({ url: 'https://en.wikipedia.org/wiki/As_We_May_Think', x: 940, y: 120, w: 820, h: 580 })
  addEdge(a.id, b.id)
  createZone({ x: -80, y: -90, w: 1930, h: 880, name: 'How Drift thinks', color: '#ff9a5e' })
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
    if (shot) await drift.selftestArtifact('selftest-page.jpg', shot)
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

    // ---- v0.2 features ----
    createZone({ x: -140, y: -220, w: 2100, h: 1700, name: 'Research' })
    if (zones.size !== 1) report.errors.push('zone not created')
    if (!/^#[0-9a-f]{6}$/i.test(serialize().zones[0].color || '')) report.errors.push('zone color not persisted as hex')

    openPalette({})
    palInput.value = 'memex'
    palInput.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(150)
    report.searchHits = palHits.length
    if (!palHits.length) report.errors.push('canvas search found nothing for "memex"')
    closePalette()

    const md = trailMarkdown(a.id)
    report.trailLines = md.split('\n').length
    if (!md.includes('https://en.wikipedia.org/wiki/Memex')) report.errors.push('trail markdown missing expected link')

    const edgesBefore = edges.length
    connectCards(b, c) // manual trail (same path as the port drag)
    if (edges.length !== edgesBefore + 1) report.errors.push('manual trail connect failed')
    if (!removeEdge(b.id, c.id)) report.errors.push('manual trail remove failed')
    if (edges.length !== edgesBefore) report.errors.push('edge count wrong after connect/remove')

    focusPair(b, c)
    await sleep(500)
    if (!splitInfo) report.errors.push('split focus did not engage')
    exitFocus()
    await sleep(450)

    // new zones must not spawn on top of existing zones or cards
    const z2 = newZone()
    const z1 = [...zones.values()][0]
    if (z2.x < z1.x + z1.w && z2.x + z2.w > z1.x && z2.y < z1.y + z1.h && z2.y + z2.h > z1.y) {
      report.errors.push('new zone spawned overlapping an existing zone')
    }
    removeZone(z2.id)

    enterFullscreen(b)
    await sleep(700)
    if (fullId !== b.id) report.errors.push('fullscreen did not engage')
    const fshot = await drift.snapshot(b.id, 1000)
    if (fshot) await drift.selftestArtifact('selftest-fullscreen.jpg', fshot)
    else report.errors.push('fullscreen snapshot failed')
    exitFullscreen()
    if (fullId) report.errors.push('fullscreen did not exit')
    await sleep(300)

    // reopen closed card: geometry, snapshot, and trail come back
    const sizeBefore = cards.size
    const edgeCountBefore = edges.length
    closeCard(c.id)
    const reopened = reopenClosed()
    if (!reopened || cards.size !== sizeBefore) report.errors.push('reopen closed card failed')
    if (edges.length !== edgeCountBefore) report.errors.push('reopened card did not reconnect its trail')

    tidy()
    await sleep(900)

    const bmCard = [...cards.values()][0]
    toggleBookmark(bmCard)
    if (bookmarks.length !== 1) report.errors.push('bookmark not saved')
    openPalette({})
    await sleep(120)
    if (!palRows.some(r => r.type === 'bm')) report.errors.push('palette does not list bookmarks')
    closePalette()

    openBmPanel()
    if (!bmOpen) report.errors.push('bookmarks panel did not open')
    if (!bmList.querySelectorAll('.palrow').length) report.errors.push('bookmarks panel shows no rows')
    closeBmPanel()

    // bookmark folders
    bmFolders = ['Research']
    moveBookmark(bmCard.url, 'Research')
    if (bookmarks.find(b => b.url === bmCard.url)?.folder !== 'Research') report.errors.push('bookmark not moved into folder')

    // export → parse round trip (own format)
    const roundtrip = parseBookmarksHTML(bookmarksToHTML())
    if (!roundtrip.items.find(x => x.url === bmCard.url)) report.errors.push('export/import round trip lost a bookmark')
    if (!roundtrip.folders.includes('Research')) report.errors.push('export/import round trip lost a folder')

    // parse a Brave/Chrome-style nested export with a container root + favicon
    const braveHTML = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p>\n' +
      '<DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>\n<DL><p>\n' +
      '<DT><A HREF="https://news.ycombinator.com/" ICON="data:image/png;base64,iVBORw0=">Hacker News</A>\n' +
      '<DT><H3>Reading</H3>\n<DL><p>\n' +
      '<DT><A HREF="https://example.org/">Example</A>\n' +
      '<DT><H3>Deep</H3>\n<DL><p>\n<DT><A HREF="https://deep.example/">Deep link</A>\n</DL><p>\n' +
      '</DL><p>\n</DL><p>\n</DL><p>\n'
    const braveParsed = parseBookmarksHTML(braveHTML)
    report.import = { items: braveParsed.items.length, folders: braveParsed.folders }
    if (braveParsed.items.length !== 3) report.errors.push('import parsed wrong item count: ' + braveParsed.items.length)
    if (braveParsed.folders.includes('Bookmarks bar')) report.errors.push('import kept the browser container as a folder')
    if (!braveParsed.folders.includes('Reading / Deep')) report.errors.push('import lost nested folder path')
    if (braveParsed.items.find(i => i.url === 'https://news.ycombinator.com/')?.folder) report.errors.push('container child should be top-level, not foldered')
    if (!braveParsed.items.find(i => i.url === 'https://news.ycombinator.com/')?.fav) report.errors.push('import dropped the embedded favicon')
    if (braveParsed.items.find(i => i.url === 'https://deep.example/')?.folder !== 'Reading / Deep') report.errors.push('nested bookmark got wrong folder path')

    removeFolder('Research')
    if (bookmarks.find(b => b.url === bmCard.url)?.folder) report.errors.push('folder removal did not unsort bookmark')

    toggleBookmark(bmCard)
    if (bookmarks.length !== 0) report.errors.push('bookmark not removed')

    const growZone = [...zones.values()][0]
    const growCard = [...cards.values()][0]
    growCard.x = growZone.x + 100 // keep its center inside the zone
    growCard.y = growZone.y + 100
    growCard.el.style.left = growCard.x + 'px'
    growCard.el.style.top = growCard.y + 'px'
    const zoneW0 = growZone.w
    growCard.w = growZone.w + 600 // outgrow the zone on purpose
    growCard.el.style.width = growCard.w + 'px'
    autoGrowZones()
    if (growZone.w <= zoneW0) report.errors.push('zone did not auto-grow around an oversized card')

    // ---- password vault (real crypto round trip through the app) ----
    await vaultSetup('test-master-pw')
    await vaultAddEntry({ label: 'example.com', url: 'https://example.com/login', origin: 'https://example.com', username: 'brad', password: 's3cret!' })
    if (vaultEntries.length !== 1) report.errors.push('vault entry not added')
    vaultLock()
    if (vaultKey) report.errors.push('vault did not lock')
    const bad = await vaultUnlock('wrong')
    if (bad) report.errors.push('vault unlocked with wrong password')
    const good = await vaultUnlock('test-master-pw')
    if (!good) report.errors.push('vault did not unlock with correct password')
    if (vaultEntries[0]?.password !== 's3cret!') report.errors.push('vault did not decrypt saved password')
    report.vault = { blobHasCipher: !!(vaultBlob && vaultBlob.ct), entries: vaultEntries.length }

    // UI smoke: both panels must render in every state without throwing.
    await vaultUnlock('test-master-pw')
    openVaultPanel()
    if (!vaultPanel().querySelector('.vrow')) report.errors.push('vault panel did not render an unlocked entry row')
    vaultLock(); renderVaultPanel()
    if (!vaultPanel().querySelector('.vinput')) report.errors.push('locked vault panel did not render unlock field')
    closeVaultPanel()
    bmFolders = ['Research']; toggleBookmark(bmCard); moveBookmark(bmCard.url, 'Research')
    openBmPanel()
    if (!bmList.querySelector('.bmgroup')) report.errors.push('bookmarks panel did not render a folder group')
    closeBmPanel()
    removeFolder('Research'); toggleBookmark(bmCard); bmFolders = []

    // ---- settings: background modes + settings panel render ----
    settings.bg = { mode: 'color', color: '#0d0b10' }
    applyBackground()
    if (!document.body.classList.contains('bg-solid')) report.errors.push('solid-color background did not apply')
    settings.bg = { mode: 'image', image: 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=' }
    applyBackground()
    if (document.body.classList.contains('bg-solid')) report.errors.push('image background left bg-solid on')
    settings.bg = { mode: 'photos' }
    applyBackground()
    await renderSettingsPanel()
    settingsOpen = true
    if (!settingsPanelEl().querySelector('.setswatches')) report.errors.push('settings panel did not render swatches')
    if (!settingsPanelEl().querySelector('.setextlist')) report.errors.push('settings panel did not render extensions section')
    settingsOpen = false
    report.settings = { swatches: SOLID_COLORS.length }

    // ---- minimap occlusion: fullscreen hides the minimap ----
    const fsCard = [...cards.values()][0]
    enterFullscreen(fsCard)
    if (!minimapOccluded()) report.errors.push('minimap not marked occluded during fullscreen')
    exitFullscreen()
    if (minimapOccluded()) {
      report.errors.push('minimap still occluded after leaving fullscreen')
      report.mmDebug = {
        V: { ...V },
        mm: minimapRect(),
        live: [...cards.values()].filter(c => c.live && c.viewReady).map(c => ({ id: c.id, r: screenBodyRect(c) }))
      }
    }

    startTour()
    if (!tourOpen) report.errors.push('walkthrough did not open')
    if (tourPhase !== 'intro') report.errors.push('walkthrough did not start on the intro scene')
    beginTourSteps()
    if (tourPhase !== 'steps') report.errors.push('walkthrough did not enter the steps phase')
    for (let i = 0; i < TOUR_STEPS.length + 2 && tourOpen; i++) { nextTour(); await sleep(50) }
    if (tourOpen) report.errors.push('walkthrough did not finish after advancing')
    startTour() // leave the cinematic intro up so the final capture shows it
    await sleep(300)

    report.v2 = { zones: zones.size, searchHits: report.searchHits, tourSteps: TOUR_STEPS.length, folders: true, vault: true }

    // ---- AI assistant: drive the whole agent spine offline (mock provider) ----
    // Exercises providers.stream + the tool loop + the canvas RPC round-trip
    // (the mock model calls list_cards, which runs in this renderer).
    const ai = await drift.aiSelftest()
    report.ai = ai
    if (!ai || !ai.ok) report.errors.push('ai selftest failed: ' + (ai && ai.error))
    else {
      if (!ai.toolRan) report.errors.push('ai agent did not run a tool')
      if (!ai.text || !ai.text.trim()) report.errors.push('ai agent produced no text')
    }
  } catch (err) {
    report.errors.push(String(err && err.stack || err))
  }
  await drift.selftestDone(report)
}

// ---------- backdrop ----------
// A fresh full-bleed photo every launch, cycling through a curated set of
// landscape and cityscape shots (stable picsum ids, hand-checked: no people).
// If the network is down, a layered aurora gradient takes its place.

const BACKDROPS = [10, 11, 13, 15, 16, 28, 29, 46, 49, 110, 122, 128, 164, 184, 218]

// Applies whatever background the user has chosen in settings: a fresh Drift
// photo (default), their own uploaded image, or a solid color.
function applyBackground() {
  const img = document.getElementById('bgimg')
  const bg = (settings.bg && typeof settings.bg === 'object') ? settings.bg : { mode: 'photos' }
  document.body.classList.remove('bgready', 'nobg', 'bg-solid')

  if (bg.mode === 'color' && bg.color) {
    document.body.classList.add('bg-solid')
    document.getElementById('bg').style.background = bg.color
    return
  }
  document.getElementById('bg').style.background = ''

  if (bg.mode === 'image' && bg.image) {
    img.onload = () => document.body.classList.add('bgready')
    img.onerror = () => document.body.classList.add('nobg')
    img.src = bg.image
    return
  }

  // Default: a curated Drift photo, different from last launch.
  let last = -1
  try { last = parseInt(localStorage.getItem('drift-bg') || '-1', 10) } catch {}
  let pick = Math.floor(Math.random() * BACKDROPS.length)
  if (BACKDROPS.length > 1 && pick === last) pick = (pick + 1) % BACKDROPS.length
  try { localStorage.setItem('drift-bg', String(pick)) } catch {}
  const w = Math.min(3840, Math.round(innerWidth * (devicePixelRatio || 1)))
  const h = Math.min(2160, Math.round(innerHeight * (devicePixelRatio || 1)))
  img.onload = () => document.body.classList.add('bgready')
  img.onerror = () => document.body.classList.add('nobg')
  img.src = `https://picsum.photos/id/${BACKDROPS[pick]}/${Math.max(w, 1600)}/${Math.max(h, 1000)}`
}

// ---------- promo screenshot ----------
// `npm run promoshot` stages a biology research canvas — a trail of connected
// pages inside a zone — and captures the window for the landing page.

// Staged canvases for marketing shots. Each scene is a themed web of real
// pages; `dock` reserves the AI-dock strip so a chat capture can be composited
// into the frame afterwards (the dock is a native view — it can't appear in a
// canvas-DOM capture directly).
const PROMO_SCENES = {
  biology: {
    zone: { x: -120, y: -400, w: 2940, h: 2090, name: 'Biology', color: '#6ee7a0' },
    dock: 400,
    cards: [
      ['https://en.wikipedia.org/wiki/Cell_(biology)', 0, 340],
      ['https://en.wikipedia.org/wiki/DNA', 950, -120],
      ['https://en.wikipedia.org/wiki/Mitochondrion', 950, 800],
      ['https://en.wikipedia.org/wiki/CRISPR_gene_editing', 1900, -280],
      ['https://en.wikipedia.org/wiki/Evolution', 1900, 360],
      ['https://en.wikipedia.org/wiki/Photosynthesis', 1900, 1000]
    ],
    edges: [[0, 1], [0, 2], [1, 3], [1, 4], [2, 5]],
    active: 1
  },
  streaming: {
    zone: { x: -120, y: -400, w: 2940, h: 2090, name: 'Movie night', color: '#ff6f91' },
    // Logged-out streaming HOMEpages photograph badly (empty shells, consent
    // walls) — these routes all paint rich content without an account.
    settle: 15000,
    cards: [
      ['https://www.netflix.com/', 0, 340],
      ['https://www.youtube.com/movies', 950, -120],
      ['https://www.themoviedb.org/', 950, 800],
      ['https://www.justwatch.com/ca', 1900, -280],
      ['https://www.primevideo.com/', 1900, 360],
      ['https://www.imdb.com/chart/top/', 1900, 1000]
    ],
    edges: [[0, 2], [0, 4], [1, 3], [2, 5]],
    active: 0
  },
  research: {
    zone: { x: -120, y: -400, w: 2940, h: 2090, name: 'Space research', color: '#b78cff' },
    cards: [
      ['https://en.wikipedia.org/wiki/James_Webb_Space_Telescope', 0, 340],
      ['https://en.wikipedia.org/wiki/Black_hole', 950, -120],
      ['https://en.wikipedia.org/wiki/Mars', 950, 800],
      ['https://en.wikipedia.org/wiki/Exoplanet', 1900, -280],
      ['https://en.wikipedia.org/wiki/SpaceX_Starship', 1900, 360],
      ['https://en.wikipedia.org/wiki/International_Space_Station', 1900, 1000]
    ],
    edges: [[0, 1], [0, 3], [2, 4], [2, 5]],
    active: 0
  },
  travel: {
    zone: { x: -120, y: -400, w: 2940, h: 2090, name: 'Tokyo trip', color: '#ffd166' },
    cards: [
      ['https://en.wikivoyage.org/wiki/Tokyo', 0, 340],
      ['https://en.wikipedia.org/wiki/Tokyo', 950, -120],
      ['https://www.japan-guide.com/', 950, 800],
      ['https://en.wikipedia.org/wiki/Mount_Fuji', 1900, -280],
      ['https://en.wikipedia.org/wiki/Shinkansen', 1900, 360],
      ['https://en.wikipedia.org/wiki/Kyoto', 1900, 1000]
    ],
    edges: [[0, 1], [0, 2], [1, 3], [1, 4], [2, 5]],
    active: 0
  }
}

async function runPromoshot() {
  const scene = PROMO_SCENES[new URLSearchParams(location.search).get('scene')] || PROMO_SCENES.biology
  const W = 780, H = 560
  const mk = (url, x, y) => createCard({ url, x, y, w: W, h: H })
  const all = scene.cards.map(([url, x, y]) => mk(url, x, y))
  for (const [a, b] of scene.edges) addEdge(all[a].id, all[b].id)
  createZone(scene.zone)
  setActive(all[scene.active || 0].id)
  // Reserve the dock strip so the framing matches how the shot composites.
  if (scene.dock) aiDockW = scene.dock

  // Hold the view above the live threshold so every page loads and paints.
  const bbLoad = contentBBox()
  V.s = 0.45
  V.ox = viewW() / 2 - (bbLoad.x + bbLoad.w / 2) * V.s
  V.oy = TOOLBAR + (innerHeight - TOOLBAR) / 2 - (bbLoad.y + bbLoad.h / 2) * V.s
  scheduleLayout()
  const t0 = Date.now()
  while (Date.now() - t0 < 30000) {
    if (all.every(x => x.everLoaded)) break
    await sleep(300)
  }
  await sleep(scene.settle || 2000)
  // Cookie/consent overlays photograph terribly — a promo-only main handler
  // strips them from every staged page before the thumbnails are taken.
  try { await drift.promoClean() } catch {}
  await sleep(400)
  // The rolling snapshotter may have thumbnailed pages BEFORE the cleanup —
  // drop those so every card gets a fresh, banner-free capture.
  for (const x of all) x.snapshot = null
  // Every card needs a thumbnail before the zoom-out — capturePage drops
  // frames while the window is occluded or a page is mid-paint, so retry
  // until each one lands.
  const s0 = Date.now()
  while (Date.now() - s0 < 25000) {
    for (const x of all) if (!x.snapshot) await takeSnapshot(x, true)
    if (all.every(x => x.snapshot)) break
    await sleep(500)
  }

  // Wait for the photo backdrop so the shot has the full look.
  const b0 = Date.now()
  while (Date.now() - b0 < 8000 && !document.body.classList.contains('bgready')) await sleep(200)

  // Frame the constellation below the live threshold so thumbnails render.
  const bb = contentBBox()
  const s = Math.min(0.36, (viewW() - 220) / bb.w)
  animateView({
    s,
    ox: viewW() / 2 - (bb.x + bb.w / 2) * s,
    oy: TOOLBAR + (innerHeight - TOOLBAR) / 2 - (bb.y + bb.h / 2) * s
  }, 250)
  // The glide is rAF-driven — verify it actually landed (an occluded window
  // suspends rAF and would freeze the shot at the load zoom).
  const g0 = Date.now()
  while (Date.now() - g0 < 10000 && (Math.abs(V.s - s) > 0.001 || viewFreeze)) await sleep(200)
  await sleep(1200)
  toastEl.classList.remove('show')
  await sleep(400)
  await drift.selftestDone({
    errors: [],
    promo: true,
    landed: Math.abs(V.s - s) <= 0.001,
    snapshots: all.filter(x => !!x.snapshot).length,
    cards: all.map(x => ({ url: x.url, loaded: x.everLoaded }))
  })
}

// ---------- boot ----------

// The extension icon row talks to the extension system over IPC as soon as it
// connects, so only mount it in a normal (non-headless) run where that system
// exists — and only if the custom element got defined by the preload.
function mountExtActions() {
  if (HEADLESS) return
  if (!('customElements' in window) || !customElements.get('browser-action-list')) return
  const el = document.createElement('browser-action-list')
  el.id = 'extactions'
  el.setAttribute('partition', 'persist:drift')
  el.setAttribute('alignment', 'bottom right')
  $('#extslot').replaceWith(el)
}

// ---------- per-card extension actions ----------
// Each live card gets its own <browser-action-list> pinned to its tab id, so
// extension icons/badges reflect THAT page and a click opens the extension on
// that specific card (the popup anchors next to the icon). This is what makes
// an extension usable in one tab rather than only via the global toolbar row.

let extReady = false

function mountCardExtActions(c) {
  if (HEADLESS || !extReady || !c.viewCreated || !c.el) return
  if (!('customElements' in window) || !customElements.get('browser-action-list')) return
  drift.extTabId(c.id).then(tabId => {
    // The view may have been pruned (or replaced) while we awaited the id.
    if (tabId == null || !c.viewCreated || !c.el || !cards.has(c.id)) return
    if (c.extEl && c.extEl.getAttribute('tab') === String(tabId)) return
    unmountCardExtActions(c)
    const el = document.createElement('browser-action-list')
    el.className = 'cardext'
    el.setAttribute('partition', 'persist:drift')
    el.setAttribute('tab', String(tabId))
    // Clicking an icon acts on this card — make it active, but never start a
    // header drag (the shadow-DOM buttons don't match the .head button guard).
    el.addEventListener('mousedown', e => {
      e.stopPropagation()
      setActive(c.id)
      drift.raise(c.id)
    })
    el.addEventListener('dblclick', e => e.stopPropagation())
    const head = c.el.querySelector('.head')
    head.insertBefore(el, head.querySelector('.b-reload'))
    c.extEl = el
  }).catch(() => {})
}

function unmountCardExtActions(c) {
  if (c.extEl) { c.extEl.remove(); c.extEl = null }
}

async function init() {
  wireGlobalInput()
  mountExtActions()
  // The extension system may have come up before this renderer did (the
  // ext:ready broadcast would then be missed) — ask once at boot too.
  if (!HEADLESS) {
    drift.extIsReady().then(r => {
      if (r && !extReady) {
        extReady = true
        for (const c of cards.values()) mountCardExtActions(c)
      }
    }).catch(() => {})
  }
  if (!HEADLESS) {
    try {
      const s = await drift.settingsLoad()
      if (s && typeof s === 'object') settings = { bg: { mode: 'photos' }, ...s }
    } catch {}
  }
  applyBackground()
  if (!HEADLESS) {
    const st = await drift.loadState()
    // Zones count as content too — a canvas of empty zones must survive a relaunch.
    const hasContent = st && ((Array.isArray(st.cards) && st.cards.length) ||
                              (Array.isArray(st.zones) && st.zones.length))
    // A corrupt state file must never brick boot to a blank void — fall back
    // to a fresh canvas and keep the broken file out of the way for recovery.
    if (hasContent) {
      try { restore(st) } catch (e) {
        cards.clear(); zones.clear(); edges.length = 0
        cardsEl.innerHTML = ''; zonesEl.innerHTML = ''; edgeG.innerHTML = ''
        firstRun()
        toast('Your saved canvas could not be read — started a fresh one')
      }
    } else firstRun()
    // First time in Drift (even with an inherited canvas): run the walkthrough.
    let tourDone = false
    try { tourDone = !!localStorage.getItem('drift-tour-done') } catch {}
    if (!tourDone) setTimeout(startTour, 700)
    try {
      const b = await drift.bookmarksLoad()
      if (Array.isArray(b)) {
        // v1: a flat array of bookmarks, no folders.
        bookmarks = b.filter(x => x && typeof x.url === 'string')
        bmFolders = []
      } else if (b && typeof b === 'object') {
        bookmarks = (Array.isArray(b.items) ? b.items : []).filter(x => x && typeof x.url === 'string')
        bmFolders = (Array.isArray(b.folders) ? b.folders : []).filter(f => typeof f === 'string')
      }
    } catch {}
    try { await vaultLoadState() } catch {}
  }
  refreshBookmarkUI()
  updateEmpty()
  scheduleLayout()

  // Refresh thumbnails one card at a time — capturing every live page in one
  // tick causes a visible hitch while browsing. Cards mid-playback are left
  // alone: capturePage steals frames from the (software-decoded) video.
  let snapRR = 0
  setInterval(() => {
    // Muted autoplay loops can hold mediaPlaying forever — refresh even those
    // once the thumbnail is 5+ minutes stale (one brief capture, not per-8s).
    const live = [...cards.values()].filter(c =>
      c.live && (!c.mediaPlaying || Date.now() - c.lastSnap > 300000))
    if (live.length) takeSnapshot(live[snapRR++ % live.length])
  }, 8000)

  // Serializing the canvas (with every thumbnail) is multi-MB work on this
  // thread — run it when the frame has idle headroom, never mid-gesture.
  // Thumbnail-only changes (snapDirty) persist on blur or once a minute.
  let lastSave = 0
  const saveNow = () => {
    dirty = false
    snapDirty = false
    lastSave = Date.now()
    drift.saveState(serialize())
  }
  setInterval(() => {
    if (HEADLESS) return
    if (dirty || (snapDirty && Date.now() - lastSave > 60000)) {
      requestIdleCallback(() => { if (dirty || snapDirty) saveNow() }, { timeout: 2000 })
    }
  }, 2500)
  // Renderer blur usually means "clicked into a page card" (focus handed to
  // its webContents), not "app deactivated" — don't pay the full serialize
  // inside that click. Real changes still flush; thumbnail-only changes keep
  // the tick's 60s cadence.
  window.addEventListener('blur', () => {
    if (HEADLESS) return
    if (dirty) saveNow()
    else if (snapDirty && Date.now() - lastSave > 60000) saveNow()
  })
  // Best-effort flush at teardown (quit/close): blur isn't guaranteed first.
  window.addEventListener('pagehide', () => {
    if (!HEADLESS && (dirty || snapDirty)) saveNow()
  })

  if (SELF) runSelftest()
  if (PROMO) runPromoshot()
}

init()
