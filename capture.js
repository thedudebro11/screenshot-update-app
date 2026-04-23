/**
 * capture.js
 *
 * Captures a screenshot of a specific window (or the full screen as fallback)
 * using Electron's built-in desktopCapturer API.
 *
 * LIMITATIONS TO BE AWARE OF:
 * - Minimized windows produce an empty/blank thumbnail. The app detects this
 *   and reports it as an error rather than saving a blank image.
 * - Hardware-accelerated windows (some games, GPU-rendered UIs) may appear
 *   black in the thumbnail. This is a Windows/Electron limitation.
 * - UWP apps (Microsoft Store apps) may be blocked by Windows privacy settings.
 *   If so, those windows simply won't appear in the sources list.
 * - desktopCapturer must run in the Electron main process (Electron 17+).
 *
 * The function falls back to full-screen capture when the window is not found,
 * so you always get *something* to look at.
 */

const { desktopCapturer } = require('electron');

/**
 * @param {string} targetTitle  Partial window title to match (case-insensitive).
 * @param {boolean} fullscreenFallback  Capture full screen if window not found.
 * @returns {Promise<CaptureResult>}
 *
 * @typedef {Object} CaptureResult
 * @property {boolean} success
 * @property {Buffer}  [pngBuffer]       PNG image data when success=true
 * @property {string}  [windowName]      Actual matched window name
 * @property {boolean} [isFallback]      True when using full-screen fallback
 * @property {string}  [error]           Human-readable error when success=false
 * @property {string}  [availableWindows] Pipe-separated list of open window titles
 */
async function captureWindow(targetTitle, fullscreenFallback = true) {
  try {
    // Fetch thumbnails for all open windows.
    // thumbnailSize sets the resolution of each thumbnail — use the largest
    // reasonable size so the screenshot is actually useful to look at.
    const windowSources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 1920, height: 1080 },
      fetchWindowIcons: false, // not needed, saves a tiny bit of work
    });

    // Partial, case-insensitive match on window title.
    const target = windowSources.find(
      (s) => s.name && s.name.toLowerCase().includes(targetTitle.toLowerCase())
    );

    if (!target) {
      const availableWindows = windowSources
        .map((s) => s.name)
        .filter(Boolean)
        .join(' | ');

      if (!fullscreenFallback) {
        return {
          success: false,
          error: `Window "${targetTitle}" not found.`,
          availableWindows,
        };
      }

      // ── Full-screen fallback ───────────────────────────────────────────────
      const screenSources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 },
      });

      if (!screenSources.length) {
        return { success: false, error: 'No screen sources found.', availableWindows };
      }

      const pngBuffer = screenSources[0].thumbnail.toPNG();
      return {
        success: true,
        windowName: `Full Screen (fallback — "${targetTitle}" not found)`,
        pngBuffer,
        isFallback: true,
        availableWindows,
      };
    }

    // Convert NativeImage thumbnail to a raw PNG buffer.
    const pngBuffer = target.thumbnail.toPNG();

    // A very small buffer almost certainly means a blank/minimized window.
    // A real screenshot is at least a few KB.
    if (!pngBuffer || pngBuffer.length < 500) {
      return {
        success: false,
        error: `"${target.name}" was found but returned a blank image. The window may be minimized or fully off-screen.`,
      };
    }

    return {
      success: true,
      windowName: target.name,
      pngBuffer,
    };
  } catch (err) {
    return {
      success: false,
      error: `desktopCapturer threw: ${err.message}`,
    };
  }
}

module.exports = { captureWindow };
