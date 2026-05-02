/**
 * notify.js — Discord webhook notifications
 *
 * Fire-and-forget. Errors are silently swallowed so a bad webhook URL or
 * network hiccup never interrupts the capture loop.
 */

const https   = require('https');
const http    = require('http');
const { URL } = require('url');

function post(webhookUrl, embed) {
  if (!webhookUrl) return;
  const payload = JSON.stringify({ embeds: [embed] });
  try {
    const u      = new URL(webhookUrl);
    const client = u.protocol === 'https:' ? https : http;
    const req    = client.request({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    });
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch(_) {}
}

function alertFailure(webhookUrl, reason, target) {
  post(webhookUrl, {
    title:       '⚠️ ScreenMonitor Alert',
    description: `**Target:** \`${target}\`\n**Issue:** ${reason}`,
    color:       0xE74C3C,
    timestamp:   new Date().toISOString(),
    footer:      { text: 'ScreenMonitor' },
  });
}

function alertRecovery(webhookUrl, target) {
  post(webhookUrl, {
    title:       '✅ ScreenMonitor Recovered',
    description: `**Target:** \`${target}\`\nCapture is back to normal.`,
    color:       0x22C55E,
    timestamp:   new Date().toISOString(),
    footer:      { text: 'ScreenMonitor' },
  });
}

module.exports = { alertFailure, alertRecovery };
