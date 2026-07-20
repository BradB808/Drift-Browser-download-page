// Rasterize the BARE mark (transparent) -> renderer/logo.png for the toolbar.
const { app, BrowserWindow } = require('electron')
const fs = require('fs'); const path = require('path')
const SRC = path.join(__dirname, 'mark.svg')
const DEST = path.join(__dirname, '..', '..', 'renderer', 'logo.png')
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const svg = fs.readFileSync(SRC, 'utf8')
  const win = new BrowserWindow({ show: false, width: 400, height: 400, webPreferences: { offscreen: true } })
  const page = `<!doctype html><meta charset="utf8"><body style="margin:0"><canvas id="c"></canvas><script>
    const svg=${JSON.stringify(svg)}; let img=null;
    window.__load=()=>new Promise((res,rej)=>{const i=new Image();i.onload=()=>{img=i;res(true)};i.onerror=()=>rej('fail');i.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg)});
    window.__render=(s)=>{const c=document.getElementById('c');c.width=s;c.height=s;const x=c.getContext('2d');x.clearRect(0,0,s,s);x.imageSmoothingQuality='high';x.drawImage(img,0,0,s,s);return c.toDataURL('image/png')};
  </script></body>`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page))
  await win.webContents.executeJavaScript('window.__load()')
  const dataUrl = await win.webContents.executeJavaScript('window.__render(256)')
  fs.writeFileSync(DEST, Buffer.from(dataUrl.split(',')[1], 'base64'))
  console.log('wrote renderer/logo.png (256, bare mark)')
  app.quit()
}).catch(e => { console.log('ERR', e); app.exit(1) })
