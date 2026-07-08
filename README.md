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

## Controls

| Action | How |
| --- | --- |
| New card | `⌘T`, the **＋ New card** button, or double-click empty canvas |
| Pan | two-finger scroll, or drag empty canvas |
| Zoom | pinch (or `⌘` + scroll), `⌘+` / `⌘-` |
| Fit everything | `⌘0` or the **Fit** button |
| Focus a card (full screen) | double-click its header, `⤢`, or click any zoomed-out thumbnail |
| Leave focus | `Esc` |
| Move / resize a card | drag its header / drag the corner grip |
| Edit a card's address | click its title, or `⌘L` |
| Back / forward / reload | `‹ ›` buttons, `⟳` or `⌘R` |
| Close card | `×` or `⌘W` |
| Jump anywhere | click the minimap (bottom-right) |

Links that would open a new tab (`⌘`-click, `target="_blank"`) become child
cards with a trail edge from their parent.

The entire canvas — card positions, trails, thumbnails, and where you were
looking — is saved automatically and restored on next launch.

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

- Named regions/zones on the canvas ("Trip planning", "Job hunt") and multiple
  canvases as workspaces
- Trail labels + shareable trails (export a subgraph as a link list)
- History search that highlights matching cards on the map
- Session "time machine": scrub the canvas back through time
- Split-focus: pin two cards side-by-side in focus mode
