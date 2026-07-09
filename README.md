# ◍ Drift — a spatial web browser

Drift throws out the tab bar entirely. Pages are **cards on an infinite, zoomable
canvas**. Zoom out and your whole session becomes a constellation of page
thumbnails; zoom in and the cards become live, fully interactive Chromium pages.
When a page opens a link in a "new tab", Drift instead spawns a **child card next
to the page you came from and draws a trail line between them** — your browsing
history stops being a hidden list and becomes a visible map you can rearrange.

The idea is a direct descendant of Vannevar Bush's 1945 *memex* — a machine that
stores knowledge as **trails** of linked documents. First launch opens that very
trail as a demo.

## Run it

```bash
npm install
npm start
```

Requires macOS/Windows/Linux with Node 18+. Built on Electron, so every card is
a real Chromium page — logins, video, web apps all work.

## What's in v0.2

- **Zones** — named, colored regions on the canvas ("Trip planning", "Job
  hunt"). Drag a zone by its label and every card inside travels with it.
  Zones **auto-grow** around any card that outgrows them, and the color dot
  opens a full color wheel (hex supported).
- **Bookmarks** — hit **☆** on any card (or right-click → bookmark). Browse
  them from the `★` toolbar button, or in the `⌘T` palette: open it empty to
  see them, or type to search bookmarks and open cards together.
- **Canvas search** — `⌘F` (or just type in the `⌘T` palette): matching cards
  light up on the canvas and minimap; `↑↓ ↵` dives into one.
- **Split focus** — pin two pages side-by-side: shift-double-click a card's
  header (or shift-click `⤢`, or right-click) to pair it with the previous
  card. The second card glides home when you press `Esc`.
- **Trails as Markdown** — right-click a card → *Copy trail as Markdown*
  exports its whole connected trail as a nested link list.
- **Tidy** — `⇧⌘T` auto-arranges every trail into a clean left-to-right tree.
- **A fresh view every launch** — the canvas floats over a new full-bleed
  photo each time you open Drift (with an aurora gradient when offline), under
  a warm glass UI: frosted panels, floating toolbar, peach/coral accents.
- **Guided walkthrough** — first launch opens a spotlight tour of the whole
  idea (cards, trails, zones, search, bookmarks). Replay it anytime with
  the **?** button or *View → Show Walkthrough*.

## Controls

| Action | How |
| --- | --- |
| New card | `⌘T`, the **＋ New card** button, or double-click empty canvas (searches Google) |
| Search your canvas | `⌘F`, then type — `↑↓ ↵` to jump to a match or open a bookmark |
| Bookmark a page | `☆` in the card header, or right-click → bookmark |
| Browse bookmarks | the `★` toolbar button (click to open, `×` to remove), or open `⌘T` empty |
| New zone | `⇧⌘N` or the **▢ Zone** button; click its name to rename, dot to recolor |
| Tidy canvas | `⇧⌘T` or the **Tidy** button |
| Pan | two-finger scroll, or drag empty canvas |
| Zoom | pinch (or `⌘` + scroll), `⌘+` / `⌘-`, or the `＋`/`−` toolbar buttons |
| Connect a trail yourself | drag the `○` on a card's right edge onto another card, or right-click → connect |
| Remove a trail | double-click the trail line, or right-click a card → remove trail |
| Fit everything | `⌘0` or the **Fit** button |
| Focus a card | double-click its header, `⤢`, or click any zoomed-out thumbnail |
| True full screen | `⛶` on the card header — the page takes over the window; `esc` or the toolbar pill exits |
| Split focus (two cards) | shift-double-click the second card's header, or right-click → split |
| Leave focus / split | `Esc` |
| Move / resize a card | drag its header / drag the corner grip |
| Edit a card's address | click its title, or `⌘L` |
| Back / forward / reload | `‹ ›` buttons, `⟳` or `⌘R` |
| Card actions (copy address, copy trail, close) | right-click the card |
| Reopen a closed card | right-click a card or empty canvas → *Reopen closed card* (or File menu) |
| Quick actions on empty canvas | right-click → new card here, reopen, new zone |
| Close card | `×` or `⌘W` |
| Jump anywhere | click the minimap (bottom-right) |

Links that would open a new tab (`⌘`-click, `target="_blank"`) become child
cards with a trail edge from their parent.

The entire canvas — card positions, trails, zones, thumbnails, and where you
were looking — is saved automatically **on your machine only** and restored on
next launch. Drift keeps no browsing log beyond that saved canvas and your
bookmarks.

## How it works

- `main.js` — Electron main process. One `WebContentsView` (real Chromium page)
  per live card; the canvas UI streams desired screen rectangles + zoom factor
  each frame and main positions the native views. Pages run sandboxed in a
  persistent session partition, only `http(s)` navigation is allowed, and
  new-window requests are converted into child-card spawn events.
- `renderer/app.js` — the canvas. Pan/zoom transform, card drag/resize, trail
  edges (SVG), minimap, command palette, focus mode, persistence. A *liveness
  engine* decides which cards get a real Chromium view (visible + zoom ≥ 0.42,
  max 10 at once); everything else shows a captured thumbnail. Background views
  are kept warm like background tabs, with LRU eviction beyond 12.
- Selftest: `npm run selftest` boots the app, loads three pages, verifies they
  load, and writes screenshots + a JSON report (used for CI-style verification).

## Roadmap ideas

- Multiple canvases as workspaces (zones that fold into portals)
- Trail labels and annotations on edges
- Shareable trails as a hosted link (not just Markdown)
- Web page text search across every card on the canvas
- Drag a selection box to make a zone from existing cards
