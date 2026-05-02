# ScreenMonitor — Architecture

## System Overview

ScreenMonitor is a tray-only Electron app. There is deliberately no `BrowserWindow`. The app lives entirely in the system tray and serves its UI over HTTP so it works on any device (phone, tablet, remote PC) without installing anything.

```
┌──────────────────────────────────────────────────────────────────┐
│  Windows Machine                                                  │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  Electron (main process only)                               │ │
│  │                                                             │ │
│  │  main.js ──► config.js (settings)                          │ │
│  │     │                                                       │ │
│  │     ├──► capture.js ──► desktopCapturer API                │ │
│  │     │       returns PNG buffer                             │ │
│  │     │                                                       │ │
│  │     ├──► server.js ──► Express (port 3456)                 │ │
│  │     │       SSE push ◄────────── notifyClients()           │ │
│  │     │                                                       │ │
│  │     ├──► tunnel.js ──► cloudflared.exe (child process)     │ │
│  │     │       public URL via stdout/stderr parse             │ │
│  │     │                                                       │ │
│  │     └──► notify.js ──► Discord webhook (https.request)     │ │
│  │                                                             │ │
│  │  System tray icon (no BrowserWindow)                        │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                │                                  │
│  screenshots/  (PNG files)     │  logs/app.log                   │
│  %APPDATA%\ScreenMonitor\      │                                  │
└──────────────────────────────────────────────────────────────────┘
         │ port 3456                    │ tunnel
         ▼                             ▼
   Local browser              Cloudflare network
   (any device on LAN)        (public HTTPS URL)
```

---

## Module Roles

### `main.js` — Orchestrator

The single entry point and coordinator. It owns:
- The `state` object (shared with Express via closure)
- The capture loop (`setTimeout` + `setInterval`)
- The tray icon and context menu
- Wiring all modules together

It does NOT contain business logic — that lives in the other modules. `main.js` calls `doCapture()` on a timer, reacts to results, and delegates everything else.

### `config.js` — Settings Layer

Loads environment variables from `.env` (located in `dataDir`) and exports a frozen settings object. All other modules import config — nothing reads `process.env` directly except config.js.

**Key rule:** `dataDir` differs between dev and production. Never hardcode paths.

### `capture.js` — Screenshot Engine

Wraps `desktopCapturer.getSources()` with:
- Case-insensitive partial title matching
- Full-screen fallback when target not found
- Blank image detection (`buffer.length < 500`)
- `thumbnailSize: {width:7680, height:4320}` — 8K cap ensures native resolution on any monitor

Returns a typed result object; never throws.

### `server.js` — HTTP Layer

Express app listening on `0.0.0.0:3456`. Token auth middleware runs on every route. Returns `{ notifyClients }` — a function that pushes data frames to all active SSE connections.

The server reads state via the `getState` closure — it has no direct reference to `main.js`, only to the function it was given.

### `tunnel.js` — Remote Access

Spawns `cloudflared.exe` as a hidden child process. Scans its stdout and stderr for the regex `/https:\/\/[a-z0-9-]+\.trycloudflare\.com/`. Calls `onUrl(url)` once when found. 40s timeout if never found.

The binary path differs between dev (`bin/cloudflared.exe`) and packaged (`process.resourcesPath/cloudflared.exe`).

### `notify.js` — Discord Alerts

Fire-and-forget HTTP POST to a Discord webhook. All errors silently swallowed. No npm dependencies — uses Node.js built-in `https.request`. Only called from `main.js` in the capture loop.

### `web/index.html` — Browser UI

A single-file SPA (~800 lines). No build step, no bundler, no npm dependencies. Loaded by the browser when hitting the Express server. Uses:
- CSS custom properties for the design system
- Vanilla JS with no framework
- `EventSource` for SSE
- `localStorage` for offline resilience
- `transform: translate() scale()` with `transform-origin: 0 0` for zoom

---

## Startup Sequence

```
app.whenReady()
  1. app.setAppUserModelId('com.screenmonitor.app')
  2. app.setLoginItemSettings({ openAtLogin: true })
  3. ensureDirs()  — create screenshots/ and logs/ if missing
  4. log('=== ScreenMonitor starting ===')
  5. startServer({ getState, screenshotDir, targetWindowTitle })
       → Express listening on 0.0.0.0:3456
       → returns { notifyClients }
  6. createTray()
       → generates 32×32 green PNG in memory
       → displays balloon: "ScreenMonitor is running"
  7. startTunnel(port, onUrl, log)
       → spawns cloudflared.exe
       → when URL found: tray.setContextMenu(buildMenu(url))
                         displays balloon: "Remote access ready"
  8. autoUpdater.checkForUpdatesAndNotify()  (packaged only)
  9. setTimeout(doCapture, 2500)  — first capture after 2.5s
 10. setInterval(doCapture, captureIntervalMs)  — repeating
```

---

## Screenshot Lifecycle

```
doCapture() called
  │
  ├─ captureWindow(title, fallback=true)
  │    ├─ desktopCapturer.getSources({ types:['window'], thumbnailSize:8K })
  │    ├─ find source by partial title match
  │    │    found? → thumbnail.toPNG() → check size > 500 bytes
  │    │    not found + fallback? → getSources({ types:['screen'] }) → toPNG()
  │    └─ returns { success, pngBuffer, windowName, isFallback, availableWindows }
  │
  ├─ result.success = true
  │    ├─ SHA256(pngBuffer) → compare with state.lastCaptureHash
  │    │    same? → log "No change" → return (no save, no SSE push)
  │    │
  │    ├─ changed? → write ${Date.now()}.png to screenshotDir
  │    │             prune oldest over historyLimit
  │    │             state.lastCaptureHash = hash
  │    │             notifyClients({ type:'screenshot', t })  ← SSE push
  │    │
  │    └─ alert tracking
  │         isFallback? → consecutiveNonOk++
  │                       if == discordAlertAfter → alertFailure()
  │         ok?         → if wasAlerting → alertRecovery()
  │                       consecutiveNonOk = 0
  │
  └─ result.success = false
       state.lastCaptureStatus = 'error'
       consecutiveNonOk++
       if == discordAlertAfter → alertFailure()
```

---

## SSE Update Flow

```
doCapture() saves new PNG
  │
  └─► notifyClients({ type:'screenshot', t: 1234567890 })
        │
        └─► for each SSE client:
              res.write('data: {"type":"screenshot","t":1234567890}\n\n')

Browser (web/index.html)
  │
  EventSource.onmessage fires
    │ data.type === 'screenshot' && isLive
    └─► fetchTimeline()  — updates screenshots[]
        loadShot(null)   — loads latest from /screenshot
        syncDots()       — highlights correct dot
        countdownN = 30  — resets display (but does not clear/restart interval)
        fetchStatus()    — updates meta bar
```

---

## File Layout on Disk

### Development (`npm start`)
```
project/
├── main.js, config.js, capture.js, server.js, tunnel.js, notify.js
├── web/index.html
├── bin/cloudflared.exe       ← downloaded by scripts/download-cloudflared.js
├── build/icon.ico            ← generated by scripts/generate-icon.js
├── screenshots/              ← created at runtime
│   ├── 1714000000000.png
│   └── 1714000060000.png
└── logs/
    └── app.log
```

### Packaged (installed exe)
```
C:\Program Files\ScreenMonitor\
├── ScreenMonitor.exe
└── resources/
    ├── app.asar              ← all source files packed (read-only)
    ├── app.asar.unpacked/
    │   └── web/
    │       └── index.html    ← unpacked because of asarUnpack:["web/**"]
    └── cloudflared.exe       ← from extraResources, not in asar

%APPDATA%\ScreenMonitor\      ← dataDir (writable user data)
├── .env                      ← optional user config
├── screenshots/
│   └── *.png
└── logs/
    └── app.log
```

---

## Token Authentication

Every HTTP request must carry the auth token as either:
- URL query param: `?token=VALUE`
- HTTP header: `X-Auth-Token: VALUE`

The middleware runs before all routes. Failure returns `401 Unauthorized` with a plain-text message.

The default token is `screenmonitor`. Users can override with `AUTH_TOKEN` in `.env`.

The remote URL in the tray menu is always pre-authenticated:
```
https://<tunnel>.trycloudflare.com/?token=<authToken>
```

---

## Zoom/Pan Implementation

The screenshot image uses:
```css
transform-origin: 0 0;
will-change: transform;
```

State is a single object `z = { scale, dx, dy }`. Applied as:
```js
img.style.transform = `translate(${z.dx}px, ${z.dy}px) scale(${z.scale})`;
```

**Zoom-to-cursor formula** (scroll wheel and pinch):
```js
// cx, cy = cursor position relative to viewport
z.dx = cx - (cx - z.dx) * newScale / z.scale;
z.dy = cy - (cy - z.dy) * newScale / z.scale;
z.scale = newScale;
```

This keeps the pixel under the cursor stationary as scale changes. `transform-origin: 0 0` is required — if it were `center center`, the math would be wrong.

Scale is clamped to `[1, 12]`. At scale=1, zoom resets to neutral.
