'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const dns = require('dns');
const { URL } = require('url');

const MAX_HTML = 8 * 1024 * 1024;
const MAX_BODY = 4 * 1024 * 1024;
const UA = 'Mozilla/5.0 (compatible; SoloHostBrowser/2.2; +local-gateway)';

function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return (
    p[0] === 10 ||
    p[0] === 127 ||
    p[0] === 0 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
  );
}

function isPrivateIP(ip) {
  const value = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (value.includes(':')) {
    const compact = value.replace(/^::ffff:/, '');
    if (/^\d+\.\d+\.\d+\.\d+$/.test(compact)) return isPrivateIPv4(compact);
    return (
      value === '::1' ||
      value === '::' ||
      value.startsWith('fc') ||
      value.startsWith('fd') ||
      value.startsWith('fe80:')
    );
  }
  return isPrivateIPv4(value);
}

function publicOrigin(req) {
  const rawProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
    .replace(/:$/, '');
  const proto = rawProto === 'https' ? 'https' : 'http';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1')
    .split(',')[0]
    .trim();
  return `${proto}://${host}`;
}

function proxyBaseFromReq(req) {
  return `${publicOrigin(req)}/api/proxy`;
}

function validateTarget(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only HTTP(S) URLs are supported');
  if (u.username || u.password) throw new Error('Credentials in URL are not supported');
  return u;
}

function blockedHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (isPrivateIP(host)) return true;
  return false;
}

// Node's dns.lookup() has no built-in timeout. In some Docker/network setups
// (custom internal networks, a misconfigured or unreachable resolver, some
// VPN-on-host configurations) a broken DNS server doesn't error, it just
// never answers — the request would otherwise hang until the outer HTTP
// timeout, making a real DNS problem look identical to a generic slow page.
// We cap it explicitly so the error is fast and points at the actual cause.
const DNS_TIMEOUT_MS = 6000;

function lookupAddresses(hostname) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('DNS lookup timed out — check the container\'s DNS/network configuration'));
    }, DNS_TIMEOUT_MS);
    dns.lookup(hostname, { all: true, verbatim: true }, (err, records) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) return reject(err);
      const list = Array.isArray(records) ? records : [];
      const v4 = list.filter((r) => r.family === 4);
      const v6 = list.filter((r) => r.family === 6);
      resolve(v4.concat(v6));
    });
  });
}

async function resolvePublicHost(hostname) {
  if (blockedHost(hostname)) throw new Error('Blocked local host');
  const records = await lookupAddresses(hostname);
  const publicRecords = records.filter((r) => !isPrivateIP(r.address));
  if (!publicRecords.length) throw new Error('Blocked private address');
  return publicRecords;
}

function envProxyFor(targetUrl) {
  const noProxy = String(process.env.NO_PROXY || process.env.no_proxy || '');
  if (matchesNoProxy(targetUrl.hostname, noProxy)) return null;
  const raw =
    targetUrl.protocol === 'https:'
      ? process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
      : process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy;
  if (!raw) return null;
  try {
    return new URL(raw.includes('://') ? raw : `http://${raw}`);
  } catch {
    return null;
  }
}

function matchesNoProxy(host, noProxy) {
  if (!noProxy) return false;
  const h = String(host).toLowerCase();
  return noProxy.split(',').some((item) => {
    const rule = item.trim().toLowerCase();
    if (!rule) return false;
    if (rule === '*') return true;
    if (rule.startsWith('.')) return h.endsWith(rule) || h === rule.slice(1);
    return h === rule || h.endsWith('.' + rule);
  });
}

function proxyUrlFor(base, target) {
  return `${String(base).replace(/\/$/, '')}?url=${encodeURIComponent(target)}`;
}

function absoluteUrl(value, base) {
  try {
    const raw = String(value || '').trim();
    if (!raw || raw.startsWith('#') || /^(?:javascript|mailto|tel|data|blob):/i.test(raw)) return null;
    const u = new URL(raw, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.href;
  } catch {
    return null;
  }
}

function rewriteSrcset(value, base, proxyBase) {
  return String(value)
    .split(',')
    .map((part) => {
      const m = part.trim().match(/^(\S+)(.*)$/);
      if (!m) return part;
      const abs = absoluteUrl(m[1], base);
      return abs ? `${proxyUrlFor(proxyBase, abs)}${m[2] || ''}` : part;
    })
    .join(', ');
}

function rewriteCss(css, targetUrl, proxyBase) {
  return String(css)
    .replace(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi, (full, quote, value) => {
      const abs = absoluteUrl(value, targetUrl);
      return abs ? `url("${proxyUrlFor(proxyBase, abs)}")` : full;
    })
    .replace(/@import\s+(?:url\(\s*)?(['"])(.*?)\1\s*\)?/gi, (full, quote, value) => {
      const abs = absoluteUrl(value, targetUrl);
      return abs ? `@import "${proxyUrlFor(proxyBase, abs)}"` : full;
    });
}

function rewriteHtml(html, targetUrl, proxyBase) {
  let out = String(html);
  out = out.replace(/\b(href|src|action|poster)\s*=\s*(["'])(.*?)\2/gi, (full, attr, quote, value) => {
    const abs = absoluteUrl(value, targetUrl);
    if (!abs) return full;
    return `${attr}=${quote}${proxyUrlFor(proxyBase, abs)}${quote}`;
  });
  out = out.replace(/\bsrcset\s*=\s*(["'])(.*?)\1/gi, (full, quote, value) => {
    return `srcset=${quote}${rewriteSrcset(value, targetUrl, proxyBase)}${quote}`;
  });
  out = out.replace(
    /(<meta\b[^>]*http-equiv\s*=\s*["']refresh["'][^>]*content\s*=\s*["'][^"']*url=)([^"']+)/gi,
    (full, prefix, value) => {
      const abs = absoluteUrl(value.trim(), targetUrl);
      return abs ? `${prefix}${proxyUrlFor(proxyBase, abs)}` : full;
    }
  );
  out = out.replace(/<base\b[^>]*>/gi, '');
  out = out.replace(
    /<meta\b[^>]*(?:http-equiv\s*=\s*["']Content-Security-Policy["']|name\s*=\s*["']content-security-policy["'])[^>]*>/gi,
    ''
  );
  const boot = `<script>(function(){try{var P=${JSON.stringify(proxyBase)};var T=${JSON.stringify(targetUrl)};document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href]');if(!a)return;var h=a.getAttribute('href');if(!h||/^(?:#|javascript:|mailto:|tel:|data:|blob:)/i.test(h))return;var u;try{u=new URL(h,T);}catch(err){return;}if(/^https?:$/i.test(u.protocol)){e.preventDefault();location.href=P+'?url='+encodeURIComponent(u.href);}},true);}catch(e){}})();</script>`;
  if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, `${boot}</body>`);
  else out += boot;
  return out;
}

// `content-length` is stripped here unconditionally because it used to be
// wrong for HTML/CSS (we rewrite the body, changing its byte length). But
// for everything else — images, video, audio, downloads — we pipe the body
// through untouched, so the original Content-Length is still accurate and
// dropping it needlessly breaks standard browser behavior: <video>/<audio>
// can't report duration/buffered range as reliably, and downloads lose their
// progress bar / size estimate. requestOverSocket() also tells upstream we
// don't accept compression (no accept-encoding), so there is no
// content-encoding mismatch risk in keeping it.
function stripHopByHop(headers, { keepContentLength = false } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (/^content-length$/i.test(k)) {
      if (keepContentLength) out[k] = v;
      continue;
    }
    if (
      /^(connection|keep-alive|proxy-authenticate|proxy-authorization|te|trailer|transfer-encoding|upgrade|content-encoding)$/i.test(
        k
      )
    ) {
      continue;
    }
    if (/^(x-frame-options|content-security-policy|content-security-policy-report-only)$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function gatewayErrorPage(title, detail) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0c0d10;color:#eceae6;font-family:Inter,ui-sans-serif,system-ui,sans-serif;padding:32px;text-align:center}
h1{font-weight:400;font-size:18px;letter-spacing:.04em;margin:0 0 8px}
p{color:#8a8680;font-size:13px;line-height:1.5;margin:0}
</style></head><body><main><h1>${title}</h1><p>${detail}</p></main></body></html>`;
}

function connectDirect(target, record) {
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  const isTls = target.protocol === 'https:';
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: record.address, port, family: record.family }, () => {
      if (!isTls) return resolve(socket);
      const secure = tls.connect({
        socket,
        servername: target.hostname,
        ALPNProtocols: ['http/1.1']
      });
      secure.once('secureConnect', () => resolve(secure));
      secure.once('error', reject);
    });
    socket.setTimeout(12000, () => {
      socket.destroy();
      reject(new Error('connect timeout'));
    });
    socket.once('error', reject);
  });
}

function connectThroughEnvProxy(proxy, target) {
  const isTls = target.protocol === 'https:';
  const destPort = Number(target.port || (isTls ? 443 : 80));
  const proxyPort = Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80));
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.hostname, port: proxyPort }, () => {
      if (!isTls) return resolve(socket);
      let auth = '';
      if (proxy.username) {
        const token = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password || '')}`).toString('base64');
        auth = `Proxy-Authorization: Basic ${token}\r\n`;
      }
      socket.write(`CONNECT ${target.hostname}:${destPort} HTTP/1.1\r\nHost: ${target.hostname}:${destPort}\r\n${auth}\r\n`);
      let buf = '';
      const onData = (chunk) => {
        buf += chunk.toString('latin1');
        if (!buf.includes('\r\n\r\n')) return;
        socket.removeListener('data', onData);
        if (!/^HTTP\/1\.[01] 200/i.test(buf)) {
          socket.destroy();
          return reject(new Error('proxy CONNECT failed'));
        }
        const secure = tls.connect({ socket, servername: target.hostname, ALPNProtocols: ['http/1.1'] });
        secure.once('secureConnect', () => resolve(secure));
        secure.once('error', reject);
      };
      socket.on('data', onData);
    });
    socket.setTimeout(12000, () => {
      socket.destroy();
      reject(new Error('proxy timeout'));
    });
    socket.once('error', reject);
  });
}

async function openSocket(target, records) {
  const proxy = envProxyFor(target);
  if (proxy) return connectThroughEnvProxy(proxy, target);
  let lastErr;
  for (const record of records) {
    try {
      return await connectDirect(target, record);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('connect failed');
}

// Referer/Origin arriving at our server point at OUR OWN proxy URL (the
// browser's real Referer for a resource loaded from our page), never at the
// target site. Forwarding that as-is to the upstream site (a) leaks our
// internal gateway URL to every site we visit and (b) is a strong, easy
// bot-detection signal ("this traffic did not come from our own site").
// Because our proxied URLs are literally `${proxyBase}?url=<original>`, we
// can recover the real page the browser was on and forward a normal,
// same-site-looking Referer/Origin instead — this is just restoring the
// information a transparent proxy should be passing along, not spoofing it.
function realTargetFromProxiedUrl(value, proxyBase) {
  if (!value) return null;
  try {
    const u = new URL(value);
    if (`${u.origin}${u.pathname}` !== proxyBase) return null;
    const inner = u.searchParams.get('url');
    return inner ? new URL(inner) : null;
  } catch {
    return null;
  }
}

function requestOverSocket(socket, target, req, proxyBase) {
  const lib = target.protocol === 'https:' ? https : http;
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers['accept-encoding'];
  delete headers['content-length'];
  headers.host = target.host;
  // Forward the visitor's real browser User-Agent. A previous version always
  // overwrote this with a custom "SoloHostBrowser/local-gateway" string,
  // which is exactly the kind of self-identifying label that gets a proxy's
  // traffic flagged/blocked by sites like Google or Facebook. Only fall back
  // to a generic UA on the rare request that arrives without one at all.
  headers['user-agent'] = headers['user-agent'] || UA;
  headers.accept = headers.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  headers['accept-language'] = headers['accept-language'] || 'en;q=0.8';
  const realReferer = realTargetFromProxiedUrl(headers.referer, proxyBase);
  if (realReferer) headers.referer = realReferer.href;
  else delete headers.referer;
  if (headers.origin) {
    const realOrigin = realTargetFromProxiedUrl(headers.origin + '/', proxyBase) || realReferer;
    headers.origin = realOrigin ? realOrigin.origin : target.origin;
  }
  const path =
    envProxyFor(target) && target.protocol === 'http:'
      ? target.href
      : target.pathname + target.search;
  return lib.request({
    createConnection: () => socket,
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path,
    method: req.method || 'GET',
    headers,
    timeout: 20000
  });
}

function rewriteSetCookie(headers, proxyBase) {
  const raw = headers['set-cookie'];
  if (!raw) return;
  const isHttps = proxyBase.startsWith('https:');
  const list = Array.isArray(raw) ? raw : [raw];
  headers['set-cookie'] = list.map((cookie) => {
    // The upstream site sets cookies scoped to ITS OWN domain (e.g.
    // "Domain=.google.com"). Served from our proxy's origin, the browser
    // silently refuses to store a cookie whose Domain doesn't match the
    // current page — so login sessions, CSRF tokens and CAPTCHA state never
    // persist across a request. Dropping the Domain attribute lets it
    // default to our own host instead, which the browser will accept.
    let out = String(cookie).replace(/;\s*domain=[^;]*/gi, '');
    // Cookies marked SameSite=None require Secure; if we're serving the
    // gateway over plain HTTP (local/dev), keep the cookie usable rather
    // than have the browser drop it for a scheme mismatch.
    if (!isHttps) out = out.replace(/;\s*secure/gi, '').replace(/;\s*samesite=none/gi, '; SameSite=Lax');
    return out;
  });
}

async function fetchTarget(targetUrl, req, res, proxyBase, redirects = 0) {
  const records = await resolvePublicHost(targetUrl.hostname);
  const socket = await openSocket(targetUrl, records);
  await new Promise((resolve, reject) => {
    const upstream = requestOverSocket(socket, targetUrl, req, proxyBase);
    upstream.on('response', (upstreamRes) => {
      const location = upstreamRes.headers.location;
      if (
        location &&
        upstreamRes.statusCode >= 300 &&
        upstreamRes.statusCode < 400 &&
        redirects < 5 &&
        (req.method === 'GET' || req.method === 'HEAD')
      ) {
        upstreamRes.resume();
        socket.destroy();
        let next;
        try {
          next = new URL(location, targetUrl);
        } catch {
          return reject(new Error('Invalid redirect'));
        }
        return fetchTarget(next, req, res, proxyBase, redirects + 1).then(resolve, reject);
      }
      const contentType = String(upstreamRes.headers['content-type'] || '').toLowerCase();
      const isRewrittenText = contentType.includes('text/html') || contentType.includes('text/css');
      const headersOut = stripHopByHop(upstreamRes.headers, { keepContentLength: !isRewrittenText });
      rewriteSetCookie(headersOut, proxyBase);
      if (location) {
        try {
          headersOut.location = proxyUrlFor(proxyBase, new URL(location, targetUrl).href);
        } catch {}
      }
      if (isRewrittenText) {
        const chunks = [];
        let size = 0;
        upstreamRes.on('data', (c) => {
          size += c.length;
          if (size > MAX_HTML) {
            upstreamRes.destroy();
            return reject(new Error('Text response too large'));
          }
          chunks.push(c);
        });
        upstreamRes.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            const rewritten = contentType.includes('text/css')
              ? rewriteCss(body, targetUrl.href, proxyBase)
              : rewriteHtml(body, targetUrl.href, proxyBase);
            headersOut['content-type'] = contentType.includes('text/css')
              ? 'text/css; charset=utf-8'
              : 'text/html; charset=utf-8';
            headersOut['cache-control'] = 'no-store';
            res.writeHead(upstreamRes.statusCode || 200, headersOut);
            res.end(rewritten);
            resolve();
          } catch (err) {
            reject(err);
          }
        });
        upstreamRes.on('error', reject);
      } else {
        res.writeHead(upstreamRes.statusCode || 200, headersOut);
        upstreamRes.pipe(res);
        upstreamRes.on('end', resolve);
        upstreamRes.on('error', reject);
      }
    });
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', reject);
    if (req.method === 'GET' || req.method === 'HEAD') upstream.end();
    else req.pipe(upstream);
  });
}

async function handleProxyRequest(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const raw = requestUrl.searchParams.get('url');
  const proxyBase = proxyBaseFromReq(req);
  if (!raw) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(gatewayErrorPage('Missing address', 'No url parameter was provided.'));
    return;
  }
  try {
    const target = validateTarget(raw);
    await fetchTarget(target, req, res, proxyBase);
  } catch (err) {
    if (res.headersSent) return;
    res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(gatewayErrorPage('Page unavailable', String(err.message || 'Gateway failed')));
  }
}

async function probeOutbound() {
  const via = envProxyFor(new URL('https://example.com')) ? 'env-proxy' : 'direct';
  const targets = ['https://example.com/', 'https://www.cloudflare.com/', 'https://1.1.1.1/'];
  const checks = [];
  for (const href of targets) {
    const started = Date.now();
    try {
      const url = new URL(href);
      const records = href.includes('1.1.1.1')
        ? [{ address: '1.1.1.1', family: 4 }]
        : await resolvePublicHost(url.hostname);
      const socket = await openSocket(url, records);
      await new Promise((resolve, reject) => {
        const req = (url.protocol === 'https:' ? https : http).request({
          createConnection: () => socket,
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname,
          method: 'HEAD',
          headers: { host: url.host, 'user-agent': UA },
          timeout: 5000
        });
        req.on('response', (r) => {
          r.resume();
          resolve(r.statusCode);
        });
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('timeout'));
        });
        req.on('error', reject);
        req.end();
      });
      checks.push({ host: url.hostname, ok: true, ms: Date.now() - started });
      return { ok: true, outbound: true, via, checks };
    } catch (err) {
      checks.push({ host: new URL(href).hostname, ok: false, error: err.message, ms: Date.now() - started });
    }
  }
  return { ok: false, outbound: false, via, checks };
}

module.exports = {
  handleProxyRequest,
  probeOutbound,
  publicOrigin,
  proxyBaseFromReq,
  validateTarget,
  MAX_BODY
};
