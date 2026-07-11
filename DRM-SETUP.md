# DRM streaming (Netflix, Disney+, etc.)

Stock Electron ships **without** the Widevine Content Decryption Module (CDM), so
protected video silently fails to play. Drift now runs on the castlabs "Electron for
Content Security" build, loads the Widevine CDM at startup (`main.js` →
`components.whenReady()`), and VMP-signs packaged builds so production services accept it.

**Status: enabled and verified.** The Widevine CDM (v4.10.3050.0) loads, a
`com.widevine.alpha` MediaKeys can be created, and the packaged app carries a valid
production **streaming** VMP signature (`npm run drm:verify` and
`python3 -m castlabs_evs.vmp verify-pkg dist/mac-arm64` confirm it). The Apple Silicon
DMG (`dist/Drift-mac-arm64.dmg`) plays Netflix/Disney+.

## How it's wired
- `devDependencies.electron` → `github:castlabs/electron-releases#v37.10.3+wvcus`
  (exact match for Electron 37.10.3 / Chromium 138).
- `main.js` awaits `components.whenReady()` before opening a window (no-op on stock
  Electron, so the code is safe either way).
- `build/vmp-sign.js` runs in the `afterPack` hook **before** the ad-hoc codesign and
  VMP-signs the packaged app (no-op unless it's a `+wvcus` build with EVS configured).
- `build/repair-frameworks.js` recreates the macOS framework symlinks that the castlabs
  zip drops on extraction (otherwise the app crashes at launch with a dyld error).

## npm scripts
| script | what it does |
|---|---|
| `npm run drm:enable`   | install the castlabs Widevine Electron build + repair framework symlinks |
| `npm run drm:fix`      | re-run the symlink repair (after any `npm install`) |
| `npm run drm:sign-dev` | VMP-sign the local Electron so `npm start` streams |
| `npm run drm:dist`     | build the signed, DRM-capable Apple Silicon DMG |
| `npm run drm:verify`   | confirm the CDM loads and a Widevine MediaKeys can be created |

## Rebuilding from scratch (e.g. after `npm install`)
```
npm run drm:enable      # if electron was reinstalled as stock
npm run drm:sign-dev    # needs your castlabs EVS account (below)
npm run drm:dist        # -> dist/Drift-mac-arm64.dmg
```

## The castlabs EVS account
VMP signing requires a free castlabs account (already set up for this repo). If the
signing token ever expires you'll see it in a build/sign warning — refresh with:
```
python3 -m castlabs_evs.account reauth
```
To set it up on a fresh machine: `pip3 install --user castlabs-evs` then
`python3 -m castlabs_evs.account signup`.

## Known limitations / follow-ups
- **Apple Silicon (arm64) only, for now.** `drm:dist` builds arm64 because it packages
  the locally-installed Widevine Electron (which is one architecture). An Intel (x64)
  DRM DMG needs the x64 castlabs build installed and a separate `--x64` build; the
  previous stock x64 DMG was removed rather than shipped as a broken/no-DRM artifact.
- **Resolution is capped ~720p** — the software Widevine CDM (L3), same as desktop Chrome;
  1080p/4K are reserved for hardware DRM.
- **Disney+ may need a Chrome user agent** (else "error code 83"). Drift already strips
  "Electron" from its UA; if a service still refuses, apply a per-domain Chrome UA
  (overriding it globally can break Netflix).
- The Widevine CDM downloads from Google on first launch (needs network); it can't
  legally be bundled.
