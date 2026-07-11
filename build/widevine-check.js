// Verify the Widevine CDM is present and usable in this Electron build.
const { app, BrowserWindow } = require('electron')
let components = null
try { components = require('electron').components } catch {}
app.commandLine.appendSwitch('lang', 'en-US')

app.whenReady().then(async () => {
  const out = { electron: process.versions.electron, chrome: process.versions.chrome, hasComponentsApi: !!components }
  if (components) {
    try {
      await Promise.race([
        components.whenReady(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('whenReady timeout (CDM download likely firewalled)')), 25000))
      ])
      out.componentsStatus = components.status ? components.status() : 'ready'
    } catch (e) { out.componentsError = e.message }
  }
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  await win.loadURL('https://example.com/')
  const script = `(async () => {
    try {
      const cfg = [{
        initDataTypes: ['cenc'],
        videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"', robustness: 'SW_SECURE_DECODE' }],
        audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }]
      }];
      const access = await navigator.requestMediaKeySystemAccess('com.widevine.alpha', cfg);
      const mk = await access.createMediaKeys();
      return { widevine: true, keySystem: access.keySystem, mediaKeys: !!mk };
    } catch (e) { return { widevine: false, error: String(e && e.name) + ': ' + String(e && e.message) }; }
  })()`
  try { out.mediaKeySystem = await win.webContents.executeJavaScript(script, true) } catch (e) { out.evalError = e.message }
  console.log('WIDEVINE_CHECK ' + JSON.stringify(out, null, 2))
  app.exit(0)
})
setTimeout(() => { console.log('WIDEVINE_CHECK_HARDTIMEOUT'); app.exit(2) }, 45000)
