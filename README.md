# Kinetix Studio

Native cross-platform desktop video editing studio with an **open local REST API** built for external AI agents.

Electron · React · TypeScript · Tailwind CSS · Express (loopback sidecar) · FFmpeg · librosa

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ Electron Main Process                                              │
│  ├─ ProjectStore (authoritative timeline state, persisted JSON)    │
│  ├─ FfmpegService (fluent-ffmpeg + direct CLI spawns, hw-encode)   │
│  ├─ BeatAnalyzer (Python librosa sidecar → Node energy fallback)   │
│  ├─ RenderService (async jobs, -progress parsing, queue)           │
│  ├─ SequenceBuilder (beats → beat-synced cuts/transitions/overlays)│
│  └─ Express API  http://127.0.0.1:4815  (X-API-Key auth)           │
│        GET  /api/v1/timeline                                       │
│        PUT  /api/v1/timeline                                       │
│        POST /api/v1/audio/extract-and-analyze                      │
│        POST /api/v1/timeline/build-sequence                        │
│        POST /api/v1/render                                         │
│        GET  /api/v1/render/status                                  │
│        POST /api/v1/assets/import                                  │
│        GET  /api/v1/health                    (no auth required)   │
├────────────────────────────────────────────────────────────────────┤
│ Preload bridge (contextBridge → window.kinetix)                    │
├────────────────────────────────────────────────────────────────────┤
│ Renderer (React + Zustand + Tailwind)                              │
│  Asset Library │ Canvas Preview │ Aspect Switcher │ Timeline       │
│  Transport │ Agent Panel │ Settings                                │
└────────────────────────────────────────────────────────────────────┘
```

- **Media playback** uses a custom `kinetix-media://` protocol (no webSecurity loosening).
- **Preview ↔ render parity**: the canvas applies the same smart auto-centering
  scale+pad crop matrix as the FFmpeg render filter for 16:9 / 9:16 / 1:1 / 4:5.
- **Beat analysis**: `src/main/python/beat_analysis.py` (librosa) with a pure-Node
  RMS-onset fallback so the app and CI tests work without Python.

## Development

```bash
npm install
npm run dev          # Vite dev server + Electron with hot renderer
npm run typecheck
npm test             # end-to-end API tests (vitest + supertest + synthesized fixtures)
```

## API usage

The key is generated on first launch and shown in **Settings** (rotate anytime).

```bash
# Current project state
curl http://127.0.0.1:4815/api/v1/timeline -H "X-API-Key: kx_..."

# Extract audio from a reference video and detect beats (ms timestamps)
curl -X POST http://127.0.0.1:4815/api/v1/audio/extract-and-analyze \
  -H "X-API-Key: kx_..." -H "Content-Type: application/json" \
  -d '{"path":"C:/media/ref.mp4"}'

# Auto-arrange raw clips on the beat grid with glitch/flash transitions + text overlays
curl -X POST http://127.0.0.1:4815/api/v1/timeline/build-sequence \
  -H "X-API-Key: kx_..." -H "Content-Type: application/json" \
  -d '{"clips":[{"path":"a.mp4"},{"path":"b.mp4"}],"beats":[0,468,937],"transition":"glitch","grouping":"beat","textEveryNBeats":8,"aspectRatio":"9:16"}'

# Kick off a hardware-accelerated full-res render, then poll status
curl -X POST http://127.0.0.1:4815/api/v1/render -H "X-API-Key: kx_..." -d '{}'
curl http://127.0.0.1:4815/api/v1/render/status -H "X-API-Key: kx_..."
```

The **Agent** side-panel embeds the same controls: paste an API key, trigger
analyze → auto-build → render scripts, call any endpoint directly, and watch
a live activity log.

## FFmpeg bundling

`scripts/stage-ffmpeg.mjs` stages FFmpeg/FFprobe into `vendor/ffmpeg/<platform>/`
(host binaries from `ffmpeg-static`/`ffprobe-static`; linux/darwin static builds
downloaded from public mirrors). electron-builder ships them as `extraResources`,
so end users never install FFmpeg. At runtime the app resolves:
bundled resources → ffmpeg-static → system `PATH`.

Hardware encoders (NVENC / QSV / AMF / VideoToolbox / VAAPI) are auto-detected
with automatic libx264 fallback if the encoder fails to initialize.

## Packaging

| Script | Targets |
|---|---|
| `npm run build:win` | NSIS installer `.exe` + portable `.exe` (x64) |
| `npm run build:mac` | Universal `.dmg` + `.zip` (Apple Silicon + Intel) |
| `npm run build:linux` | `.AppImage` + `.deb` (x64) |

Platform notes:

- **Windows** builds natively on a Windows host (verified: both targets produced
  in `release/`).
- **Linux** builds natively on Linux. On a Windows host, `build:linux`
  automatically routes through **WSL** (`scripts/build-linux.mjs`) because the
  Windows kernel cannot create AppImage symlinks without Developer Mode and has
  no `fpm` for `.deb`. Artifacts are copied back into `./release`.
- **macOS** targets must be built on a macOS host (electron-builder constraint —
  dmg assembly, universal merging, and signing/notarization require macOS).
  `build:mac` runs the full typecheck/compile/stage pipeline on any host and
  completes inside `electron-builder` on macOS. Darwin FFmpeg binaries are
  staged automatically by `stage-ffmpeg.mjs` (x64 builds; arm64 native builds
  are produced when the script runs on Apple Silicon, or x64 runs under Rosetta 2).

## Tests

`npm test` spins up the real Express app with real services and exercises the
full agent workflow against synthesized 120 BPM fixture videos:

1. Auth enforcement (401 without/with wrong key; header + Bearer accepted)
2. `GET /api/v1/timeline` state shape
3. `PUT /api/v1/timeline` full replace + aspect dimensions
4. `POST /api/v1/assets/import` probing
5. `POST /api/v1/audio/extract-and-analyze` → millisecond beat timestamps
6. `POST /api/v1/timeline/build-sequence` → beat-aligned cuts, glitch
   transitions, text overlays, aspect switch
7. `POST /api/v1/render` → full-res 1920×1080 (or project-aspect) MP4 on disk
   with live progress polling to completion
8. Aggregate render status + JSON 404s

## Project layout

```
src/shared/types.ts          Shared domain model (ProjectState, clips, API DTOs)
src/main/main.ts             Electron entry: window, IPC, media protocol
src/main/preload.ts          contextBridge API surface
src/main/paths.ts            Binary/resource resolution (packaged + dev + tests)
src/main/server/api.ts       Express app + API-key middleware + routes
src/main/services/           ffmpeg, analyzer, renderService, sequenceBuilder,
                             projectStore, settings
src/main/python/             librosa beat-analysis sidecar
src/renderer/                React UI (components/, store.ts)
scripts/                     build-main, stage-ffmpeg, build-linux (WSL router)
tests/api.test.ts            End-to-end API suite
```
