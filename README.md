# Screen Monitor

A minimal Windows tray app that captures one specific window every 10 minutes and serves the screenshot on a local web page you can check from your phone.

---

## Quick Start

### 1. Install dependencies

```
cd screenshot-update-app
npm install
```

### 2. Configure

Copy `.env.example` to `.env` and edit it:

```
copy .env.example .env
notepad .env
```

The only two things you **must** change:

| Setting | What to put |
|---|---|
| `TARGET_WINDOW_TITLE` | Part of the window title you want to watch (e.g. `TeamViewer`, `Chrome`, `Remote Desktop`) |
| `AUTH_TOKEN` | A secret string you'll add to the URL. Pick anything random. |

> **Tip:** Not sure what the window title is?  
> Run the app once, then open `logs/app.log`. When the window isn't found it logs  
> `Available windows: ...` — find your app in that list and copy part of its name.

### 3. Run

```
npm start
```

A small icon appears in your system tray (bottom-right near the clock).  
Right-click it for options: **Capture Now**, **Open Web Viewer**, **Quit**.

### 4. Open the viewer

The console prints the full URL:

```
http://localhost:3456/?token=your-token-here
```

Open that in any browser. Bookmark it. The page auto-refreshes every 30 seconds.

---

## Accessing Remotely

The server already binds to `0.0.0.0` (all interfaces), so you just need a tunnel.

### Option A — Tailscale (recommended, easiest)

1. Install Tailscale on the PC: https://tailscale.com/download/windows  
2. Install Tailscale on your phone (free)  
3. Log in with the same account on both devices  
4. Find the PC's Tailscale IP in the Tailscale admin panel (looks like `100.x.x.x`)  
5. On your phone, open:  
   ```
   http://100.x.x.x:3456/?token=your-token
   ```
   That's it. No port forwarding, no firewall rules, no exposure to the public internet.

### Option B — Cloudflare Tunnel

1. Install `cloudflared`: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/  
2. Run:
   ```
   cloudflared tunnel --url http://localhost:3456
   ```
3. Cloudflare prints a temporary `https://xxxx.trycloudflare.com` URL  
4. Open that URL + `?token=your-token` on your phone  
5. The URL changes each restart. For a permanent URL you need a Cloudflare account and a named tunnel.

### Security note

- The `AUTH_TOKEN` is the only thing protecting the page. Make it something hard to guess (16+ random characters).
- Never expose port 3456 directly via your router's port forwarding — always use Tailscale or a tunnel.
- The viewer shows screenshots of your screen. Treat the token like a password.

---

## Configuration Reference (`.env`)

```env
TARGET_WINDOW_TITLE=Chrome        # Partial window title (case-insensitive match)
CAPTURE_INTERVAL_MINUTES=10       # Minutes between automatic captures
PORT=3456                         # Web server port
AUTH_TOKEN=changeme               # Secret token for the web viewer
SCREENSHOT_PATH=./screenshots/latest.png   # Where to save the image
LOG_PATH=./logs/app.log           # Where to write logs
```

---

## Troubleshooting

### "Window not found" / blank screenshot

1. Check `logs/app.log` for the `Available windows:` line to see what the app can see.
2. The window title must be visible in the taskbar — not minimized to a system tray icon.
3. Some apps (Windows Store / UWP apps) block capture entirely. Use full-screen fallback by accepting it — the app automatically falls back to full screen capture when the window isn't found.
4. Hardware-accelerated windows (some games, certain browsers) may appear black. Try a different browser or disable hardware acceleration in Chrome via `chrome://settings/?search=hardware`.

### Minimized window produces blank image

Restore the target app window. Minimized windows produce zero-size thumbnails in the Windows compositor — this is a Windows limitation, not a bug in this app.

### "Cannot reach server" in the web viewer

- Make sure the tray app is still running (look in the system tray).
- Check that the port isn't blocked by Windows Firewall. Allow it with:
  ```
  netsh advfirewall firewall add rule name="ScreenMonitor" dir=in action=allow protocol=TCP localport=3456
  ```

### App doesn't stay running / crashes silently

Check `logs/app.log` for error messages.

### "electron is not recognized" after npm install

Use the full path: `npx electron .` instead of `npm start`.

---

## Building an .exe (optional)

```
npm run build
```

This uses `electron-builder` to produce an NSIS installer in `dist/`.  
The resulting `.exe` bundles Electron and all dependencies — no Node.js required on the target machine.

Before building, edit `package.json` and set a proper `build.appId` and `productName`.

---

## File Structure

```
screenshot-update-app/
├── main.js          Electron main process (tray, intervals, capture loop)
├── capture.js       desktopCapturer wrapper (window/screen capture logic)
├── server.js        Express server (auth, /screenshot, /status, /)
├── config.js        Reads .env and exports all settings
├── web/
│   └── index.html   Web viewer page (dark UI, auto-refresh, status badges)
├── screenshots/     Auto-created. Holds latest.png (only one file kept)
├── logs/            Auto-created. Holds app.log
├── .env             Your local config (not committed to git)
└── .env.example     Template for .env
```
