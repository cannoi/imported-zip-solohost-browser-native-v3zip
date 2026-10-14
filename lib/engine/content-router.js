'use strict';

/**
 * Adaptive bridge routing by URL / content class.
 * ENGINE  = Playwright Chromium (full JS + cookies)
 * PROXY   = HTML proxy (fast read)
 * EMBED   = direct iframe embed (YouTube embed)
 * EXTERNAL = system browser ↗ (DRM / policy)
 * LOGIN   = ENGINE preferred (cookies) with external fallback messaging
 */

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

function classify(url) {
  const h = hostOf(url);
  let path = '';
  try { path = new URL(url).pathname || '/'; } catch { path = '/'; }

  if (!h) return { mode: 'PROXY', reason: 'invalid_host' };

  if (/(^|\.)(netflix|disneyplus|hulu|primevideo)\.com$/.test(h)) {
    return { mode: 'EXTERNAL', reason: 'drm_policy' };
  }
  if (/(^|\.)(facebook|fb|instagram|whatsapp|messenger)\.com$/.test(h)) {
    return { mode: 'EXTERNAL', reason: 'meta_app_policy' };
  }
  if (/\/(login|signin|sign-in|signup|oauth|authorize)/i.test(path)) {
    return { mode: 'LOGIN', reason: 'auth_surface' };
  }
  if (/youtube\.com|youtu\.be/.test(h) && /\/embed\//.test(path)) {
    return { mode: 'EMBED', reason: 'youtube_embed' };
  }
  if (/youtube\.com|youtu\.be/.test(h) && /watch/.test(path)) {
    return { mode: 'EMBED', reason: 'youtube_watch_to_embed' };
  }
  if (/youtube\.com|youtu\.be|google\./.test(h)) {
    return { mode: 'ENGINE', reason: 'spa_needs_js' };
  }
  if (/(thanhnien|tuoitre|vnexpress|wikipedia|24h\.com)\./.test(h)) {
    return { mode: 'PROXY', reason: 'article_friendly' };
  }
  // Default: try ENGINE for modernity, UI still falls back to PROXY
  return { mode: 'ENGINE', reason: 'default_modern' };
}

module.exports = { classify, hostOf };
