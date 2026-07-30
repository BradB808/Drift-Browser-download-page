// electron-builder afterSign hook: send the signed .app to Apple for
// notarization, then staple the ticket onto it.
//
// Runs AFTER electron-builder codesigns with the Developer ID certificate and
// BEFORE the DMG is assembled, so the app inside the DMG carries its own
// stapled ticket and validates even with no network.
//
// Credentials come from the "drift-notary" keychain profile created once with:
//   xcrun notarytool store-credentials "drift-notary" --key <AuthKey.p8> \
//     --key-id <KEY_ID> --issuer <ISSUER_UUID>
// Nothing secret is ever stored in this repo or passed on the command line.
//
// Set DRIFT_SKIP_NOTARIZE=1 for a fast local build (produces a signed but
// NOT notarized app — fine for local testing, never for a release).

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const PROFILE = 'drift-notary'

exports.default = async function notarize(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (process.env.DRIFT_SKIP_NOTARIZE === '1') {
    console.log('  • DRIFT_SKIP_NOTARIZE=1 — skipping notarization (build is signed but NOT notarized)')
    return
  }

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  if (!fs.existsSync(appPath)) throw new Error(`notarize: no app at ${appPath}`)

  // notarytool takes a .zip/.dmg/.pkg, never a raw .app directory. ditto with
  // --keepParent preserves the bundle structure and its symlinks.
  const zipPath = path.join(os.tmpdir(), `drift-notarize-${process.pid}-${path.basename(context.appOutDir)}.zip`)
  console.log(`  • zipping for notarization …`)
  execFileSync('ditto', ['-c', '-k', '--keepParent', appPath, zipPath], { stdio: 'inherit' })

  try {
    console.log(`  • submitting to Apple for notarization (this usually takes a few minutes) …`)
    const out = execFileSync('xcrun', [
      'notarytool', 'submit', zipPath,
      '--keychain-profile', PROFILE,
      '--wait'
    ], { stdio: 'pipe' }).toString()
    console.log(out.trim().split('\n').map(l => '    ' + l).join('\n'))
    if (!/status:\s*Accepted/i.test(out)) {
      // Surface Apple's own reasons instead of a bare failure.
      const id = (out.match(/id:\s*([0-9a-f-]{36})/i) || [])[1]
      if (id) {
        try {
          const log = execFileSync('xcrun', ['notarytool', 'log', id, '--keychain-profile', PROFILE], { stdio: 'pipe' }).toString()
          console.error(log)
        } catch { /* the log fetch is best-effort */ }
      }
      throw new Error('notarization was not Accepted — see the log above')
    }
    console.log(`  • stapling ticket …`)
    execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' })
    execFileSync('xcrun', ['stapler', 'validate', appPath], { stdio: 'inherit' })
    console.log(`  • notarized + stapled ${path.basename(appPath)}`)
  } finally {
    fs.rmSync(zipPath, { force: true })
  }
}
