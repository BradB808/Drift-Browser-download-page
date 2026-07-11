// Recreate the standard macOS .framework symlinks that the castlabs Electron zip
// loses on extraction (`npm run drm:enable` leaves each <Name>.framework without its
// Versions/Current + top-level symlinks, which makes the app crash at launch with a
// dyld "Library not loaded" / Gatekeeper "damaged" error). Idempotent: run it after
// drm:enable. Deterministic — for each framework, Versions/Current -> A and every entry
// under Versions/A gets a matching top-level symlink.
//
// Usage: node build/repair-frameworks.js [path-to-.app]
const fs = require('fs')
const path = require('path')

const root = process.argv[2] || 'node_modules/electron/dist/Electron.app'
if (!fs.existsSync(root)) { console.error('[repair] not found: ' + root); process.exit(0) }

let fixed = 0
function repairFramework(fwPath) {
  const versions = path.join(fwPath, 'Versions')
  if (!fs.existsSync(path.join(versions, 'A'))) return
  const cur = path.join(versions, 'Current')
  try { if (!fs.existsSync(cur)) { fs.symlinkSync('A', cur); fixed++ } } catch {}
  for (const entry of fs.readdirSync(path.join(versions, 'A'))) {
    const top = path.join(fwPath, entry)
    try {
      if (!fs.lstatSync(top, { throwIfNoEntry: false })) {
        fs.symlinkSync(path.join('Versions', 'Current', entry), top); fixed++
      }
    } catch {
      try { fs.symlinkSync(path.join('Versions', 'Current', entry), top); fixed++ } catch {}
    }
  }
}

function walk(dir) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const p = path.join(dir, e.name)
    if (e.name.endsWith('.framework')) repairFramework(p)
    else walk(p)
  }
}

walk(root)
console.log('[repair] framework symlinks fixed=' + fixed + ' in ' + root)
