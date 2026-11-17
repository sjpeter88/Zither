# Concert Zither

A playable 3D concert (Alpine) zither in Munich tuning: 5 fretted melody strings (a′ a′ d′ g c, 29 frets)
and 37 open strings (12 accompaniment, 12 bass, 13 contrabass) in circle-of-fifths order.

## Folders

| Folder | What it is |
|---|---|
| `web/` | The whole instrument as a static site. Upload this folder as-is to any static https host. No server code, no CDN. |
| `dist/ConcertZither.exe` | Self-contained Windows build (.NET 10 + WebView2), the web app embedded. |
| `shell/` | Source of the Windows shell. |
| `tools/` | Verification and build helpers. |

## Run

- **Windows:** double-click `dist/ConcertZither.exe`. (`--selftest` starts audio, plays a chord, writes
  `%LOCALAPPDATA%\ConcertZither\selftest.json` and exits.)
- **Locally in a browser:** `node tools/serve.mjs` then open http://localhost:8377/ (it needs http(s), not `file://`).
- **iPad:** host `web/` over https, open it in Safari, then Share → Add to Home Screen. After the first
  visit it is cached for offline use. When you change files, bump `VERSION` in `web/sw.js`.

## Rebuild and re-check

```
node tools/verify.mjs          # tuning, stability, CPU headroom of the string engine
node tools/check-songs.mjs     # bar lengths, fret range and chords of every song
pwsh tools/make-icons.ps1      # regenerate icons
dotnet publish shell/ConcertZither.csproj -c Release -o dist
```

## Sound engine (`web/worklet/zither-processor.js`)

One extended Karplus-Strong model per string: delay line with cubic Lagrange fractional read, one-pole
damping filter, four all-pass stages for stiffness, pick-position comb on the excitation. All 42 strings
meet at one bridge modelled as a passive scattering junction, which gives sympathetic resonance that can
exchange energy between strings but never add any. A bank of resonant modes stands in for the soundbox.

## Songs (`web/js/songs.js`)

Melodies are written in a subset of ABC notation with chord symbols; the bass and accompaniment on the
open strings are generated from the chords. Each entry records its source and how accurate it is.
The Third Man theme is deliberately not included (still in copyright).

three.js r170 (MIT licence) is in `web/lib/`.

## This branch

`source` holds everything except the web app itself: the Windows shell and the tools.
The web app is the `main` branch, which GitHub Pages serves. To build from a fresh copy:

```
git clone -b source https://github.com/sjpeter88/Zither.git ConcertZither
cd ConcertZither
git clone -b main https://github.com/sjpeter88/Zither.git web
dotnet publish shell/ConcertZither.csproj -c Release -o dist
```
