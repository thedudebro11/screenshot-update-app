<div align="center">

# ScreenMonitor

**Remote PC monitoring that just works. No account. No port forwarding. No subscription.**

[![Version](https://img.shields.io/badge/version-1.2.0-brightgreen?style=flat-square)](https://github.com/thedudebro11/screenshot-update-app/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Windows-blue?style=flat-square&logo=windows)](https://github.com/thedudebro11/screenshot-update-app/releases/latest)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-lightgrey?style=flat-square)](LICENSE)

[**Download for Windows →**](https://github.com/thedudebro11/screenshot-update-app/releases/latest)

</div>

---

> Drop a tiny installer on any Windows PC and instantly get a private, authenticated web page — accessible from your phone, another country, anywhere — showing a live screenshot feed of that machine. No router config. No VPN. No Tailscale. No cloud account.

---

## How it works

ScreenMonitor runs silently in the system tray. Every minute (configurable) it captures a screenshot, checks if anything actually changed, and if so saves it and instantly pushes it to any open browser tabs via a live connection. A built-in Cloudflare tunnel gives you a public URL the moment it starts — no setup on your end.

```
Windows PC  →  captures screenshot  →  detects change  →  saves to disk
                                                         →  pushes to browser instantly
                                                         →  serves via Cloudflare URL
```

**That's the whole thing.** One installer, one tray icon, one URL.

---

## Features

- **Zero-config remote access** — Cloudflare Quick Tunnel generates a public HTTPS URL on every launch. Share it and you're done.
- **Live push updates** — browser updates the instant a new screenshot is saved, no refresh needed
- **Smart change detection** — skips saving if nothing on screen changed (SHA256 comparison), so you don't fill your disk with duplicates
- **Full screenshot history** — timeline scrubber lets you step through every captured moment
- **Zoom & pan** — scroll to zoom, drag to pan, pinch on touch devices, double-click to reset
- **Discord alerts** — get pinged when the target window goes missing or capture fails, and again when it recovers
- **Starts with Windows** — auto-launches on login so you never have to think about it
- **Self-updating** — pulls new versions from GitHub Releases automatically
- **Completely local** — screenshots never leave your machine (Cloudflare only proxies the connection, never stores data)

---

## Installation

1. Download **`ScreenMonitor Setup 1.2.0.exe`** from the [Releases page](https://github.com/thedudebro11/screenshot-update-app/releases/latest)
2. Run it and follow the installer (about 30 seconds)
3. Done — a green icon appears in your system tray

> **Windows SmartScreen warning?** Click **"More info"** → **"Run anyway"**. This appears because the app isn't code-signed by a large corporation, not because anything is wrong.

No Node.js. No terminal. No configuration required.

---

## Your viewer URL

Within seconds of launching you'll see two notifications:

- **"ScreenMonitor is running"** — your local URL
- **"Remote access ready"** — your public Cloudflare URL, works from any device anywhere

Right-click the tray icon at any time to copy or open either URL. The full authenticated link looks like:

```
https://abc-def-ghi.trycloudflare.com/?token=yourtoken
```

Send it to anyone who needs to view the screen. Works on phones, tablets, any browser.

---

## Tray menu

Right-click the green tray icon to access everything:

| Option | What it does |
|--------|-------------|
| Capture Now | Takes a screenshot immediately |
| Open Viewer (Local) | Opens the viewer on this PC |
| Open Viewer (Remote) | Opens the public URL |
| Copy Remote URL | Copies the full authenticated URL |
| Set Target Window | Pick which window to watch (or Full Screen) |
| Capture Interval | Change how often screenshots are taken |
| Open Data Folder | Opens where screenshots and logs are stored |
| Quit | Stops the app |

---

## Web viewer

| Action | Result |
|--------|--------|
| Scroll wheel | Zoom in / out centered on cursor |
| Click + drag | Pan when zoomed in |
| Double-click | Reset zoom to fit |
| Pinch (touch/trackpad) | Pinch to zoom |
| ← → arrow keys | Step through screenshot history |
| Click timeline dot | Jump to that moment |
| Live button | Return to latest and resume auto-update |

---

## Configuration

Most settings are accessible from the tray menu with no file editing needed.

For advanced configuration, create a `.env` file inside your data folder (`%APPDATA%\ScreenMonitor\`). Open it via **tray → Open Data Folder**.

```env
# Which window to watch — leave blank (default) to capture the full screen
TARGET_WINDOW_TITLE=

# How often to capture, in minutes (default: 1)
CAPTURE_INTERVAL_MINUTES=1

# How many screenshots to keep before oldest are deleted (default: 100)
HISTORY_LIMIT=100

# Discord webhook URL for failure/recovery alerts (leave blank to disable)
DISCORD_WEBHOOK_URL=

# How many consecutive failures before a Discord alert fires (default: 3)
DISCORD_ALERT_AFTER=3
```

Restart ScreenMonitor after saving (tray → Quit, then relaunch from Start menu).

---

## Discord alerts

1. In Discord, go to the channel you want → Settings (⚙) → Integrations → Webhooks → New Webhook
2. Copy the webhook URL
3. Paste it into `.env` as `DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...`
4. Restart ScreenMonitor

You'll get an **⚠️ alert** when capture fails 3 times in a row, and a **✅ recovery** ping when it comes back.

---

## Troubleshooting

**Black or blank screenshot**
Hardware-accelerated windows (games, GPU-heavy apps) bypass Windows screen capture — there's no workaround, it's an OS limitation. Minimized windows also produce blank captures. Keep the target window visible (it can be behind other windows, just not minimized to the taskbar).

**"Window not found" / falling back to full screen**
ScreenMonitor couldn't find the window title you set. Open `logs\app.log` in your data folder and look for `Available windows:` — it lists every window the app can see, so you can find the exact title to use.

**Viewer shows OFFLINE**
The app isn't running or isn't reachable. Check the system tray for the green icon.

**Remote URL stopped working**
The Cloudflare URL is temporary and changes on every restart. Get the new one from the tray menu → Copy Remote URL. For a permanent URL you'd need a Cloudflare account with a named tunnel.

---

## Privacy & data

Screenshots are stored only on the local PC at `%APPDATA%\ScreenMonitor\screenshots\`. They are never uploaded to any server. When you use the remote URL, screenshots pass through Cloudflare's network encrypted (standard HTTPS) but are not stored by Cloudflare. The oldest screenshots are pruned automatically once `HISTORY_LIMIT` is reached.

---

## Uninstalling

**Settings → Apps → ScreenMonitor → Uninstall.**

Your screenshots and `.env` in `%APPDATA%\ScreenMonitor\` are not removed automatically — delete that folder manually if you want a completely clean removal.

---

## License

Free for personal use. See [LICENSE](LICENSE) for details.
Commercial use: [thedevguy0101@gmail.com](mailto:thedevguy0101@gmail.com)
