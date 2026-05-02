# ScreenMonitor — Master Context for Claude Code

This file is the single source of truth for any Claude Code session working on this project. Read it before touching any code.

---

## What This App Is

ScreenMonitor is a **tray-only Electron app** (no window, no terminal) that:
1. Captures a screenshot of a named window on a configurable interval (default: 1 min)
2. Detects whether the screen actually changed (SHA256 hash comparison) and skips saving if not
3. Serves all screenshots on a local Express web server with token auth
4. Publishes that server to the internet zero-config via a Cloudflare Quick Tunnel
5. Sends Discord alerts when the target window goes missing
6. Auto-updates from GitHub Releases when a new version is published
7. Auto-starts on Windows login via Electron's `setLoginItemSettings`

The target audience is a non-technical Windows user who wants to remotely monitor what's happening on a PC without any setup complexity.

---

## File Map — What Every File Does

```
main.js                  Electron entry point. Orchestrates everything.
config.js                All settings. Loads .env from dataDir.
capture.js               desktopCapturer wrapper. Returns PNG buffers.
server.js                Express HTTP server. Serves screenshots + SSE.
tunnel.js                Spawns cloudflared.exe, parses tunnel URL from output.
notify.js                Discord webhook. Fire-and-forget. No deps.
web/index.html           Full SPA — dark industrial UI, timeline, zoom/pan.
scripts/generate-icon.js Writes build/icon.ico (runs before npm run dist).
scripts/download-cloudflared.js Downloads cloudflared.exe to bin/ (runs before npm run dist).
package.json             electron-builder config, npm scripts.
```

---

## Architecture: Data Flow

```
Windows OS
  │
  ▼
desktopCapturer (capture.js)
  │  returns { success, pngBuffer, isFallback, availableWindows }
  ▼
doCapture() in main.js
  │  SHA256 hash → compare with state.lastCaptureHash
  │  if changed: write ${Date.now()}.png to screenshotDir
  │              prune oldest files over historyLimit
  │              notifyClients({ type:'screenshot', t })  ← SSE push
  │  update state object (shared with Express via closure)
  │  Discord alert if consecutiveNonOk >= discordAlertAfter
  ▼
state object (module-level in main.js)
  │  read by Express GET /status on every request
  ▼
Express server (server.js)
  │  GET /             → web/index.html
  │  GET /screenshot   → latest or ?t=<ms> PNG from disk
  │  GET /screenshots  → JSON list of {t, iso} objects
  │  GET /status       → state snapshot + screenshotCount
  │  GET /events       → SSE stream, pushed by notifyClients()
  ▼
Browser (web/index.html)
  │  SSE connection → instant update when screenshot saved
  │  30s poll fallback (if SSE drops)
  │  localStorage cache for offline resilience
```

---

## Critical Design Decisions

### 1. No BrowserWindow — tray only
`app.on('window-all-closed', () => {})` is intentionally empty. Without it, Electron quits when all windows close. Since there are no windows, this would quit immediately on startup.

### 2. `notifyClients` placeholder pattern
`server.js` exports a `notifyClients` function, but `main.js` needs to call it from inside `doCapture()`. Circular dependency avoided with:
```js
let notifyClients = () => {};  // safe no-op before server starts
// ...
({ notifyClients } = startServer({ ... }));  // replaced after server init
```
**Never import server.js before calling startServer().**

### 3. asar + Express + sendFile
With `asar: true`, source files are packed into a read-only `.asar` archive at runtime. `res.sendFile()` cannot stream from inside an asar. Solution: `asarUnpack: ["web/**"]` in `package.json` causes electron-builder to extract the `web/` directory into `app.asar.unpacked/web/`. `server.js` uses `path.join(__dirname, 'web', 'index.html')` which resolves correctly to the unpacked path.

### 4. Screenshot filename strategy
Files are named `${Date.now()}.png` — a Unix millisecond timestamp. This means:
- Lexicographic sort = chronological sort (no date parsing needed)
- Timestamp IS the identifier — used as `?t=<ms>` in API calls and in dot `data-t` attributes
- `listScreenshots()` filters `/^\d+\.png$/` so any other files (old `latest.png`, temp files) are ignored

### 5. Cache strategy for screenshots
Historical screenshots (`/screenshot?t=<ts>`) get `Cache-Control: immutable` because their content will never change. The latest screenshot uses `?_=${Date.now()}` as a cache-buster and `no-store` headers because its URL doesn't change but its content does.

### 6. SSE + 30s poll dual-channel
SSE delivers instant updates (< 1s) after a new screenshot is saved. The 30s poll is the fallback for when SSE drops (network interruption, proxy timeout). The 25s SSE heartbeat (`:heartbeat\n\n`) keeps the connection alive through Cloudflare and most proxies.

### 7. Cloudflare tunnel binary placement
- **Dev:** `bin/cloudflared.exe` (next to source)
- **Packaged:** `process.resourcesPath/cloudflared.exe` (outside the asar, via `extraResources`)

`process.resourcesPath` points to `<install>/resources/` in the packaged exe. The binary is NOT inside the asar archive.

### 8. `dataDir` split — source vs. user data
```
Dev:       __dirname       (writes logs/screenshots next to source)
Packaged:  app.getPath('userData')  → %APPDATA%\ScreenMonitor\
```
Source code lives in a read-only asar in production. All writes (screenshots, logs, .env) go to `userData`.

### 9. Change detection
`crypto.createHash('sha256').update(pngBuffer).digest('hex')` — if the hash matches `state.lastCaptureHash`, the file is NOT saved and `notifyClients` is NOT called. The status IS updated (so the web viewer knows the app is alive). This prevents disk churn when the screen is static.

### 10. Zoom-to-cursor math in web viewer
```js
z.dx = cx - (cx - z.dx) * newScale / z.scale;
z.dy = cy - (cy - z.dy) * newScale / z.scale;
z.scale = newScale;
img.style.transform = `translate(${z.dx}px, ${z.dy}px) scale(${z.scale})`;
```
`transform-origin: 0 0` is critical — without it, CSS applies scale from center and the math breaks. The formula keeps the point under the cursor fixed as scale changes.

---

## State Object (main.js)

The `state` object is the shared memory between the capture loop and the Express server. Express reads it on every `/status` request via the `getState` closure passed to `startServer()`.

```js
const state = {
  lastCaptureTime:   null,       // ISO string
  lastCaptureStatus: 'pending',  // 'pending' | 'ok' | 'fallback' | 'error'
  lastError:         null,       // string | null
  availableWindows:  '',         // pipe-separated window titles (debug aid)
  tunnelUrl:         null,       // set when Cloudflare URL resolves
  lastCaptureHash:   null,       // SHA256 of last saved PNG
  consecutiveNonOk:  0,          // increments on fallback or error
  wasAlerting:       false,      // true after Discord failure alert sent
};
```

**Discord alert logic:**
- Increments `consecutiveNonOk` on every non-ok capture
- At exactly `discordAlertAfter` (default: 3), sends failure alert, sets `wasAlerting = true`
- On a true ok capture, if `wasAlerting`, sends recovery alert and resets both counters

---

## Build Process

```
npm run dist
  └── runs predist first:
        1. node scripts/generate-icon.js  → build/icon.ico (multi-size ICO, no deps)
        2. node scripts/download-cloudflared.js → bin/cloudflared.exe (from GitHub)
  └── electron-builder --win
        → packs source into app.asar (except web/** which goes to app.asar.unpacked/)
        → copies bin/cloudflared.exe to resources/cloudflared.exe
        → generates NSIS installer → dist/ScreenMonitor Setup x.y.z.exe
```

**GitHub Releases auto-update:** `electron-updater` checks `github.com/thedudebro11/screenshot-update-app` releases. To publish a new version: bump `version` in `package.json`, push a tag `vX.Y.Z`, create a GitHub Release. The app self-updates on the next start.

---

## Known Limitations

| Issue | Cause | Workaround |
|-------|-------|------------|
| Black screenshots | Hardware-accelerated windows (games, GPU renderers) bypass screen capture | None — Windows limitation |
| Minimized = blank | `desktopCapturer` returns empty thumbnail for minimized windows | Keep target visible (can be behind other windows) |
| UWP apps invisible | Windows privacy settings block screen capture of Store apps | None — OS limitation |
| Cloudflare URL changes on restart | Quick Tunnels generate random subdomains | Need a paid Cloudflare account + named tunnel for persistent URL |
| `desktopCapturer` must run in main process | Electron 17+ restriction | All capture code stays in main process — never move to renderer |

---

## Debugging

**Log location:** `%APPDATA%\ScreenMonitor\logs\app.log` (packaged) or `logs/app.log` (dev)

**What's in the log:**
- Every capture attempt with result
- "No change detected — skipping save" when hash matches
- "Saved: WindowName (X.X KB)" on successful save
- "Tunnel live: https://..." when Cloudflare URL resolves
- "Discord: failure/recovery alert sent"
- Any errors from `captureWindow`

**Available windows list:** When target window isn't found, log shows `Available windows: App1 | App2 | ...`. Use this to find the exact title partial match needed in `TARGET_WINDOW_TITLE`.

**Dev mode:** `npm run dev` adds `--enable-logging` flag — Electron's internal logs (GPU, IPC, etc.) also appear in the terminal.

**SSE debug:** Open browser DevTools → Network tab → filter by "events" — you'll see the live SSE stream with heartbeat frames every 25s and data frames on new screenshots.

---

## Web Viewer State Machine

```
Boot
  │ doRefresh() → fetchStatus() + fetchTimeline()
  │ if screenshots exist → loadShot(null)  [latest]
  └─► startTick()  [30s countdown loop]

isLive = true (default)
  │ SSE message arrives → fetchTimeline + loadShot(null) + reset countdown
  │ Refresh button → goLive(resetTimer=false)  [no countdown restart]
  │ Live button → goLive(resetTimer=true)  [restart countdown]
  └─► stays in live mode

isLive = false (history mode)
  │ enter via: dot click, ‹/› buttons, ← → arrow keys
  │ currentT = the selected timestamp
  │ countdown keeps ticking silently (updateCountdown is no-op when !isLive)
  │ timeline re-fetches on SSE events (so new dots appear while in history)
  └─► exit via: Refresh or Live button

Offline (server unreachable)
  │ fetchStatus() catch → isOnline = false
  │ loads sm_last_status from localStorage
  │ shows "OFFLINE — SHOWING LAST KNOWN STATE" banner
  └─► screenshot image stays showing (not cleared)
```

---

## Dependencies

**Runtime (bundled in installer):**
- `express` — HTTP server
- `dotenv` — .env file loading
- `electron-updater` — auto-update from GitHub

**Dev only:**
- `electron` — Electron framework
- `electron-builder` — installer/packager

**No external deps for:**
- PNG generation (pure Node.js zlib + CRC32)
- ICO generation (pure binary manipulation)
- Discord webhooks (Node.js built-in `https`)
- Change detection (Node.js built-in `crypto`)
- Cloudflare tunnel (binary, no npm package)

---

## Project History (from inception)

**Goal:** Build a hands-free screen monitoring tool for non-technical Windows users.

**Initial implementation:** Core capture loop, Express server, basic HTML viewer.

**Session 1 additions:**
1. Cloudflare Quick Tunnel — zero-config remote access (replaced manual Tailscale suggestion)
2. Auto-startup on Windows login via `setLoginItemSettings`
3. Screenshot history timeline with dot scrubber
4. Auto-update via `electron-updater` + GitHub Releases
5. SHA256 change detection — skip saves when screen unchanged
6. Discord failure/recovery alerts via webhooks
7. Web viewer: full dark industrial SaaS redesign (Grafana/Linear aesthetic)
8. SSE push for instant updates (was polling-only before)
9. localStorage offline resilience cache
10. Zoom/pan with zoom-to-cursor math (scroll, drag, pinch, double-click-reset)
11. `electron-builder` NSIS installer with `predist` scripts for icon + cloudflared
12. Fixed Refresh button — does NOT restart the 30s countdown (Live button does)

**Key bugs fixed during development:**
- Arrow key navigation not working → old `latest.png` file excluded by `/^\d+\.png$/` filter
- Screenshot not auto-updating → fixed by adding SSE (was relying on 30s poll only)
- `loadShot` variable conflict → local `const img` inside function shadowed module-level `img`
- Refresh restarted timer → added `goLive(resetTimer=true/false)` parameter
