'use strict';

/**
 * URL-first, policy-aware routing hints for the DOM Bridge.
 * The route is advisory: Chromium remains the primary renderer. We do not
 * force social sites out of the app just because they are social; protected
 * sign-in / DRM flows are handled separately and transparently.
 */
function parseUrl(raw) {
  try { return new URL(String(raw || '')); } catch (_) { return null; }
}
function hostOf(url) {
  const u = parseUrl(url);
  return u ? u.hostname.replace(/^www\./i, '').toLowerCase() : '';
}
function isHost(host, root) { return host === root || host.endsWith('.' + root); }
function classify(rawUrl, hints = {}) {
  const u = parseUrl(rawUrl);
  if (!u || !['http:', 'https:'].includes(u.protocol)) return { mode: 'PROXY', reason: 'invalid_or_unsupported_url', pageType: 'generic' };
  const h = u.hostname.replace(/^www\./i, '').toLowerCase();
  const path = (u.pathname || '/').toLowerCase();
  const query = u.searchParams;
  const authPath = /\/(?:login|log-in|signin|sign-in|signup|sign-up|oauth|authorize|checkpoint|challenge)(?:\/|$)/i.test(path);

  if (/(^|\.)(netflix|disneyplus|hulu|primevideo)\.com$/.test(h)) return { mode: 'EXTERNAL', reason: 'drm_policy', pageType: 'video' };
  if (authPath) return { mode: 'LOGIN', reason: 'auth_surface', pageType: 'login' };

  const searchHosts = ['duckduckgo.com', 'search.brave.com', 'search.yahoo.com', 'yahoo.com', 'ecosia.org', 'qwant.com'];
  const searchHost = searchHosts.some(root => isHost(h, root)) || /(^|\.)(google|bing)\.[a-z.]+$/i.test(h);
  if (searchHost && (/\/(?:search|web|html)\/?$/i.test(path) || ['q', 'query', 'p', 'text', 'wd', 'k'].some(k => query.has(k)) || isHost(h, 'search.brave.com'))) {
    return { mode: 'ENGINE', reason: 'search_results', pageType: 'search' };
  }
  if ((isHost(h, 'youtube.com') || h === 'youtu.be') && /\/(?:embed|live_chat_replay)\//i.test(path)) return { mode: 'EMBED', reason: 'official_video_embed', pageType: 'video' };
  if (isHost(h, 'youtube.com') || h === 'youtu.be' || isHost(h, 'vimeo.com') || isHost(h, 'dailymotion.com') || isHost(h, 'twitch.tv')) {
    const detail = /\/(?:watch|shorts|live|video|clip|embed|player)(?:\/|$)/i.test(path) || h === 'youtu.be' || (isHost(h, 'vimeo.com') && /^\/\d+/.test(path));
    return { mode: 'ENGINE', reason: detail ? 'video_detail' : 'video_site', pageType: detail ? 'video' : 'generic' };
  }
  if (['facebook.com', 'instagram.com', 'whatsapp.com', 'messenger.com', 'tiktok.com', 'x.com', 'twitter.com', 'reddit.com', 'threads.net', 'linkedin.com'].some(root => isHost(h, root))) {
    return { mode: 'ENGINE', reason: 'interactive_social_site', pageType: 'social' };
  }
  if (/(^|\.)amazon\.[a-z.]+$/i.test(h) || ['ebay.com', 'aliexpress.com', 'etsy.com', 'walmart.com', 'target.com', 'shopify.com', 'lazada.vn', 'shopee.vn', 'tiki.vn'].some(root => isHost(h, root)) || /\/(?:product|products|item|items|dp|gp\/product|shop)\//i.test(path)) {
    return { mode: 'ENGINE', reason: 'commerce_layout', pageType: 'commerce' };
  }
  if (isHost(h, 'wikipedia.org') || ['medium.com', 'substack.com', 'wordpress.com'].some(root => isHost(h, root)) || /\/(?:article|articles|news|story|stories|blog|posts?)\//i.test(path)) {
    return { mode: 'ENGINE', reason: 'article_layout', pageType: 'article' };
  }
  if (['github.com', 'gitlab.com', 'readthedocs.io', 'developer.mozilla.org', 'stackoverflow.com'].some(root => isHost(h, root))) {
    return { mode: 'ENGINE', reason: 'documentation_or_community', pageType: 'docs' };
  }
  if (hints && hints.pageType && ['search', 'video', 'commerce', 'article', 'social', 'docs', 'form', 'login'].includes(hints.pageType)) {
    return { mode: 'ENGINE', reason: 'dom_signal_' + hints.pageType, pageType: hints.pageType };
  }
  return { mode: 'ENGINE', reason: 'default_chromium', pageType: 'generic' };
}
module.exports = { classify, hostOf, isHost };
