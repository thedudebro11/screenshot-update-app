# ScreenMonitor — Configuration Reference

## Where Settings Live

**Packaged app (installed .exe):**
```
%APPDATA%\ScreenMonitor\.env
```

**Development (npm start):**
```
<project root>/.env
```

Create the `.env` file manually — it is never created automatically. If the file doesn't exist, all defaults apply.

> **Note:** Restart ScreenMonitor after changing `.env`. Right-click the tray icon → Quit, then relaunch.

---

## All Environment Variables

### `TARGET_WINDOW_TITLE`

**Default:** `RustDesk`  
**Type:** String (partial, case-insensitive window title match)

The app looks for a window whose title *contains* this string (case-insensitive). If not found, it falls back to a full-screen capture and sends Discord alerts after the threshold.

**Examples:**
```env
TARGET_WINDOW_TITLE=RustDesk
TARGET_WINDOW_TITLE=Firefox
TARGET_WINDOW_TITLE=Visual Studio Code
TARGET_WINDOW_TITLE=Chrome
```

**Finding the right value:** If captures show "fallback" status, open the log file (`logs\app.log`) and look for lines starting with `Available windows:` — they list every window the app can currently see, separated by `|`.

---

### `CAPTURE_INTERVAL_MINUTES`

**Default:** `1`  
**Type:** Integer (minutes)

How often the app takes a screenshot. Shorter intervals use more disk and CPU but give finer time resolution in the history timeline.

**Examples:**
```env
CAPTURE_INTERVAL_MINUTES=1     # every minute (default)
CAPTURE_INTERVAL_MINUTES=5     # every 5 minutes
CAPTURE_INTERVAL_MINUTES=30    # every 30 minutes
```

Minimum practical value is `1`. For sub-minute intervals, the value is parsed as `parseInt()` so `0` becomes `NaN` and falls back to the default.

---

### `PORT`

**Default:** `3456`  
**Type:** Integer

The local TCP port the Express server listens on. Change this if another app is already using 3456.

```env
PORT=8080
PORT=4000
```

The local viewer URL updates automatically when the port changes.

---

### `AUTH_TOKEN`

**Default:** `screenmonitor`  
**Type:** String

The secret token required to access the web viewer and API. Include it in the URL as `?token=YOUR_TOKEN` or as the `X-Auth-Token` HTTP header.

**The remote URL in the tray menu always includes this token pre-embedded.** Users who receive the shared remote URL don't need to know the token — it's already in the URL.

```env
AUTH_TOKEN=my-secret-token-123
AUTH_TOKEN=hunter2
```

Choose something non-guessable if you share the Cloudflare URL publicly.

---

### `HISTORY_LIMIT`

**Default:** `100`  
**Type:** Integer

Maximum number of PNG screenshots to keep on disk. When a new screenshot is saved and the total exceeds this limit, the oldest files are deleted automatically (by filename sort, which is chronological because filenames are Unix timestamps).

```env
HISTORY_LIMIT=50     # keep last 50
HISTORY_LIMIT=500    # keep last 500
HISTORY_LIMIT=1000   # keep about 16 hours at 1-min intervals
```

**Disk usage estimate:** Each screenshot is roughly 100–500 KB depending on screen content. At 1-minute intervals with the default limit of 100: ~10–50 MB.

---

### `DISCORD_WEBHOOK_URL`

**Default:** `` (empty — alerts disabled)  
**Type:** URL string

Discord webhook URL for failure and recovery alerts. Leave blank to disable all Discord notifications.

**How to get a webhook URL:**
1. Open the Discord channel you want alerts in
2. Channel Settings → Integrations → Webhooks → New Webhook
3. Copy the URL

```env
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/1234567890/abcdef...
```

**Alert types:**
- **Failure alert** (red embed): Sent when the target window hasn't been found for `DISCORD_ALERT_AFTER` consecutive captures
- **Recovery alert** (green embed): Sent when capture returns to normal after a failure alert

Errors posting to Discord are silently swallowed — a bad webhook URL will not crash the app.

---

### `DISCORD_ALERT_AFTER`

**Default:** `3`  
**Type:** Integer

How many consecutive non-ok captures (fallback or error) must occur before a Discord failure alert fires. Prevents alert spam from momentary glitches.

```env
DISCORD_ALERT_AFTER=1    # alert on first failure
DISCORD_ALERT_AFTER=3    # alert after 3 in a row (default)
DISCORD_ALERT_AFTER=10   # only alert after 10 consecutive failures
```

At 1-minute intervals, the default of 3 means alerts fire after about 3 minutes of the window being missing.

---

## Example `.env` Files

### Minimal — just change the target window

```env
TARGET_WINDOW_TITLE=Firefox
```

### Custom monitoring with Discord alerts

```env
TARGET_WINDOW_TITLE=RustDesk
CAPTURE_INTERVAL_MINUTES=2
HISTORY_LIMIT=200
AUTH_TOKEN=my-secret-token
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/your/webhook/url
DISCORD_ALERT_AFTER=5
```

### High-frequency capture (development/testing)

```env
TARGET_WINDOW_TITLE=Notepad
CAPTURE_INTERVAL_MINUTES=1
HISTORY_LIMIT=500
PORT=4000
AUTH_TOKEN=dev
```

---

## File and Directory Locations

| Path | Description |
|------|-------------|
| `%APPDATA%\ScreenMonitor\` | Root data directory (packaged) |
| `%APPDATA%\ScreenMonitor\.env` | User configuration file |
| `%APPDATA%\ScreenMonitor\screenshots\` | PNG files — `{timestamp_ms}.png` |
| `%APPDATA%\ScreenMonitor\logs\app.log` | Timestamped activity log |

In development, all paths are relative to the project root directory instead of `%APPDATA%\ScreenMonitor\`.

---

## Configuration Loading Order

1. `config.js` runs when the app starts
2. `app.isPackaged` determines `dataDir` (dev vs. production)
3. `dotenv` loads `{dataDir}/.env` (if it exists)
4. Each setting falls back to the hardcoded default if the env var is absent or invalid
5. Settings are frozen — changes to `.env` take effect only after a restart

**Nothing reads `process.env` directly** except `config.js`. All other modules import from `config.js`.
