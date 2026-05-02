# ScreenMonitor

Captures a screenshot of a target window on a schedule and serves it on a private web page you can open from any device, anywhere — no setup required.

---

## What it does

- Runs silently in the **system tray** (no window, no terminal)
- Takes a screenshot of a specific app every minute (configurable)
- Only saves a new screenshot **if the screen actually changed**
- Serves those screenshots on a private web page with a timeline you can scrub through
- Creates a **public remote URL automatically** using Cloudflare — no Tailscale, no port forwarding, no account needed
- Sends **Discord alerts** if the target window goes missing or capture fails
- Starts automatically when Windows boots

---

## Installation

1. Download **ScreenMonitor Setup.exe** from the [Releases page](https://github.com/thedudebro11/screenshot-update-app/releases)
2. Double-click it and follow the installer (takes about 30 seconds)
3. ScreenMonitor starts immediately after installation

That's it. No Node.js, no terminal, no configuration required to get started.

---

## First run

After installation a **green icon** appears near your clock in the bottom-right corner of the taskbar.

Within a few seconds you'll see two balloon notifications:

1. **"ScreenMonitor is running"** — shows your local viewer URL
2. **"Remote access ready"** — shows your public Cloudflare URL that works from anywhere

**Right-click the green icon** at any time for the menu:

| Menu item | What it does |
|---|---|
| Capture Now | Takes a screenshot immediately |
| Open Viewer (Local) | Opens the viewer in your browser on this PC |
| Open Viewer (Remote) | Opens the public URL (works on any device) |
| Copy Remote URL | Copies the full authenticated URL to your clipboard |
| Open Data Folder | Opens the folder where screenshots and logs are stored |
| Quit | Stops the app (it will restart on next login) |

---

## Viewing screenshots

Open the viewer URL in any browser. The page shows:

- The latest screenshot, **updating automatically the moment a new one is captured**
- A **timeline bar** at the bottom — each dot is one saved screenshot
- Click any dot to view that moment in time
- Use **← →** arrow keys to step through captures
- Click **Live** or **Refresh** to return to the latest

**Zooming in:**

| Action | Result |
|---|---|
| Scroll wheel | Zoom in / out, centered on your cursor |
| Click and drag | Pan around when zoomed in |
| Double-click | Reset zoom back to fit |
| Pinch (touch / trackpad) | Pinch to zoom |

---

## Sharing remote access

The **Remote URL** in the tray menu is a full public link that includes your secret token. It looks like:

```
https://abc-def-ghi.trycloudflare.com/?token=yourtoken
```

Copy it and send it to whoever needs to view the screen. It works on any device with a browser — phone, tablet, another PC.

> **Note:** The remote URL is temporary and changes each time ScreenMonitor restarts.
> For a permanent URL you'd need a Cloudflare account and a named tunnel (optional, not covered here).

---

## Configuration

To customize settings, create a file called `.env` inside your data folder.

**To open the data folder:** Right-click the tray icon → **Open Data Folder**

Create a new text file there named `.env` (not `.env.txt`) and add any of these lines:

```
# Which window to watch (partial match, case-insensitive)
TARGET_WINDOW_TITLE=RustDesk

# How often to capture, in minutes (default: 1)
CAPTURE_INTERVAL_MINUTES=1

# How many screenshots to keep before oldest are deleted (default: 100)
HISTORY_LIMIT=100

# Secret token for the web viewer (default: screenmonitor)
AUTH_TOKEN=screenmonitor

# Discord webhook URL for alerts (leave blank to disable)
DISCORD_WEBHOOK_URL=

# Consecutive non-ok captures before a Discord alert fires (default: 3)
DISCORD_ALERT_AFTER=3
```

Restart ScreenMonitor after saving — right-click the tray icon → Quit, then relaunch from the Start menu.

---

## Discord alerts

ScreenMonitor can ping a Discord channel when something goes wrong.

1. In Discord, open the channel you want alerts in
2. Click the gear (⚙) → **Integrations** → **Webhooks** → **New Webhook**
3. Copy the webhook URL
4. Paste it into your `.env` file:
   ```
   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR/WEBHOOK
   ```
5. Restart ScreenMonitor

You'll receive:

- **⚠️ Alert** when the target window hasn't been found for 3 captures in a row
- **✅ Recovered** when capture returns to normal

---

## Troubleshooting

**The screenshot is black or blank**

Some apps use hardware acceleration that blocks screen capture — this includes most games and some GPU-heavy software. There is no workaround; it's a Windows limitation. If the window is minimized it also produces a blank image. Keep the target window visible on screen (it can be behind other windows, just not minimized to the taskbar).

**"Window not found" — showing full screen instead**

ScreenMonitor fell back to a full-screen capture because it couldn't find your target window. Make sure the app is open and that `TARGET_WINDOW_TITLE` in your `.env` matches part of the window's title bar text. Not sure what the exact title is? Open the data folder → `logs\app.log` and look for lines that say `Available windows:` — they list every window the app can currently see.

**The web viewer shows "OFFLINE"**

The app isn't reachable. Check that the green icon is still in the system tray and that you're using the correct URL and token.

**The remote URL stopped working**

The Cloudflare URL changes every time ScreenMonitor restarts. Get the new one from the tray menu → **Copy Remote URL**.

**I want to see what the app is doing**

Open the data folder from the tray menu. The file `logs\app.log` has a timestamped entry for every capture, skipped frame (no change), and any error.

---

## Data & privacy

All screenshots are stored locally on this PC in your data folder (`%APPDATA%\ScreenMonitor\screenshots\`). They are never sent to any external server. When you use the remote URL, screenshots pass through Cloudflare's network in transit — encrypted, the same as any HTTPS connection — but are not stored by Cloudflare.

The oldest screenshots are deleted automatically once the folder reaches your `HISTORY_LIMIT`.

---

## Uninstalling

Go to **Settings → Apps**, find **ScreenMonitor**, and click Uninstall. Your screenshots and `.env` file in `%APPDATA%\ScreenMonitor\` are not removed by the uninstaller — delete that folder manually if you want a completely clean removal.
