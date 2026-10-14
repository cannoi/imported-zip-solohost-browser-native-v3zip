'use strict';

/**
 * URL-first, policy-aware routing hints for the DOM Bridge.
 * pageType drives layout templates (readable on portrait + landscape).
 * Chromium remains the primary renderer; route is advisory for display CSS.
 */

function parseUrl(raw) {
  try { return new URL(String(raw || '')); } catch (_) { return null; }
}
function hostOf(url) {
  const u = parseUrl(url);
  return u ? u.hostname.replace(/^www\./i, '').toLowerCase() : '';
}
function isHost(host, root) {
  return host === root || host.endsWith('.' + root);
}

const NEWS_HOSTS = [
  'thanhnien.vn', 'vnexpress.net', 'tuoitre.vn', 'dantri.com.vn', 'vietnamnet.vn',
  'zingnews.vn', 'baomoi.com', 'kenh14.vn', 'cafef.vn', 'cafebiz.vn',
  'bbc.com', 'bbc.co.uk', 'cnn.com', 'nytimes.com', 'theguardian.com',
  'reuters.com', 'apnews.com', 'nhandan.vn', 'chinhphu.vn', 'vtv.vn',
  'laodong.vn', 'tienphong.vn', 'nld.com.vn', 'sggp.org.vn'
];

const BLOG_HOSTS = [
  'medium.com', 'substack.com', 'wordpress.com', 'blogspot.com', 'blogger.com',
  'ghost.io', 'hashnode.dev', 'dev.to'
];

const SOCIAL_HOSTS = [
  'facebook.com', 'instagram.com', 'whatsapp.com', 'messenger.com', 'tiktok.com',
  'x.com', 'twitter.com', 'reddit.com', 'threads.net', 'linkedin.com', 'pinterest.com'
];

const COMMERCE_HOSTS = [
  'ebay.com', 'aliexpress.com', 'etsy.com', 'walmart.com', 'target.com', 'shopify.com',
  'lazada.vn', 'shopee.vn', 'tiki.vn', 'sendo.vn'
];

const DOCS_HOSTS = [
  'github.com', 'gitlab.com', 'readthedocs.io', 'developer.mozilla.org',
  'stackoverflow.com', 'stackexchange.com', 'npmjs.com', 'pypi.org'
];

const SEARCH_HOSTS = [
  'duckduckgo.com', 'search.brave.com', 'search.yahoo.com', 'yahoo.com',
  'ecosia.org', 'qwant.com'
];

function classify(rawUrl, hints = {}) {
  const u = parseUrl(rawUrl);
  if (!u || !['http:', 'https:'].includes(u.protocol)) {
    return { mode: 'PROXY', reason: 'invalid_or_unsupported_url', pageType: 'generic' };
  }
  const h = u.hostname.replace(/^www\./i, '').toLowerCase();
  const path = (u.pathname || '/').toLowerCase();
  const query = u.searchParams;

  if (/(^|\.)(netflix|disneyplus|hulu|primevideo)\.com$/.test(h)) {
    return { mode: 'EXTERNAL', reason: 'drm_policy', pageType: 'video' };
  }

  const authPath = /\/(?:login|log-in|signin|sign-in|signup|sign-up|oauth|authorize|checkpoint|challenge|accounts)(?:\/|$)/i.test(path);
  if (authPath || (hints && hints.hasPassword)) {
    return { mode: 'LOGIN', reason: 'auth_surface', pageType: 'login' };
  }

  // Explicit DOM hint wins when valid
  if (hints && hints.pageType && ['search', 'video', 'commerce', 'article', 'social', 'docs', 'form', 'login'].includes(hints.pageType)) {
    return { mode: 'ENGINE', reason: 'dom_signal_' + hints.pageType, pageType: hints.pageType };
  }

  const searchHost = SEARCH_HOSTS.some((root) => isHost(h, root)) || /(^|\.)(google|bing)\.[a-z.]+$/i.test(h);
  if (searchHost && (/\/(?:search|web|html)\/?$/i.test(path) || ['q', 'query', 'p', 'text', 'wd', 'k'].some((k) => query.has(k)) || isHost(h, 'search.brave.com'))) {
    return { mode: 'ENGINE', reason: 'search_results', pageType: 'search' };
  }

  if ((isHost(h, 'youtube.com') || h === 'youtu.be') && /\/(?:embed|live_chat_replay)\//i.test(path)) {
    return { mode: 'EMBED', reason: 'official_video_embed', pageType: 'video' };
  }
  if (isHost(h, 'youtube.com') || h === 'youtu.be' || isHost(h, 'vimeo.com') || isHost(h, 'dailymotion.com') || isHost(h, 'twitch.tv')) {
    const detail = /\/(?:watch|shorts|live|video|clip|embed|player)(?:\/|$)/i.test(path) || h === 'youtu.be' || (isHost(h, 'vimeo.com') && /^\/\d+/.test(path));
    return { mode: 'ENGINE', reason: detail ? 'video_detail' : 'video_site', pageType: detail ? 'video' : 'generic' };
  }
  if ((isHost(h, 'tiktok.com') || isHost(h, 'instagram.com')) && /\/(?:video|reel|reels)\//i.test(path)) {
    return { mode: 'ENGINE', reason: 'short_video', pageType: 'video' };
  }

  if (SOCIAL_HOSTS.some((root) => isHost(h, root))) {
    return { mode: 'ENGINE', reason: 'interactive_social_site', pageType: 'social' };
  }

  if (/(^|\.)amazon\.[a-z.]+$/i.test(h) || COMMERCE_HOSTS.some((root) => isHost(h, root)) ||
      /\/(?:product|products|item|items|dp|gp\/product|shop)(?:\/|$)/i.test(path)) {
    return { mode: 'ENGINE', reason: 'commerce_layout', pageType: 'commerce' };
  }

  if (isHost(h, 'wikipedia.org') || NEWS_HOSTS.some((root) => isHost(h, root)) ||
      BLOG_HOSTS.some((root) => isHost(h, root)) ||
      /\/(?:article|articles|news|story|stories|blog|posts?|tin-tuc|bai-viet)(?:\/|$)/i.test(path) ||
      /\.(?:md|html?)$/i.test(path)) {
    return { mode: 'ENGINE', reason: 'article_layout', pageType: 'article' };
  }

  if (DOCS_HOSTS.some((root) => isHost(h, root))) {
    return { mode: 'ENGINE', reason: 'documentation_or_community', pageType: 'docs' };
  }

  // Path-level form signals
  if (/\/(?:contact|subscribe|register|checkout|cart)(?:\/|$)/i.test(path)) {
    return { mode: 'ENGINE', reason: 'form_path', pageType: 'form' };
  }

  return { mode: 'ENGINE', reason: 'default_chromium', pageType: 'generic' };
}

module.exports = { classify, hostOf, isHost, NEWS_HOSTS };
