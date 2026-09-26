'use strict';

const https = require('https');

function probeOutbound() {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = https.get('https://example.com/', { timeout: 4000 }, (res) => {
      res.resume();
      resolve({
        ok: true,
        outbound: true,
        via: 'direct',
        checks: [{ host: 'example.com', ok: true, ms: Date.now() - t0, status: res.statusCode }]
      });
    });
    req.on('error', (err) => {
      resolve({
        ok: false,
        outbound: false,
        via: 'direct',
        checks: [{ host: 'example.com', ok: false, error: err.message }]
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({
        ok: false,
        outbound: false,
        via: 'direct',
        checks: [{ host: 'example.com', ok: false, error: 'timeout' }]
      });
    });
  });
}

module.exports = { probeOutbound };
