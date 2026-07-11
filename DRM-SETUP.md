# Enabling DRM streaming (Netflix, Disney+, etc.)

Stock Electron ships **without** the Widevine Content Decryption Module (CDM), so
protected video (Netflix, Disney+, Max, Amazon, Spotify) silently fails to play.
Drift's code is already wired for Widevine — it just needs the castlabs "Electron
for Content Security" (ECS) build plus a one-time signing step that only you can do
(it requires a free castlabs account; an AI must not create accounts on your behalf).

The relevant code (`main.js`) awaits `components.whenReady()` before opening a window,
which is a no-op on stock Electron and loads the CDM on the castlabs build.

## One-time setup

### 1. Swap Electron for the castlabs Widevine build
```
npm run drm:enable
```
This installs `github:castlabs/electron-releases#v37.10.3+wvcus` (exact match for
Drift's Electron 37.10.3, Chromium 138 — verified to boot and expose the `components`
API). To go back to stock: `npm install electron@^37.0.0 --save-dev`.

> Note: keep Electron on the **37.x** series. Extensions (the per-tab Claude side
> panel, ad blockers) rely on MV3 service-worker support that regresses on Electron
> 40+, so don't bump the Electron major just to chase a newer castlabs tag.

### 2. Create a free castlabs EVS account and install the signing tool
```
pip3 install --user castlabs-evs
python3 -m castlabs_evs.account signup      # <-- you must do this; it needs a real login
```
(Use `python3 -m castlabs_evs.account reauth` later if the token expires.)

### 3a. Play DRM while developing (`npm start`)
The dev binary must be VMP-signed once per install:
```
npm run drm:sign-dev
```
Re-run this after any `npm install` that reinstalls Electron. Then `npm start` and
Netflix/Disney+ should play.

### 3b. Play DRM in packaged builds (`npm run dist`)
Nothing extra to do — `build/vmp-sign.js` runs automatically in the `afterPack` hook
(before the ad-hoc codesign, which is the required order on macOS). It's a no-op
unless (a) Electron is the `+wvcus` build and (b) `castlabs-evs` is installed with an
account configured; otherwise it prints a warning and the build still finishes (just
without production DRM).

## What to expect (be realistic)
- **Resolution is capped ~720p.** The software Widevine CDM (L3) is what Chrome uses;
  Netflix/Disney+ reserve 1080p/4K for hardware DRM paths.
- **Disney+ may need a Chrome user agent.** If it errors with "code 83", set a real
  Chrome UA for that card. Drift already strips "Electron" from its UA, which is
  usually enough, but a per-site override may be needed. (Overriding the UA can, in
  turn, break Netflix — apply UA changes per-domain, not globally.)
- **Not guaranteed per-service.** castlabs' maintainer verified Netflix playing in
  properly VMP-signed builds as recently as 2026-03; Disney+ works with the UA caveat.
  Some services fingerprint aggressively — test each one after signing.
- The Widevine CDM downloads from Google on first launch (needs network); it cannot
  legally be bundled.
