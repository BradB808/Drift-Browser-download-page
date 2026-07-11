// Widevine VMP signing (macOS) via castlabs EVS.
//
// Production DRM services (Netflix, Disney+) only accept the Widevine CDM if the
// packaged app is VMP-signed. This runs as part of the afterPack hook, BEFORE the
// ad-hoc codesign (mandatory ordering on macOS).
//
// It is a no-op unless the app is built on the castlabs "+wvcus" Electron AND the
// castlabs EVS tools are installed with an account configured — a one-time setup
// only the owner can do (an AI must not create the account):
//   npm install "github:castlabs/electron-releases#v37.10.3+wvcus" --save-dev
//   pip3 install --user castlabs-evs
//   python3 -m castlabs_evs.account signup      # then `account reauth` when the token expires
// See DRM-SETUP.md.

const { execFileSync } = require('child_process')
const path = require('path')

function electronIsWidevine() {
  try { return /wvcus/.test(require('electron/package.json').version) } catch { return false }
}

exports.default = async function vmpSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (!electronIsWidevine()) return // stock Electron: nothing to VMP-sign

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)
  const run = (args) => execFileSync('python3', args, { stdio: 'pipe' }).toString()

  try {
    run(['-m', 'castlabs_evs.vmp', '--version'])
  } catch {
    console.warn('\n[drift] castlabs-evs not installed — SKIPPING Widevine VMP signing.')
    console.warn('[drift] Netflix/Disney+ will NOT play in this build. To enable, see DRM-SETUP.md:')
    console.warn('[drift]   pip3 install --user castlabs-evs && python3 -m castlabs_evs.account signup\n')
    return
  }

  try {
    console.log(`  • VMP-signing ${appPath} …`)
    const out = run(['-m', 'castlabs_evs.vmp', 'sign-pkg', appPath])
    console.log('  • Widevine VMP sign OK: ' + out.trim().split('\n').slice(-1)[0])
  } catch (err) {
    const msg = (err.stderr && err.stderr.toString()) || err.message
    console.warn('\n[drift] Widevine VMP signing FAILED — this build will not play production DRM.')
    console.warn('[drift] ' + String(msg).trim())
    console.warn('[drift] If your EVS token expired: python3 -m castlabs_evs.account reauth\n')
    // Don't throw — let the build finish so the app still works for non-DRM sites.
  }
}
