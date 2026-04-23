/**
 * config.js
 *
 * Single source of truth for all settings.
 *
 * When running as a packaged .exe, data (screenshots, logs) is written to
 * app.getPath('userData') → %APPDATA%\ScreenMonitor\ on Windows.
 * When running in dev via `npm start`, data stays next to the source files.
 *
 * To customise settings in the packaged app, create a .env file inside
 * %APPDATA%\ScreenMonitor\ (e.g. TARGET_WINDOW_TITLE=Firefox).
 */

const path = require('path');
const { app } = require('electron');

// In production the app code lives inside a read-only .asar archive, so we
// must write user data to a writable OS location instead.
const isPackaged = app.isPackaged;
const dataDir = isPackaged ? app.getPath('userData') : __dirname;

// Load .env from the writable data directory so users can override settings
// without rebuilding the exe.
require('dotenv').config({ path: path.join(dataDir, '.env') });

module.exports = {
  // Partial window title to match (case-insensitive).
  targetWindowTitle: process.env.TARGET_WINDOW_TITLE || 'RustDesk',

  // Milliseconds between captures. Defaults to 1 minute.
  captureIntervalMs: (parseInt(process.env.CAPTURE_INTERVAL_MINUTES) || 1) * 60 * 1000,

  // Local Express server port.
  port: parseInt(process.env.PORT) || 3456,

  // Secret token required for all web viewer requests.
  authToken: process.env.AUTH_TOKEN || 'screenmonitor',

  // Where to save the latest screenshot (only one file is kept).
  screenshotPath: path.join(dataDir, 'screenshots', 'latest.png'),

  // Log file location.
  logPath: path.join(dataDir, 'logs', 'app.log'),

  // Expose the data directory so main.js can show it in the tray menu.
  dataDir,
};
