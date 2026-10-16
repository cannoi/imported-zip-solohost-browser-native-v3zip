'use strict';
const dns = require('dns').promises;
const net = require('net');

function isPrivateIp(ip) {
  if (!ip) return true;
  const v = String(ip).toLowerCase().replace(/^\[|\]$/g, '');
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  if (net.isIPv4(v)) {
    const a = v.split('.').map(Number);
    return a[0] === 0 || a[0] === 10 || a[0] === 127 || a[0] >= 224 ||
      (a[0] === 169 && a[1] === 254) || (a[0] === 172 && a[1] >= 16 && a[1] <= 31) ||
      (a[0] === 192 && a[1] === 168) || (a[0] === 100 && a[1] >= 64 && a[1] <= 127) ||
      (a[0] === 192 && a[1] === 0 && a[2] === 0) || (a[0] === 198 && (a[1] === 18 || a[1] === 19)) ||
      (a[0] === 198 && a[1] === 51 && a[2] === 100) || (a[0] === 203 && a[1] === 0 && a[2] === 113);
  }
  if (net.isIPv6(v)) {
    return v === '::' || v === '::1' || v.startsWith('fe8') || v.startsWith('fe9') ||
      v.startsWith('fea') || v.startsWith('feb') || v.startsWith('fc') || v.startsWith('fd') ||
      v.startsWith('ff') || v.startsWith('2001:db8:');
  }
  return true;
}

function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost');
}

const BLOCKED_PORTS = new Set([
  22, 23, 25, 53, 110, 143, 445, 1433, 1521, 3306, 3389, 5432, 5900, 5901,
  6379, 7001, 8000, 8080, 8443, 9200, 9300, 11211, 27017,
  2375, 2376, 2377, 4243, 6443, 10250, 10255, 50000
]);

async function assertPublicHttpUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    const err = new Error('Invalid URL');
    err.code = 'INVALID_URL';
    throw err;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    const err = new Error('Only http/https allowed');
    err.code = 'BAD_SCHEME';
    throw err;
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (u.username || u.password) {
    const err = new Error('URLs containing credentials are not allowed');
    err.code = 'INVALID_URL';
    throw err;
  }
  if (!host ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      host.endsWith('.lan') ||
      host === 'metadata.google.internal' ||
      host === 'metadata' ||
      host === 'kubernetes.default' ||
      host === 'kubernetes.default.svc') {
    if (!isLoopbackHost(host)) {
      const err = new Error('Host not allowed');
      err.code = 'BLOCKED_HOST';
      throw err;
    }
  }

  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  if (isLoopbackHost(host)) {
    // SoloHost local apps allowed on loopback
  } else if (port !== 80 && port !== 443 && BLOCKED_PORTS.has(port)) {
    const err = new Error('Port not allowed');
    err.code = 'BLOCKED_PORT';
    throw err;
  }
  if (port === 0 || port > 65535) {
    const err = new Error('Invalid port');
    err.code = 'BLOCKED_PORT';
    throw err;
  }

  if (net.isIP(host)) {
    if (isPrivateIp(host)) {
      const err = new Error('Private address blocked');
      err.code = 'BLOCKED_HOST';
      throw err;
    }
    return u;
  }

  let resolved;
  try {
    resolved = await dns.lookup(host, { all: true, verbatim: true });
  } catch (e) {
    const err = new Error('DNS resolution failed');
    err.code = 'DNS_FAIL';
    throw err;
  }
  if (!resolved || !resolved.length) {
    const err = new Error('DNS resolution failed');
    err.code = 'DNS_FAIL';
    throw err;
  }
  for (const r of resolved) {
    if (isPrivateIp(r.address)) {
      const err = new Error('Private address blocked');
      err.code = 'BLOCKED_HOST';
      throw err;
    }
  }
  return u;
}

module.exports = { assertPublicHttpUrl, isPrivateIp, isLoopbackHost, BLOCKED_PORTS };
