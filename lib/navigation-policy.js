'use strict';

const path = require('path');

const PROFILE = path.resolve(process.env.SOLOHOST_BROWSER_DATA || '/app/data/webkit-profile');
const ALLOWED = new Set(['http:', 'https:', 'about:', 'data:', 'blob:', 'file:']);
const EXTERNAL = new Set(['mailto:', 'tel:', 'magnet:']);

function validateNavigation(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('URL is empty');
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid URL'); }
  if (url.protocol === 'javascript:' || url.protocol === 'vbscript:') throw new Error('Blocked unsafe URL scheme');
  if (EXTERNAL.has(url.protocol)) throw new Error(`External scheme not available in Docker: ${url.protocol}`);
  if (!ALLOWED.has(url.protocol)) throw new Error(`Unsupported URL scheme: ${url.protocol}`);
  if (url.protocol === 'file:') {
    let local;
    try { local = path.resolve(decodeURIComponent(url.pathname)); } catch { throw new Error('Invalid local file URL'); }
    const base = PROFILE.endsWith(path.sep) ? PROFILE : PROFILE + path.sep;
    if (local !== PROFILE && !local.startsWith(base)) throw new Error('Local file access is restricted to the browser profile');
  }
  return url.toString();
}

module.exports = { validateNavigation };
