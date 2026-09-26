'use strict';

const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const { URL } = require('url');
const engine = require('./engine-manager');
const cdp = require('./cdp-control');

function mark(ok) {
  return ok ? 'PASS' : 'FAIL';
}

function requestOnce(urlString, family) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(urlString); } catch (err) {
      return resolve({ ok: false, error: err.message });
    }
    const lib = url.protocol === 'https:' ? https : http;
    const t0 = Date.now();
    const req = lib.get({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      family: family || undefined,
      timeout: 4000,
      headers: { 'User-Agent': 'SoloHostBrowser/6.2' }
    }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode < 500, status: res.statusCode, ms: Date.now() - t0, family: family || 'auto' });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message, family: family || 'auto' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout', family: family || 'auto' }); });
  });
}

function proxyFlags() {
  const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy'];
  const present = names.filter((n) => process.env[n]);
  return {
    present: present.length > 0,
    names: present,
    chromiumUsesProxy: process.env.CHROMIUM_USE_PROXY === '1'
  };
}

async function collect() {
  let dnsOk = false;
  let dnsError = null;
  try {
    const r = await dns.lookup('example.com');
    dnsOk = !!(r && r.address);
  } catch (err) {
    dnsError = err.message;
  }
  const httpsAuto = await requestOnce('https://example.com/');
  const ipv4 = await requestOnce('https://example.com/', 4);
  const ipv6 = await requestOnce('https://example.com/', 6);
  const proxy = proxyFlags();
  const snap = engine.snapshot();
  let chromium = { ok: false, error: 'engine not ready' };
  if (snap.status === 'ready' || snap.status === 'degraded') {
    chromium = await cdp.probe('https://example.com/');
  }
  return {
    containerNetwork: mark(httpsAuto.ok || ipv4.ok),
    dns: mark(dnsOk),
    https: mark(httpsAuto.ok),
    chromium: mark(!!chromium.ok),
    proxy: proxy.present ? (proxy.chromiumUsesProxy ? 'SET' : 'ISOLATED') : 'NONE',
    ipv4: mark(ipv4.ok),
    ipv6: ipv6.ok ? 'PASS' : (ipv6.error ? 'FAIL' : 'FAIL'),
    node: mark(httpsAuto.ok || ipv4.ok),
    details: {
      dnsError,
      httpsAuto,
      ipv4,
      ipv6,
      proxy,
      chromium,
      engine: {
        status: snap.status,
        binary: snap.binary,
        profile: snap.profile,
        args: snap.args,
        error: snap.error
      }
    }
  };
}

module.exports = { collect };
