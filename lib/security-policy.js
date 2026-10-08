'use strict';
const fs = require('fs');
const path = require('path');
const PROFILE = path.resolve(process.env.SOLOHOST_BROWSER_DATA || '/app/data/webkit-profile');
const FILE = path.join(PROFILE, 'security-settings.json');
const DEFAULTS = Object.freeze({
  camera: false, microphone: false, location: false, notifications: false,
  downloads: 'allow', popups: 'block', mixedContent: 'block',
  blockPrivateNetwork: true, trackerReduction: true, thirdPartyCookies: false,
  clearOnExit: false, privateMode: false, safeNavigation: true
});
function normalize(input = {}) {
  const out = { ...DEFAULTS };
  for (const k of ['camera','microphone','location','notifications','blockPrivateNetwork','trackerReduction','thirdPartyCookies','clearOnExit','privateMode','safeNavigation']) {
    if (typeof input[k] === 'boolean') out[k] = input[k];
  }
  if (['allow','block'].includes(input.downloads)) out.downloads = input.downloads;
  if (['allow','block'].includes(input.popups)) out.popups = input.popups;
  if (['block','allow-https-upgrade'].includes(input.mixedContent)) out.mixedContent = input.mixedContent;
  const permissions = {};
  if (input.permissions && typeof input.permissions === 'object' && !Array.isArray(input.permissions)) {
    for (const [origin, grants] of Object.entries(input.permissions).slice(0, 200)) {
      try {
        const u = new URL(origin);
        if (!['http:','https:'].includes(u.protocol) || u.origin !== origin) continue;
        const g = {};
        for (const k of ['camera','microphone','location','notifications']) if (typeof grants?.[k] === 'boolean') g[k] = grants[k];
        permissions[origin] = g;
      } catch {}
    }
  }
  out.permissions = permissions;
  return out;
}
function load() {
  try { return normalize(JSON.parse(fs.readFileSync(FILE, 'utf8'))); }
  catch { return normalize(); }
}
function save(input) {
  const settings = normalize(input);
  fs.mkdirSync(PROFILE, { recursive: true });
  const temp = FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(settings, null, 2), { mode: 0o600 });
  fs.renameSync(temp, FILE);
  return settings;
}
function isPrivateHost(hostname) {
  let h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === 'metadata.google.internal') return true;
  if (h.includes('%')) h = h.split('%')[0];
  try {
    const ip = require('net').isIP(h);
    if (!ip) return false;
    if (ip === 4) return /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|192\.0\.0\.|198\.18\.|198\.19\.|224\.|240\.)/.test(h) || h === '255.255.255.255';
    const a = h.toLowerCase();
    return a === '::1' || a === '::' || a.startsWith('fc') || a.startsWith('fd') || /^fe[89ab]/.test(a) || a.startsWith('ff') || a.startsWith('::ffff:127.') || a.startsWith('::ffff:10.') || a.startsWith('::ffff:192.168.');
  } catch { return false; }
}
function validateNavigation(raw, settings = load()) {
  const value = String(raw || '').trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid URL');
  let u;
  try { u = new URL(value); } catch { throw new Error('Invalid URL'); }
  if (['javascript:','vbscript:','intent:','chrome:','devtools:','view-source:'].includes(u.protocol)) throw new Error('Blocked dangerous URL scheme');
  if (!['http:','https:','about:','data:','blob:','file:'].includes(u.protocol)) throw new Error('Unsupported URL scheme');
  if (u.username || u.password) throw new Error('URLs containing credentials are blocked');
  if (settings.safeNavigation && settings.blockPrivateNetwork && ['http:','https:'].includes(u.protocol) && isPrivateHost(u.hostname)) throw new Error('Localhost/private-network navigation is blocked by security policy');
  if (u.protocol === 'file:') {
    const target = path.resolve(decodeURIComponent(u.pathname));
    const rel = path.relative(PROFILE, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('file: is restricted to the browser profile');
  }
  return u.href;
}
module.exports = { DEFAULTS, normalize, load, save, isPrivateHost, validateNavigation };
