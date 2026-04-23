/**
 * main.js — Electron main process
 *
 * This is the entry point. It:
 *   1. Creates a system tray icon (the only UI — no app window)
 *   2. Starts the Express web server
 *   3. Runs a screenshot capture immediately, then on a repeating interval
 *   4. Writes all activity to a log file
 *
 * There is intentionally no BrowserWindow. The app lives entirely in the
 * system tray. Right-click the tray icon to capture now or quit.
 */

const { app, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { captureWindow } = require('./capture');
const { startServer } = require('./server');

// ── Shared state (read by the Express server) ──────────────────────────────
const state = {
  lastCaptureTime: null,       // ISO string — set only on successful save
  lastCaptureStatus: 'pending', // 'pending' | 'ok' | 'fallback' | 'error'
  lastError: null,              // string or null
  availableWindows: '',         // pipe-separated list for debugging
};

let tray = null;
let captureInterval = null;

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
  for (const filePath of [config.screenshotPath, config.logPath]) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

// ── Capture & save ─────────────────────────────────────────────────────────
async function doCapture() {
  log(`Capturing "${config.targetWindowTitle}"...`);

  const result = await captureWindow(config.targetWindowTitle, true);

  if (result.success) {
    try {
      fs.writeFileSync(config.screenshotPath, result.pngBuffer);
      state.lastCaptureTime = new Date().toISOString();
      state.lastCaptureStatus = result.isFallback ? 'fallback' : 'ok';
      state.lastError = null;
      state.availableWindows = result.availableWindows || '';
      log(`Saved: ${result.windowName} (${(result.pngBuffer.length / 1024).toFixed(1)} KB)`);
    } catch (err) {
      state.lastCaptureStatus = 'error';
      state.lastError = `Could not save file: ${err.message}`;
      log(`Save error: ${err.message}`);
    }
  } else {
    state.lastCaptureStatus = 'error';
    state.lastError = result.error;
    state.availableWindows = result.availableWindows || '';
    log(`Capture failed: ${result.error}`);
    if (result.availableWindows) {
      log(`Available windows: ${result.availableWindows}`);
    }
  }
}

// ── PNG icon builder (no canvas, no extra packages) ────────────────────────
function createSolidColorPNG(width, height, r, g, b) {
  const zlib = require('zlib');

  // Build one row: filter byte (0 = None) followed by RGB triplets
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = r;
    row[1 + x * 3 + 1] = g;
    row[1 + x * 3 + 2] = b;
  }
  const rawData = Buffer.concat(Array.from({ length: height }, () => row));
  const compressed = zlib.deflateSync(rawData);

  // CRC32 (required by PNG spec for every chunk)
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
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
    return Buffer.concat([len, typeBytes, data, crcBuf]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Tray icon ──────────────────────────────────────────────────────────────
function createTray() {
  // Build a 32×32 green icon entirely in memory — no asset file needed.
  const pngBuffer = createSolidColorPNG(32, 32, 34, 197, 94); // green
  const icon = nativeImage.createFromBuffer(pngBuffer);

  tray = new Tray(icon);
  tray.setToolTip('Screen Monitor — right-click for options');

  const viewerUrl = `http://localhost:${config.port}/?token=${config.authToken}`;

  const menu = Menu.buildFromTemplate([
    { label: 'Screen Monitor', enabled: false },
    { label: `Token: ${config.authToken}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Capture Now',
      click: () => doCapture(),
    },
    {
      label: 'Open Web Viewer',
      click: () => shell.openExternal(viewerUrl),
    },
    {
      label: 'Open Data Folder',
      click: () => shell.openPath(config.dataDir),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        clearInterval(captureInterval);
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);

  // Show a balloon so the user knows where to find the app on first launch.
  // Windows may hide new tray icons in the overflow — this nudges them to look.
  tray.displayBalloon({
    title: 'Screen Monitor is running',
    content: `Web viewer: ${viewerUrl}\n\nRight-click the green icon near your clock for options.`,
    iconType: 'info',
    noSound: true,
  });
}

// ── App startup ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Prevents Electron from creating a taskbar button — tray only.
  app.setAppUserModelId('com.screenmonitor.app');

  ensureDirs();
  log('=== Screen Monitor starting ===');
  log(`Target window title: "${config.targetWindowTitle}"`);
  log(`Capture interval: ${config.captureIntervalMs / 60000} min`);
  log(`Web viewer: http://localhost:${config.port}/?token=${config.authToken}`);
  log(`Screenshot path: ${config.screenshotPath}`);

  // Start the Express web server
  startServer({
    getState: () => state,
    screenshotPath: config.screenshotPath,
    targetWindowTitle: config.targetWindowTitle,
  });

  // System tray icon + context menu
  createTray();

  // First capture shortly after startup (gives the OS a moment to settle)
  setTimeout(doCapture, 2500);

  // Recurring capture on the configured interval
  captureInterval = setInterval(doCapture, config.captureIntervalMs);
});

// ── Keep alive ─────────────────────────────────────────────────────────────
// Electron quits automatically when all BrowserWindows close.
// Since we have no windows, we MUST override this to stay alive.
app.on('window-all-closed', () => {
  // Intentionally empty — do not quit.
});
