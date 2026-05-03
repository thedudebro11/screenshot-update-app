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

const { app, Tray, Menu, nativeImage, shell, clipboard, dialog } = require('electron');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const config = require('./config');
const { captureWindow }               = require('./capture');
const { startServer }                 = require('./server');
const { startTunnel }                 = require('./tunnel');
const { autoUpdater }                 = require('electron-updater');
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
  targetWindowTitle: config.targetWindowTitle, // mirrors config; updated by setTargetWindow
  captureIntervalMs: config.captureIntervalMs, // mirrors config; updated by setCaptureInterval
};

let tray            = null;
let captureInterval = null;
let tunnelProcess   = null;
let notifyClients   = () => {};  // replaced after startServer()
let isCapturing     = false;     // concurrency guard — prevents overlapping captures
let updateReady     = false;     // true when electron-updater has a downloaded update
let windowList      = [];        // latest known open windows for tray submenu

// ── Logging ────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    // Rotate at 5 MB so the log never grows unbounded.
    try {
      if (fs.statSync(config.logPath).size > 5 * 1024 * 1024) {
        fs.renameSync(config.logPath, config.logPath + '.old');
      }
    } catch (_) {}
    fs.appendFileSync(config.logPath, line + '\n');
  } catch (_) {
    // Swallow log errors so they never crash the main loop.
  }
}

// ── Directory creation ─────────────────────────────────────────────────────
function ensureDirs() {
  for (const dir of [config.screenshotDir, path.dirname(config.logPath)]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

// ── Tray tooltip helper ────────────────────────────────────────────────────
function relTimeTray(iso) {
  if (!iso) return 'never';
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 5)     return 'just now';
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function updateTooltip() {
  if (!tray) return;
  const elapsed = relTimeTray(state.lastCaptureTime);
  const label   = { ok: 'OK', fallback: 'FALLBACK', error: 'ERROR', pending: 'PENDING' }[state.lastCaptureStatus] || 'PENDING';
  tray.setToolTip(`ScreenMonitor — ${config.targetWindowTitle || 'Full Screen'}\nLast: ${elapsed} (${label})`);
}

// ── Capture & save ─────────────────────────────────────────────────────────
async function doCapture() {
  if (isCapturing) {
    log('Capture skipped — previous capture still running');
    return;
  }
  isCapturing = true;

  try {
    log(`Capturing "${config.targetWindowTitle || 'Full Screen'}"...`);

    const result = await captureWindow(config.targetWindowTitle, true);

    // Keep window list fresh for the "Set Target Window" tray submenu.
    const rawList = (result.availableWindows || '').split(' | ').filter(Boolean);
    if (rawList.length > 0 && rawList.join('|') !== windowList.join('|')) {
      windowList = rawList;
      tray.setContextMenu(buildMenu(state.tunnelUrl));
    }

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
        if (state.wasAlerting) {
          alertRecovery(config.discordWebhookUrl, config.targetWindowTitle);
          log('Discord: recovery alert sent');
        }
        state.consecutiveNonOk = 0;
        state.wasAlerting      = false;
      }

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
  } catch (err) {
    // Outer guard — captureWindow() itself shouldn't throw, but just in case.
    log(`Unexpected capture error: ${err.message}`);
    state.lastCaptureStatus = 'error';
    state.lastError         = `Unexpected error: ${err.message}`;
  } finally {
    isCapturing = false;
    updateTooltip();
  }
}

// ── Change target window at runtime (no restart needed) ────────────────────
function setTargetWindow(name) {
  const envPath = path.join(config.dataDir, '.env');
  try {
    let content = '';
    try { content = fs.readFileSync(envPath, 'utf8'); } catch(_) {}
    if (/^TARGET_WINDOW_TITLE=.*$/m.test(content)) {
      content = content.replace(/^TARGET_WINDOW_TITLE=.*$/m, `TARGET_WINDOW_TITLE=${name}`);
    } else {
      content = content.trimEnd() + `\nTARGET_WINDOW_TITLE=${name}\n`;
    }
    fs.writeFileSync(envPath, content);
  } catch (err) {
    log(`Could not update .env: ${err.message}`);
  }
  config.targetWindowTitle  = name;
  state.targetWindowTitle   = name;
  log(`Target window changed to: "${name}"`);
  tray.setContextMenu(buildMenu(state.tunnelUrl));
  doCapture();
}

// ── Change capture interval at runtime ────────────────────────────────────
function setCaptureInterval(minutes) {
  const ms = Math.round(minutes * 60 * 1000);
  config.captureIntervalMs  = ms;
  state.captureIntervalMs   = ms;

  clearInterval(captureInterval);
  captureInterval = setInterval(doCapture, ms);

  const envPath = path.join(config.dataDir, '.env');
  try {
    let content = '';
    try { content = fs.readFileSync(envPath, 'utf8'); } catch(_) {}
    if (/^CAPTURE_INTERVAL_MINUTES=.*$/m.test(content)) {
      content = content.replace(/^CAPTURE_INTERVAL_MINUTES=.*$/m, `CAPTURE_INTERVAL_MINUTES=${minutes}`);
    } else {
      content = content.trimEnd() + `\nCAPTURE_INTERVAL_MINUTES=${minutes}\n`;
    }
    fs.writeFileSync(envPath, content);
  } catch (err) {
    log(`Could not write interval to .env: ${err.message}`);
  }

  log(`Capture interval changed to ${minutes} minute(s)`);
  tray.setContextMenu(buildMenu(state.tunnelUrl));
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

  // Submenu listing every open window — user clicks one to switch the target.
  // Populated from the last capture result; shows a placeholder on first start.
  const fullScreenItem = {
    label:   'Full Screen (entire desktop)',
    type:    'radio',
    checked: !config.targetWindowTitle,
    click:   () => setTargetWindow(''),
  };
  const windowItems = [
    fullScreenItem,
    ...(windowList.length > 0
      ? windowList.map(name => ({
          label:   name.length > 50 ? name.slice(0, 47) + '…' : name,
          type:    'radio',
          checked: !!config.targetWindowTitle && name.toLowerCase().includes(config.targetWindowTitle.toLowerCase()),
          click:   () => setTargetWindow(name),
        }))
      : [{ label: 'Capture once to populate list', enabled: false }]),
  ];

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

  const currentMinutes = config.captureIntervalMs / 60000;
  const intervalOptions = [
    { label: '30 seconds', value: 0.5  },
    { label: '1 minute',   value: 1    },
    { label: '2 minutes',  value: 2    },
    { label: '5 minutes',  value: 5    },
    { label: '10 minutes', value: 10   },
    { label: '30 minutes', value: 30   },
  ];
  const intervalItems = intervalOptions.map(({ label, value }) => ({
    label,
    type:    'radio',
    checked: Math.abs(currentMinutes - value) < 0.01,
    click:   () => setCaptureInterval(value),
  }));

  items.push(
    { type: 'separator' },
    { label: `Watching: ${config.targetWindowTitle || 'Full Screen'}`, enabled: false },
    { label: 'Set Target Window', submenu: windowItems },
    { label: 'Capture Interval',  submenu: intervalItems },
    { type: 'separator' },
    { label: 'Open Data Folder', click: () => shell.openPath(config.dataDir) },
    { type: 'separator' }
  );

  if (updateReady) {
    items.push(
      { label: 'Restart to Apply Update', click: () => autoUpdater.quitAndInstall() },
      { type: 'separator' }
    );
  }

  items.push({
    label: 'Quit',
    click: () => {
      clearInterval(captureInterval);
      tunnelProcess?.stop();
      app.quit();
    },
  });

  return Menu.buildFromTemplate(items);
}

// ── Tray icon ──────────────────────────────────────────────────────────────
function createTray() {
  const pngBuffer = createSolidColorPNG(32, 32, 34, 197, 94);
  const icon      = nativeImage.createFromBuffer(pngBuffer);

  tray = new Tray(icon);
  tray.setToolTip('ScreenMonitor — starting...');
  tray.setContextMenu(buildMenu());

  const localUrl = `http://localhost:${config.port}/?token=${config.authToken}`;
  tray.displayBalloon({
    title:    'ScreenMonitor is running',
    content:  `Local viewer:\n${localUrl}\n\nWaiting for remote tunnel...`,
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
  log(`Screenshot directory: ${config.screenshotDir}`);

  ({ notifyClients } = startServer({
    getState:          () => state,
    screenshotDir:     config.screenshotDir,
    targetWindowTitle: config.targetWindowTitle,
    onIntervalChange:  (minutes) => setCaptureInterval(minutes),
    onError: (err) => {
      log(`Server error: ${err.message}`);
      if (err.code === 'EADDRINUSE') {
        dialog.showErrorBox(
          'ScreenMonitor — Already Running',
          `Port ${config.port} is already in use.\n\nScreenMonitor is likely already running — check the system tray (bottom-right of the taskbar).`
        );
      }
      app.quit();
    },
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
      updateReady = true;
      log('Update downloaded — restart to apply');
      tray.setContextMenu(buildMenu(state.tunnelUrl));
      tray.displayBalloon({
        title:    'ScreenMonitor update ready',
        content:  'Right-click the tray icon → "Restart to Apply Update".',
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
