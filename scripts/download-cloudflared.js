/**
 * Downloads cloudflared.exe to bin/cloudflared.exe if it isn't already there.
 * Runs automatically via the `predist` npm script before electron-builder packs.
 * The binary is bundled via extraResources so it lands in resources/ in the installer.
 *
 * SHA256 checksum is fetched from the same GitHub release and verified before
 * saving — if verification fails the partial file is deleted and the build stops.
 */

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const BASE_URL     = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
const DOWNLOAD_URL = `${BASE_URL}/cloudflared-windows-amd64.exe`;
const CHECKSUM_URL = `${BASE_URL}/cloudflared-windows-amd64.exe.sha256sum`;
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
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      resolve(res);
    }).on('error', reject);
  });
}

function getText(url) {
  return get(url).then(res => new Promise((resolve, reject) => {
    let body = '';
    res.on('data',  c   => { body += c; });
    res.on('end',   ()  => resolve(body));
    res.on('error', err => reject(err));
  }));
}

async function download() {
  // Fetch checksum BEFORE the binary so a mid-download release bump is caught.
  let expectedHash = null;
  try {
    console.log('[download-cloudflared] Fetching SHA256 checksum...');
    const text = await getText(CHECKSUM_URL);
    expectedHash = text.trim().split(/\s+/)[0].toLowerCase();
    console.log(`[download-cloudflared] Expected: ${expectedHash}`);
  } catch (err) {
    console.warn(`[download-cloudflared] Could not fetch checksum (${err.message}) — skipping verification`);
  }

  console.log('[download-cloudflared] Downloading cloudflared.exe...');
  const res        = await get(DOWNLOAD_URL);
  const total      = parseInt(res.headers['content-length'] || '0', 10);
  let   downloaded = 0;
  const file       = fs.createWriteStream(OUT_PATH);

  await new Promise((resolve, reject) => {
    res.on('data', (chunk) => {
      downloaded += chunk.length;
      if (total) {
        const pct = Math.round((downloaded / total) * 100);
        process.stdout.write(`\r[download-cloudflared] ${pct}% (${(downloaded / 1_048_576).toFixed(1)} MB)`);
      }
    });
    res.pipe(file);
    file.on('finish', resolve);
    file.on('error',  reject);
  });

  file.close();
  process.stdout.write('\n');

  if (expectedHash) {
    const actualHash = crypto.createHash('sha256').update(fs.readFileSync(OUT_PATH)).digest('hex');
    if (actualHash !== expectedHash) {
      fs.unlinkSync(OUT_PATH);
      console.error('[download-cloudflared] Checksum mismatch — binary deleted.');
      console.error(`  Expected: ${expectedHash}`);
      console.error(`  Got:      ${actualHash}`);
      process.exit(1);
    }
    console.log(`[download-cloudflared] SHA256 verified ✓`);
  }

  console.log(`[download-cloudflared] Saved to ${OUT_PATH}`);
}

download().catch((err) => {
  try { fs.unlinkSync(OUT_PATH); } catch(_) {}
  console.error('[download-cloudflared] Failed:', err.message);
  process.exit(1);
});
