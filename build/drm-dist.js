// Build DRM-capable DMGs for BOTH macOS architectures.
//
// The castlabs Widevine Electron only installs for the host arch, so we fetch each
// arch's dist from the castlabs GitHub release, package it with electron-builder
// (electronDist points at the matching dist), and build/vmp-sign.js (afterPack)
// VMP-signs each packaged app. Result: dist/Drift-mac-arm64.dmg + dist/Drift-mac-x64.dmg,
// both loading Widevine out of the box.
//
// Requires a castlabs EVS account for the signing step (see DRM-SETUP.md).
// Run: npm run drm:dist   (or: node build/drm-dist.js)

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const TAG = 'v37.10.3+wvcus'
const VERSION = '37.10.3+wvcus'
const ARCHES = ['arm64', 'x64']
const CACHE = '.drm-cache'

function ensureDist(arch) {
  const dir = path.join(CACHE, arch)
  const app = path.join(dir, 'Electron.app')
  if (!fs.existsSync(app)) {
    fs.mkdirSync(dir, { recursive: true })
    const url = `https://github.com/castlabs/electron-releases/releases/download/${encodeURIComponent(TAG)}` +
                `/electron-v${encodeURIComponent(VERSION)}-darwin-${arch}.zip`
    const zip = path.join(CACHE, `${arch}.zip`)
    console.log(`[drm-dist] downloading ${arch} Widevine dist …`)
    execFileSync('curl', ['-fSL', url, '-o', zip], { stdio: 'inherit' })
    // ditto preserves the .framework symlinks that other zip extractors drop.
    console.log(`[drm-dist] extracting ${arch} …`)
    execFileSync('ditto', ['-x', '-k', zip, dir], { stdio: 'inherit' })
  }
  execFileSync('node', ['build/repair-frameworks.js', app], { stdio: 'inherit' }) // safety net
  return dir
}

for (const arch of ARCHES) {
  const dist = ensureDist(arch)
  console.log(`[drm-dist] building ${arch} DMG (electronDist=${dist}) …`)
  execFileSync('npx', ['electron-builder', '--mac', 'dmg', `--${arch}`, `-c.electronDist=${dist}`],
    { stdio: 'inherit' })
}
console.log('[drm-dist] done → dist/Drift-mac-arm64.dmg + dist/Drift-mac-x64.dmg')
