/**
 * Downloads cloudflared.exe to bin/cloudflared.exe if it isn't already there.
 * Runs automatically via the `predist` npm script before electron-builder packs.
 * The binary is bundled via extraResources so it lands in resources/ in the installer.
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const DOWNLOAD_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
const OUT_PATH     = path.join(__dirname, '..', 'bin', 'cloudflared.exe');

if (fs.existsSync(OUT_PATH)) {
  console.log('[download-cloudflared] Already present, skipping download.');
  process.exit(0);
}

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('Too many redirects'));
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location, redirects + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      resolve(res);
    }).on('error', reject);
  });
}

console.log('[download-cloudflared] Downloading cloudflared.exe...');

get(DOWNLOAD_URL).then((res) => {
  const total      = parseInt(res.headers['content-length'] || '0', 10);
  let   downloaded = 0;
  const file       = fs.createWriteStream(OUT_PATH);

  res.on('data', (chunk) => {
    downloaded += chunk.length;
    if (total) {
      const pct = Math.round((downloaded / total) * 100);
      process.stdout.write(`\r[download-cloudflared] ${pct}% (${(downloaded / 1_048_576).toFixed(1)} MB)`);
    }
  });

  res.pipe(file);
  file.on('finish', () => {
    file.close();
    console.log(`\n[download-cloudflared] Saved to ${OUT_PATH}`);
  });
  file.on('error', (err) => {
    fs.unlinkSync(OUT_PATH);
    console.error('[download-cloudflared] Write error:', err.message);
    process.exit(1);
  });
}).catch((err) => {
  console.error('[download-cloudflared] Download failed:', err.message);
  process.exit(1);
});
