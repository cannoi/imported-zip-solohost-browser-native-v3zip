'use strict';

/**
 * Adaptive bridge routing by URL / content class.
 * ENGINE  = Playwright Chromium (full JS + cookies) — default for SPA / login / news
 * PROXY   = HTML proxy — preferred when site is already optimized for proxy (YouTube player shell)
 * EMBED   = direct iframe embed
 * EXTERNAL = system browser ↗ (DRM)
 * LOGIN   = ENGINE preferred
 */

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

function isYouTubeHost(h) {
  return /youtube\.com$|youtu\.be$|youtube-nocookie\.com$/.test(h) ||
    h === 'm.youtube.com' || h.endsWith('.youtube.com');
}

function classify(url) {
  const h = hostOf(url);
  let path = '';
  try { path = new URL(url).pathname || '/'; } catch { path = '/'; }

  if (!h) return { mode: 'ENGINE', reason: 'unknown_host_try_engine' };

  if (/(^|\.)(netflix|disneyplus|hulu|primevideo)\.com$/.test(h)) {
    return { mode: 'EXTERNAL', reason: 'drm_policy' };
  }

  // YouTube was optimized for PROXY (official embed / player shell) — keep that priority
  if (isYouTubeHost(h)) {
    if (/\/embed\//.test(path)) return { mode: 'EMBED', reason: 'youtube_embed' };
    return { mode: 'PROXY', reason: 'youtube_proxy_optimized' };
  }

  if (/\/(login|signin|sign-in|signup|oauth|authorize)/i.test(path)) {
    return { mode: 'LOGIN', reason: 'auth_surface_engine' };
  }
  if (/accounts\.google\.com|login\.yahoo\.com|login\.live\.com|appleid\.apple\.com/.test(h)) {
    return { mode: 'LOGIN', reason: 'identity_provider_engine' };
  }

  // Google search / SPA / social / news — Chromium (proxy layout is poor)
  if (/google\.|bing\.com|duckduckgo\.com/.test(h)) {
    return { mode: 'ENGINE', reason: 'search_spa' };
  }
  if (/(^|\.)(facebook|fb|instagram|whatsapp|messenger|tiktok|x\.com|twitter|reddit|linkedin)\.com$/.test(h)) {
    return { mode: 'ENGINE', reason: 'social_spa' };
  }
  if (/(thanhnien|tuoitre|vnexpress|wikipedia|24h\.com|bbc\.|cnn\.|nytimes)/.test(h)) {
    return { mode: 'ENGINE', reason: 'publisher_prefer_engine' };
  }

  return { mode: 'ENGINE', reason: 'default_chromium' };
}

/** Sites that must NOT silent-fallback to HTML proxy when engine fails. YouTube is excluded (proxy-optimized). */
function mustUseEngine(url) {
  const h = hostOf(url);
  let path = '';
  try { path = new URL(url).pathname || '/'; } catch { path = '/'; }
  if (!h) return true;
  if (isYouTubeHost(h)) return false;
  if (/\/(login|signin|sign-in|signup|oauth|authorize)/i.test(path)) return true;
  if (/accounts\.google|google\.|bing\.com/.test(h)) return true;
  if (/(facebook|instagram|tiktok|twitter|x\.com|reddit|linkedin|shopee|lazada|amazon)/.test(h)) return true;
  if (/(thanhnien|tuoitre|vnexpress|wikipedia)/.test(h)) return true;
  return false;
}

module.exports = { classify, hostOf, mustUseEngine, isYouTubeHost };
