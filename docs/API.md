# ScreenMonitor — HTTP API Reference

All endpoints require token authentication. Provide the token as either:
- `?token=VALUE` query parameter (recommended — works in browser address bar)
- `X-Auth-Token: VALUE` HTTP header

The token defaults to `screenmonitor`. Set `AUTH_TOKEN` in `.env` to change it.

---

## Endpoints

### `GET /`

Returns the web viewer HTML page (`web/index.html`).

**Auth required:** Yes  
**Caching:** None (HTML is always fresh)

**Example:**
```
http://localhost:3456/?token=screenmonitor
```

---

### `GET /screenshot`

Returns a PNG image — either the latest screenshot or a specific historical one.

**Auth required:** Yes

#### Latest screenshot

```
GET /screenshot?token=screenmonitor
```

**Response headers:**
```
Content-Type: image/png
Cache-Control: no-store, no-cache, must-revalidate
Pragma: no-cache
```

Returns `404` with plain text if no screenshots have been captured yet.

#### Historical screenshot

```
GET /screenshot?t=1714000060000&token=screenmonitor
```

**Query params:**
| Param | Type | Description |
|-------|------|-------------|
| `t` | integer | Unix timestamp in milliseconds (the filename without `.png`) |

**Response headers:**
```
Content-Type: image/png
Cache-Control: public, max-age=31536000, immutable
```

Historical screenshots are immutable (content never changes for a given `t`), so they get aggressive browser caching.

Returns `400` if `t` is not a valid integer.  
Returns `404` if the file doesn't exist (may have been pruned by `historyLimit`).

---

### `GET /screenshots`

Returns a JSON list of all available screenshot timestamps, newest first.

**Auth required:** Yes  
**Content-Type:** `application/json`

**Example:**
```
GET /screenshots?token=screenmonitor
```

**Response:**
```json
{
  "files": [
    { "t": 1714000120000, "iso": "2024-04-25T12:02:00.000Z" },
    { "t": 1714000060000, "iso": "2024-04-25T12:01:00.000Z" },
    { "t": 1714000000000, "iso": "2024-04-25T12:00:00.000Z" }
  ],
  "latest": 1714000120000,
  "count": 3
}
```

**Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `files` | array | All available screenshots, newest first |
| `files[].t` | integer | Unix ms timestamp — also the filename (`{t}.png`) |
| `files[].iso` | string | ISO 8601 UTC timestamp |
| `latest` | integer \| null | Timestamp of the newest screenshot, or null if none |
| `count` | integer | Total number of stored screenshots |

The `t` values are what you pass to `/screenshot?t=<value>` for historical access.

---

### `GET /status`

Returns the current application state — capture status, tunnel URL, error details.

**Auth required:** Yes  
**Content-Type:** `application/json`

**Example:**
```
GET /status?token=screenmonitor
```

**Response:**
```json
{
  "targetWindow": "RustDesk",
  "status": "ok",
  "lastCaptureTime": "2024-04-25T12:02:00.000Z",
  "error": null,
  "availableWindows": null,
  "tunnelUrl": "https://abc-def-ghi.trycloudflare.com",
  "screenshotCount": 3,
  "screenshotExists": true,
  "serverTime": "2024-04-25T12:02:05.123Z"
}
```

**Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `targetWindow` | string | The `TARGET_WINDOW_TITLE` setting |
| `status` | string | `"pending"` \| `"ok"` \| `"fallback"` \| `"error"` |
| `lastCaptureTime` | string \| null | ISO 8601 UTC of last capture attempt |
| `error` | string \| null | Human-readable error description, or null |
| `availableWindows` | string \| null | Pipe-separated list of open window titles (debug aid — populated when target window not found) |
| `tunnelUrl` | string \| null | Cloudflare tunnel base URL, or null before tunnel establishes |
| `screenshotCount` | integer | Number of PNG files currently on disk |
| `screenshotExists` | boolean | Whether at least one screenshot exists |
| `serverTime` | string | ISO 8601 UTC of when this response was generated |

**Status values explained:**
| Value | Meaning |
|-------|---------|
| `"pending"` | App just started, no capture attempted yet |
| `"ok"` | Target window found and captured successfully |
| `"fallback"` | Target window not found — fell back to full-screen capture |
| `"error"` | Capture failed entirely (blank image, desktopCapturer error, disk write failure) |

---

### `GET /events`

Server-Sent Events stream. The server pushes a frame whenever a new screenshot is saved.

**Auth required:** Yes  
**Content-Type:** `text/event-stream`

**Example:**
```
GET /events?token=screenmonitor
```

**Connection:**
- The connection stays open indefinitely
- A heartbeat comment frame (`:heartbeat`) is sent every 25 seconds to keep the connection alive through proxies
- On disconnect, the connection is automatically removed from the client set
- `EventSource` in the browser auto-reconnects on drop

**Data frames (push on new screenshot):**
```
data: {"type":"screenshot","t":1714000120000}

```

Note the blank line after — SSE spec requires `\n\n` to end an event.

**Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Always `"screenshot"` currently |
| `t` | integer | Unix ms timestamp of the new screenshot |

The browser web viewer uses this `t` value to immediately load the new screenshot via `/screenshot?t=<t>` (or reload latest) without waiting for the 30s poll.

---

## Authentication Errors

```
HTTP/1.1 401 Unauthorized
Content-Type: text/plain

401 Unauthorized

Add ?token=YOUR_TOKEN to the URL.
The token is shown in the tray menu and in your .env file as AUTH_TOKEN.
```

---

## Notes for Integrations

If you want to build your own client (mobile app, script, etc.):

1. Call `/status` to check if the app is alive and get the latest capture time
2. Call `/screenshots` to get the list of available frames
3. Call `/screenshot?t=<value>` to fetch a specific frame as a PNG blob
4. Connect to `/events` with EventSource for real-time push notifications

All endpoints are served on `0.0.0.0` (not just localhost), so they're reachable from other devices on the same network and through the Cloudflare tunnel.
