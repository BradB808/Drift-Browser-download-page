// electron-builder afterPack hook: ad-hoc sign macOS builds.
// Without ANY signature, Apple Silicon Macs refuse downloaded apps with a
// dead-end "damaged" dialog. An ad-hoc signature downgrades that to the
// standard Gatekeeper "unverified developer" flow with an Open Anyway path.
const { execSync } = require('child_process')
const path = require('path')

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' })
  execSync(`codesign --verify --deep --strict "${appPath}"`, { stdio: 'inherit' })
  console.log(`  • ad-hoc signed ${appPath}`)
}
