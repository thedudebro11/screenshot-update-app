/**
 * main.js — Electron main process
 *
 * This is the entry point. It:
 *   1. Creates a system tray icon (the only UI — no app window)
 *   2. Starts the Express web server
 *   3. Spawns a Cloudflare Quick Tunnel for zero-config remote access
 *   4. Runs a screenshot capture immediately, then on a repeating interval
 *   5. Writes all activity to a log file
 *
 * There is intentionally no BrowserWindow. The app lives entirely in the
 * system tray. Right-click the tray icon to capture now or quit.
 */

const { app, Tray, Menu, nativeImage, shell, clipboard } = require('electron');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const config = require('./config');
const { captureWindow }            = require('./capture');
const { startServer }              = require('./server');
const { startTunnel }              = require('./tunnel');
const { autoUpdater }              = require('electron-updater');
const { alertFailure, alertRecovery } = require('./notify');

// ── Shared state (read by the Express server) ──────────────────────────────
const state = {
  lastCaptureTime:   null,       // ISO string — updated on every capture attempt
  lastCaptureStatus: 'pending',  // 'pending' | 'ok' | 'fallback' | 'error'
  lastError:         null,       // string or null
  availableWindows:  '',         // pipe-separated list for debugging
  tunnelUrl:         null,       // public Cloudflare URL once established
  lastCaptureHash:   null,       // SHA256 of last saved PNG — change detection
  consecutiveNonOk:  0,          // streak of non-ok captures for Discord alerting
  wasAlerting:       false,      // true after we've sent a failure alert
};

let tray           = null;
let captureInterval = null;
let tunnelProcess  = null;
let notifyClients  = () => {}; // replaced after startServer()

// ── Logging ────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(config.logPath, line + '\n');
  } catch (_) {
    // Swallow log errors so they never crash the main loop
  }
}

// ── Directory creation ─────────────────────────────────────────────────────
function ensureDirs() {
  for (const dir of [config.screenshotDir, path.dirname(config.logPath)]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

// ── Capture & save ─────────────────────────────────────────────────────────
async function doCapture() {
  log(`Capturing "${config.targetWindowTitle}"...`);

  const result = await captureWindow(config.targetWindowTitle, true);

  if (result.success) {
    // ── Change detection ───────────────────────────────────────────────
    const hash    = crypto.createHash('sha256').update(result.pngBuffer).digest('hex');
    const changed = hash !== state.lastCaptureHash;

    // Update status regardless — proves the app is alive in the web viewer
    state.lastCaptureTime   = new Date().toISOString();
    state.lastCaptureStatus = result.isFallback ? 'fallback' : 'ok';
    state.lastError         = null;
    state.availableWindows  = result.availableWindows || '';

    // ── Alert tracking ─────────────────────────────────────────────────
    if (result.isFallback) {
      // Window missing — count toward alert threshold
      state.consecutiveNonOk++;
      if (state.consecutiveNonOk === config.discordAlertAfter && !state.wasAlerting) {
        alertFailure(
          config.discordWebhookUrl,
          `"${config.targetWindowTitle}" not found — using full-screen fallback`,
          config.targetWindowTitle
        );
        state.wasAlerting = true;
        log(`Discord: failure alert sent (${config.discordAlertAfter} consecutive fallbacks)`);
      }
    } else {
      // True ok — reset streak and send recovery if we were alerting
      if (state.wasAlerting) {
        alertRecovery(config.discordWebhookUrl, config.targetWindowTitle);
        log('Discord: recovery alert sent');
      }
      state.consecutiveNonOk = 0;
      state.wasAlerting      = false;
    }

    // ── Skip save if nothing changed ───────────────────────────────────
    if (!changed) {
      log('No change detected — skipping save');
      return;
    }

    // ── Save new screenshot ────────────────────────────────────────────
    try {
      const ts       = Date.now();
      const filePath = path.join(config.screenshotDir, `${ts}.png`);
      fs.writeFileSync(filePath, result.pngBuffer);
      state.lastCaptureHash = hash;

      const all = fs.readdirSync(config.screenshotDir)
        .filter(f => /^\d+\.png$/.test(f))
        .sort();
      all.slice(0, Math.max(0, all.length - config.historyLimit))
        .forEach(f => fs.unlinkSync(path.join(config.screenshotDir, f)));

      log(`Saved: ${result.windowName} (${(result.pngBuffer.length / 1024).toFixed(1)} KB)`);
      notifyClients({ type: 'screenshot', t: ts });
    } catch (err) {
      state.lastCaptureStatus = 'error';
      state.lastError         = `Could not save file: ${err.message}`;
      log(`Save error: ${err.message}`);
    }

  } else {
    // ── Capture failed entirely ────────────────────────────────────────
    state.lastCaptureStatus = 'error';
    state.lastError         = result.error;
    state.availableWindows  = result.availableWindows || '';
    log(`Capture failed: ${result.error}`);
    if (result.availableWindows) log(`Available windows: ${result.availableWindows}`);

    state.consecutiveNonOk++;
    if (state.consecutiveNonOk === config.discordAlertAfter && !state.wasAlerting) {
      alertFailure(config.discordWebhookUrl, result.error, config.targetWindowTitle);
      state.wasAlerting = true;
      log(`Discord: failure alert sent (${config.discordAlertAfter} consecutive errors)`);
    }
  }
}

// ── PNG icon builder (no canvas, no extra packages) ────────────────────────
function createSolidColorPNG(width, height, r, g, b) {
  const zlib = require('zlib');

  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    row[1 + x * 3]     = r;
    row[1 + x * 3 + 1] = g;
    row[1 + x * 3 + 2] = b;
  }
  const rawData    = Buffer.concat(Array.from({ length: height }, () => row));
  const compressed = zlib.deflateSync(rawData);

  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[i] = c;
  }
  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function pngChunk(type, data) {
    const typeBytes = Buffer.from(type, 'ascii');
    const len       = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
    return Buffer.concat([len, typeBytes, data, crcBuf]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width,  0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Tray menu ──────────────────────────────────────────────────────────────
function buildMenu(tunnelUrl = null) {
  const localUrl  = `http://localhost:${config.port}/?token=${config.authToken}`;
  const remoteUrl = tunnelUrl ? `${tunnelUrl}/?token=${config.authToken}` : null;

  const items = [
    { label: 'ScreenMonitor', enabled: false },
    { label: `Token: ${config.authToken}`, enabled: false },
    { type: 'separator' },
    { label: 'Capture Now', click: () => doCapture() },
    { type: 'separator' },
    { label: 'Open Viewer (Local)',  click: () => shell.openExternal(localUrl) },
  ];

  if (remoteUrl) {
    items.push(
      { label: 'Open Viewer (Remote)', click: () => shell.openExternal(remoteUrl) },
      { label: 'Copy Remote URL',      click: () => clipboard.writeText(remoteUrl) }
    );
  } else {
    items.push({ label: 'Remote: connecting...', enabled: false });
  }

  items.push(
    { type: 'separator' },
    { label: 'Open Data Folder', click: () => shell.openPath(config.dataDir) },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        clearInterval(captureInterval);
        tunnelProcess?.stop();
        app.quit();
      },
    }
  );

  return Menu.buildFromTemplate(items);
}

// ── Tray icon ──────────────────────────────────────────────────────────────
function createTray() {
  const pngBuffer = createSolidColorPNG(32, 32, 34, 197, 94);
  const icon      = nativeImage.createFromBuffer(pngBuffer);

  tray = new Tray(icon);
  tray.setToolTip('ScreenMonitor — right-click for options');
  tray.setContextMenu(buildMenu());

  const localUrl = `http://localhost:${config.port}/?token=${config.authToken}`;
  tray.displayBalloon({
    title:    'ScreenMonitor is running',
    content:  `Local viewer: ${localUrl}\n\nWaiting for remote tunnel...`,
    iconType: 'info',
    noSound:  true,
  });
}

// ── App startup ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  app.setAppUserModelId('com.screenmonitor.app');
  app.setLoginItemSettings({ openAtLogin: true });

  ensureDirs();
  log('=== ScreenMonitor starting ===');
  log(`Target window title: "${config.targetWindowTitle}"`);
  log(`Capture interval: ${config.captureIntervalMs / 60000} min`);
  log(`Web viewer: http://localhost:${config.port}/?token=${config.authToken}`);
  log(`Screenshot path: ${config.screenshotPath}`);

  ({ notifyClients } = startServer({
    getState:          () => state,
    screenshotDir:     config.screenshotDir,
    targetWindowTitle: config.targetWindowTitle,
  }));

  createTray();

  // Start Cloudflare Quick Tunnel — updates tray menu once URL is live.
  tunnelProcess = startTunnel(config.port, (tunnelUrl) => {
    state.tunnelUrl = tunnelUrl;
    log(`Tunnel live: ${tunnelUrl}`);
    tray.setContextMenu(buildMenu(tunnelUrl));
    tray.displayBalloon({
      title:    'Remote access ready',
      content:  `Share this URL:\n${tunnelUrl}/?token=${config.authToken}`,
      iconType: 'info',
      noSound:  true,
    });
  }, log);

  // Check for updates silently in the background (packaged builds only).
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify();
    autoUpdater.on('update-downloaded', () => {
      log('Update downloaded — will install on next restart');
      tray.displayBalloon({
        title:    'ScreenMonitor update ready',
        content:  'A new version has been downloaded. Restart the app to apply it.',
        iconType: 'info',
        noSound:  true,
      });
    });
  }

  setTimeout(doCapture, 2500);
  captureInterval = setInterval(doCapture, config.captureIntervalMs);
});

// ── Keep alive ─────────────────────────────────────────────────────────────
app.on('window-all-closed', () => {
  // Intentionally empty — do not quit.
});
