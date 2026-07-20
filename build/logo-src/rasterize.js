// Rasterize icon.svg to crisp PNGs at multiple sizes using Electron's Chromium
// (draws the vector onto a canvas and reads the PNG — pixel-perfect, transparent).
// Run: ./node_modules/.bin/electron build/logo-src/rasterize.js
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, 'icon.svg')
const OUT = path.join(__dirname, 'png')
const SIZES = [16, 32, 48, 64, 128, 180, 256, 512, 1024]

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const svg = fs.readFileSync(SRC, 'utf8')
  const win = new BrowserWindow({ show: false, width: 1200, height: 1200, webPreferences: { offscreen: true } })
  const page = `<!doctype html><meta charset="utf8"><body style="margin:0">
    <canvas id="c"></canvas>
    <script>
      const svg = ${JSON.stringify(svg)};
      let img = null;
      window.__load = () => new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => { img = i; res(true); };
        i.onerror = (e) => rej('img load failed');
        i.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      });
      window.__render = (size) => {
        const c = document.getElementById('c'); c.width = size; c.height = size;
        const ctx = c.getContext('2d'); ctx.clearRect(0,0,size,size);
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, size, size);
        return c.toDataURL('image/png');
      };
    </script></body>`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page))
  const loaded = await win.webContents.executeJavaScript('window.__load()')
  if (!loaded) { console.log('SVG failed to load'); app.exit(1); return }
  for (const s of SIZES) {
    const dataUrl = await win.webContents.executeJavaScript(`window.__render(${s})`)
    const b64 = dataUrl.split(',')[1]
    fs.writeFileSync(path.join(OUT, `icon_${s}.png`), Buffer.from(b64, 'base64'))
    console.log('wrote icon_' + s + '.png')
  }
  console.log('DONE')
  app.quit()
}).catch(e => { console.log('ERR', e); app.exit(1) })
