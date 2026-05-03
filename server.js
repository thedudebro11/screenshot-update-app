/**
 * server.js
 *
 *   GET /              → serves the web viewer HTML page
 *   GET /screenshot    → serves a PNG (latest, or ?t=<timestamp> for history)
 *   GET /screenshots   → JSON list of all available screenshot timestamps
 *   GET /status        → JSON with capture status, tunnel URL, etc.
 *
 * Every request must include the auth token as either:
 *   - Query param:  ?token=YOUR_TOKEN
 *   - HTTP header:  X-Auth-Token: YOUR_TOKEN
 */

const express                  = require('express');
const fs                       = require('fs');
const path                     = require('path');
const { nativeImage }          = require('electron');
const config                   = require('./config');

// In-memory thumbnail cache — keyed by timestamp, capped at 300 entries.
const thumbCache = new Map();

function listScreenshots(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /^\d+\.png$/.test(f))
    .sort()
    .reverse(); // newest first
}

function startServer({ getState, targetWindowTitle, onIntervalChange, onHistoryLimitChange, onError }) {
  const app     = express();
  const clients = new Set(); // active SSE connections

  // ── Token auth middleware ──────────────────────────────────────────────────
  app.use((req, res, next) => {
    const token = req.query.token || req.headers['x-auth-token'];
    if (!token || token !== config.authToken) {
      res.status(401).type('text').send(
        '401 Unauthorized\n\nAdd ?token=YOUR_TOKEN to the URL.\n' +
        'The token is shown in the tray menu and in your .env file as AUTH_TOKEN.'
      );
      return;
    }
    next();
  });

  // ── GET /screenshot ────────────────────────────────────────────────────────
  // Serves latest PNG by default. Pass ?t=<unix_ms> for a historical one.
  app.get('/screenshot', (req, res) => {
    let filePath;

    if (req.query.t) {
      const ts = parseInt(req.query.t, 10);
      if (isNaN(ts)) return res.status(400).type('text').send('Invalid timestamp.');
      filePath = path.join(config.screenshotDir, `${ts}.png`);
    } else {
      const files = listScreenshots(config.screenshotDir);
      if (!files.length) {
        return res.status(404).type('text').send('No screenshot captured yet. Check /status for details.');
      }
      filePath = path.join(config.screenshotDir, files[0]);
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).type('text').send('Screenshot not found.');
    }

    // Historical screenshots have unique URLs and can be cached by the browser.
    // Latest always gets no-cache since its URL doesn't change.
    if (req.query.t) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    }

    res.sendFile(filePath);
  });

  // ── GET /thumbnail ────────────────────────────────────────────────────────
  // Returns a small PNG preview (~240px wide) of a historical screenshot.
  // Cached in memory so scrolling through the filmstrip doesn't re-decode.
  app.get('/thumbnail', (req, res) => {
    const ts = parseInt(req.query.t, 10);
    if (isNaN(ts)) return res.status(400).type('text').send('Invalid timestamp.');

    if (thumbCache.has(ts)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Content-Type', 'image/png');
      return res.send(thumbCache.get(ts));
    }

    const filePath = path.join(config.screenshotDir, `${ts}.png`);
    if (!fs.existsSync(filePath)) return res.status(404).type('text').send('Not found.');

    try {
      const img = nativeImage.createFromPath(filePath);
      if (img.isEmpty()) return res.status(404).type('text').send('Not found.');
      const thumb  = img.resize({ width: 240, quality: 'good' });
      const buffer = thumb.toPNG();

      if (thumbCache.size >= 300) thumbCache.delete(thumbCache.keys().next().value);
      thumbCache.set(ts, buffer);

      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Content-Type', 'image/png');
      res.send(buffer);
    } catch (err) {
      res.status(500).type('text').send('Thumbnail error.');
    }
  });

  // ── GET /screenshots ───────────────────────────────────────────────────────
  // Returns a JSON list of all available screenshot timestamps (newest first).
  app.get('/screenshots', (req, res) => {
    const files = listScreenshots(config.screenshotDir);
    const items = files.map(f => {
      const t = parseInt(f, 10);
      return { t, iso: new Date(t).toISOString() };
    });
    res.json({ files: items, latest: items[0]?.t || null, count: items.length });
  });

  // ── GET /status ────────────────────────────────────────────────────────────
  app.get('/status', (req, res) => {
    const s     = getState();
    const files = listScreenshots(config.screenshotDir);

    // Sum screenshot directory size for the disk usage warning in the viewer.
    const sizeKb = files.reduce((acc, f) => {
      try { return acc + fs.statSync(path.join(config.screenshotDir, f)).size; } catch(_) { return acc; }
    }, 0) / 1024;

    res.json({
      targetWindow:     s.targetWindowTitle || targetWindowTitle,
      status:           s.lastCaptureStatus,
      lastCaptureTime:  s.lastCaptureTime,
      error:            s.lastError || null,
      availableWindows: s.availableWindows || null,
      tunnelUrl:        s.tunnelUrl || null,
      screenshotCount:  files.length,
      screenshotExists: files.length > 0,
      screenshotSizeKb:  Math.round(sizeKb),
      captureIntervalMs: s.captureIntervalMs || null,
      historyLimit:      config.historyLimit,
      serverTime:        new Date().toISOString(),
    });
  });

  // ── GET /config/history-limit ─────────────────────────────────────────────
  app.get('/config/history-limit', (req, res) => {
    const limit = parseInt(req.query.limit, 10);
    if (isNaN(limit) || limit < 10 || limit > 500) {
      return res.status(400).json({ error: 'limit must be between 10 and 500' });
    }
    if (typeof onHistoryLimitChange === 'function') onHistoryLimitChange(limit);
    res.json({ ok: true, limit });
  });

  // ── GET /config/interval ──────────────────────────────────────────────────
  // Lets the web viewer change how often screenshots are captured.
  app.get('/config/interval', (req, res) => {
    const minutes = parseFloat(req.query.minutes);
    if (isNaN(minutes) || minutes < 0.1 || minutes > 120) {
      return res.status(400).json({ error: 'minutes must be between 0.1 and 120' });
    }
    if (typeof onIntervalChange === 'function') onIntervalChange(minutes);
    res.json({ ok: true, minutes });
  });

  // ── GET /events ───────────────────────────────────────────────────────────
  // Server-Sent Events stream. Pushes a JSON frame whenever a new screenshot
  // is saved so the browser updates instantly without waiting for the poll.
  app.get('/events', (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    clients.add(res);
    // Heartbeat keeps the connection alive through proxies and Cloudflare.
    const hb = setInterval(() => res.write(':heartbeat\n\n'), 25_000);
    req.on('close', () => {
      clients.delete(res);
      clearInterval(hb);
    });
  });

  // ── GET / ──────────────────────────────────────────────────────────────────
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'web', 'index.html'));
  });

  // ── Start ──────────────────────────────────────────────────────────────────
  const httpServer = app.listen(config.port, '0.0.0.0', () => {
    console.log(`[server] Web viewer: http://localhost:${config.port}/?token=${config.authToken}`);
  });
  httpServer.on('error', (err) => {
    if (typeof onError === 'function') onError(err);
  });

  return {
    notifyClients: (payload) => {
      const frame = `data: ${JSON.stringify(payload)}\n\n`;
      clients.forEach(c => c.write(frame));
    },
  };
}

module.exports = { startServer };
