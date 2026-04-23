/**
 * server.js
 *
 * A minimal Express server that:
 *   GET /            → serves the web viewer HTML page
 *   GET /screenshot  → serves the latest PNG screenshot
 *   GET /status      → returns JSON with capture status info
 *
 * Every request must include the auth token as either:
 *   - Query param:  ?token=YOUR_TOKEN
 *   - HTTP header:  X-Auth-Token: YOUR_TOKEN
 *
 * The server binds to 0.0.0.0 (all interfaces) so that Tailscale or
 * Cloudflare Tunnel can forward traffic to it from outside. See README.md
 * for how to set that up safely.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('./config');

function startServer({ getState, screenshotPath, targetWindowTitle }) {
  const app = express();

  // ── Token auth middleware ──────────────────────────────────────────────────
  // Applied to every route. Returns 401 for missing/wrong tokens.
  app.use((req, res, next) => {
    const token =
      req.query.token ||
      req.headers['x-auth-token'];

    if (!token || token !== config.authToken) {
      res
        .status(401)
        .type('text')
        .send(
          '401 Unauthorized\n\n' +
          'Add ?token=YOUR_TOKEN to the URL.\n' +
          'The token is set in your .env file as AUTH_TOKEN.'
        );
      return;
    }
    next();
  });

  // ── GET /screenshot ────────────────────────────────────────────────────────
  // Returns the latest PNG. Cache-Control: no-store ensures browsers always
  // fetch a fresh copy rather than showing a cached version.
  app.get('/screenshot', (req, res) => {
    if (!fs.existsSync(screenshotPath)) {
      res.status(404).type('text').send('No screenshot captured yet. Check /status for details.');
      return;
    }
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.sendFile(screenshotPath);
  });

  // ── GET /status ────────────────────────────────────────────────────────────
  // JSON object with current app state. Used by the web viewer to update labels.
  app.get('/status', (req, res) => {
  const s = getState();
  const screenshotExists = fs.existsSync(screenshotPath);

  res.json({
    targetWindow: targetWindowTitle,
    status: s.lastCaptureStatus,
    lastCaptureTime: s.lastCaptureTime,
    error: s.lastError || null,
    availableWindows: s.availableWindows || null,
    screenshotExists,
    serverTime: new Date().toISOString(),
  });
});

  // ── GET / ──────────────────────────────────────────────────────────────────
  // Serve the web viewer HTML. JavaScript in the page handles API calls.
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'web', 'index.html'));
  });

  // ── Start ──────────────────────────────────────────────────────────────────
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`[server] Web viewer: http://localhost:${config.port}/?token=${config.authToken}`);
  });

  return app;
}

module.exports = { startServer };
