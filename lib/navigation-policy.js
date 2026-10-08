'use strict';
const path = require('path');
const { URL } = require('url');
const security = require('./security-policy');
const PROFILE = path.resolve(process.env.SOLOHOST_BROWSER_DATA || '/app/data/webkit-profile');
function isWithin(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
function validateNavigation(raw) {
  const value = String(raw || '').trim();
  let u;
  try { u = new URL(value); } catch { throw new Error('Invalid URL'); }
  if (['javascript:','vbscript:','intent:','chrome:','devtools:','view-source:'].includes(u.protocol)) throw new Error('unsafe URL scheme blocked');
  if (['ftp:','mailto:','tel:','magnet:'].includes(u.protocol)) {
    if (u.protocol === 'ftp:') throw new Error('FTP is a legacy protocol and is blocked; use HTTPS instead');
    throw new Error('External handler is not available inside Docker');
  }
  return security.validateNavigation(value);
}
function classifyUrl(raw) {
  let u;
  try { u = new URL(String(raw), 'https://solohost.invalid'); } catch { return { kind: 'invalid' }; }
  if (u.protocol === 'data:') return { kind: 'inline-data' };
  if (u.protocol === 'blob:') return { kind: 'blob-resource' };
  if (u.protocol === 'file:') {
    let filePath; try { filePath = decodeURIComponent(u.pathname); } catch { return { kind: 'blocked-file' }; }
    return isWithin(PROFILE, filePath) ? { kind: 'local-file' } : { kind: 'blocked-file' };
  }
  if (u.protocol === 'http:' || u.protocol === 'https:') return { kind: 'web' };
  if (u.protocol === 'about:') return { kind: 'internal' };
  return { kind: 'unsupported' };
}
function classifyResourceType(raw) {
  let pathname = ''; try { pathname = new URL(String(raw), 'https://solohost.invalid').pathname.toLowerCase(); } catch {}
  const ext = path.extname(pathname);
  if (ext === '.pdf') return 'pdf';
  if (['.png','.jpg','.jpeg','.gif','.webp','.svg','.avif','.bmp','.ico'].includes(ext)) return 'image';
  if (['.mp3','.aac','.ogg','.opus','.wav','.flac','.m4a'].includes(ext)) return 'audio';
  if (['.mp4','.webm','.mov','.mkv','.ogv'].includes(ext)) return 'video';
  if (['.txt','.md','.csv','.log'].includes(ext)) return 'text';
  if (ext === '.json') return 'json';
  if (['.zip','.gz','.tar','.7z','.rar'].includes(ext)) return 'archive';
  return 'web';
}
module.exports = { validateNavigation, classifyUrl, classifyResourceType, isWithin };
