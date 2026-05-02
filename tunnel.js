/**
 * tunnel.js — Cloudflare Quick Tunnel manager
 *
 * Spawns cloudflared and parses its output to extract the public HTTPS URL.
 * The URL is delivered via the onUrl callback once cloudflare establishes
 * the connection (usually within 5–10 seconds).
 *
 * Quick Tunnels require no Cloudflare account or configuration.
 */

const { app }  = require('electron');
const { spawn } = require('child_process');
const path     = require('path');
const fs       = require('fs');

const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const TIMEOUT_MS    = 40_000;

function getBinaryPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'cloudflared.exe');
  }
  return path.join(__dirname, 'bin', 'cloudflared.exe');
}

/**
 * @param {number}   port   - Local Express port to tunnel to
 * @param {Function} onUrl  - Called once with the public tunnel URL string
 * @param {Function} onLog  - Called with log lines (forwarded to main.js logger)
 * @returns {{ stop: () => void }}
 */
function startTunnel(port, onUrl, onLog) {
  const binary = getBinaryPath();

  if (!fs.existsSync(binary)) {
    onLog(`[tunnel] cloudflared not found at ${binary} — skipping remote access`);
    return { stop: () => {} };
  }

  const proc = spawn(
    binary,
    ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'],
    { windowsHide: true }
  );

  let urlFound = false;

  const timeout = setTimeout(() => {
    if (!urlFound) onLog('[tunnel] Timed out waiting for tunnel URL (40s)');
  }, TIMEOUT_MS);

  function handleChunk(data) {
    if (urlFound) return;
    const text  = data.toString();
    const match = text.match(TUNNEL_URL_RE);
    if (match) {
      urlFound = true;
      clearTimeout(timeout);
      onUrl(match[0]);
    }
  }

  proc.stdout.on('data', handleChunk);
  proc.stderr.on('data', handleChunk);

  proc.on('error', (err) => {
    clearTimeout(timeout);
    onLog(`[tunnel] Failed to start cloudflared: ${err.message}`);
  });

  proc.on('exit', (code) => {
    clearTimeout(timeout);
    if (code !== 0 && code !== null) {
      onLog(`[tunnel] cloudflared exited unexpectedly (code ${code})`);
    }
  });

  return {
    stop: () => {
      if (!proc.killed) proc.kill();
    },
  };
}

module.exports = { startTunnel };
