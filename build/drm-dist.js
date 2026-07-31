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

// Signing identity: the Team ID is a substring of the certificate's common name
// ("Developer ID Application: … (R47T8JJHYX)"), so codesign resolves it without
// the legal name having to live in this public repo. Keep in sync with
// package.json build.mac.identity.
const IDENTITY = 'R47T8JJHYX'

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

// The .app inside is already notarized + stapled by the afterSign hook, but the
// DMG is the file people actually download, so it needs its own ticket or macOS
// warns when they open it. Apple's notary service accepts a .dmg directly.
function notarizeDmg(dmg) {
  if (process.env.DRIFT_SKIP_NOTARIZE === '1') {
    console.log(`[drm-dist] DRIFT_SKIP_NOTARIZE=1 — leaving ${dmg} un-notarized`)
    return
  }
  // The .app inside is signed, but electron-builder leaves the disk image itself
  // unsigned, and Gatekeeper assesses the DMG the user downloads ("no usable
  // signature" otherwise). Sign it before submitting — order is sign → notarize
  // → staple, since signing changes the hash the ticket is issued against.
  console.log(`[drm-dist] signing ${dmg} …`)
  execFileSync('codesign', ['--force', '--sign', IDENTITY, '--timestamp', dmg], { stdio: 'inherit' })

  console.log(`[drm-dist] notarizing ${dmg} (a few minutes) …`)
  const out = execFileSync('xcrun', [
    'notarytool', 'submit', dmg, '--keychain-profile', 'drift-notary', '--wait'
  ], { stdio: 'pipe' }).toString()
  console.log(out.trim().split('\n').map(l => '    ' + l).join('\n'))
  if (!/status:\s*Accepted/i.test(out)) {
    const id = (out.match(/id:\s*([0-9a-f-]{36})/i) || [])[1]
    if (id) {
      try {
        console.error(execFileSync('xcrun', ['notarytool', 'log', id, '--keychain-profile', 'drift-notary'], { stdio: 'pipe' }).toString())
      } catch { /* best effort */ }
    }
    throw new Error(`notarization failed for ${dmg}`)
  }
  execFileSync('xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' })
  execFileSync('xcrun', ['stapler', 'validate', dmg], { stdio: 'inherit' })
  // The real proof: what Gatekeeper will say on a user's Mac. spctl writes its
  // verdict to stderr and exits non-zero if it would reject, so inherit + throw.
  execFileSync('spctl', ['-a', '-vvv', '-t', 'install', dmg], { stdio: 'inherit' })
}

// Auto-update manifest. Each arch is a separate electron-builder run, and every
// run writes its own dist/latest-mac.yml — so the second would clobber the
// first and half the users would be offered the wrong architecture. Keep each
// arch's copy, then merge them into one manifest listing both zips.
// electron-updater picks the right one by looking for "arm64" in the filename.
function stashManifest(arch) {
  const src = path.join('dist', 'latest-mac.yml')
  if (!fs.existsSync(src)) throw new Error(`electron-builder produced no latest-mac.yml for ${arch} — auto-update would break`)
  fs.copyFileSync(src, path.join('dist', `latest-mac-${arch}.yml`))
}

function mergeManifests() {
  const yaml = require('js-yaml')
  const docs = ARCHES.map(a => yaml.load(fs.readFileSync(path.join('dist', `latest-mac-${a}.yml`), 'utf8')))
  const merged = { ...docs[0] }
  // Only .zip entries: Squirrel.Mac updates from a zip, and leaving the .dmg in
  // the list risks the updater picking a file it cannot install.
  merged.files = docs.flatMap(d => (d.files || []).filter(f => String(f.url).endsWith('.zip')))
  if (!merged.files.length) throw new Error('merged latest-mac.yml has no zip entries — auto-update would break')
  const arm = merged.files.find(f => String(f.url).includes('arm64'))
  const intel = merged.files.find(f => !String(f.url).includes('arm64'))
  if (!arm || !intel) throw new Error('merged latest-mac.yml is missing an architecture — auto-update would break')
  merged.path = arm.url
  merged.sha512 = arm.sha512
  fs.writeFileSync(path.join('dist', 'latest-mac.yml'), yaml.dump(merged))
  for (const a of ARCHES) fs.rmSync(path.join('dist', `latest-mac-${a}.yml`), { force: true })
  console.log(`[drm-dist] merged update manifest → ${merged.files.map(f => f.url).join(', ')}`)
}

for (const arch of ARCHES) {
  const dist = ensureDist(arch)
  console.log(`[drm-dist] building ${arch} DMG + zip (electronDist=${dist}) …`)
  // --publish never: the manifest is generated locally, assets are uploaded by
  // `gh release create` so the release notes stay hand-written.
  execFileSync('npx', ['electron-builder', '--mac', 'dmg', 'zip', `--${arch}`,
    `-c.electronDist=${dist}`, '--publish', 'never'], { stdio: 'inherit' })
  notarizeDmg(path.join('dist', `Drift-mac-${arch}.dmg`))
  stashManifest(arch)
}
mergeManifests()

// Auto-update is only real if the update artifacts actually reach the release.
// A release with just the DMGs leaves every installed copy checking a manifest
// that 404s, silently, forever — so print the exact command with every required
// asset rather than trusting memory at ship time.
const version = require('../package.json').version
const assets = [
  'dist/Drift-mac-arm64.dmg', 'dist/Drift-mac-x64.dmg',
  'dist/Drift-mac-arm64.zip', 'dist/Drift-mac-x64.zip',
  'dist/latest-mac.yml'
]
const missing = assets.filter(a => !fs.existsSync(a))
if (missing.length) throw new Error('missing release artifacts: ' + missing.join(', '))
console.log('[drm-dist] done → both DMGs (signed, notarized, stapled) + both zips + latest-mac.yml')
console.log('\n[drm-dist] RELEASE WITH ALL OF THESE (latest-mac.yml + zips are what make auto-update work):\n')
console.log(`  gh release create v${version} --repo BradB808/Drift-Browser-download-page \\\n    --title "…" --notes "…" \\\n    ${assets.join(' ')}\n`)
