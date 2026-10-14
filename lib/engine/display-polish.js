'use strict';

/**
 * Shared display polish for Bridge (Chromium snapshot) AND Proxy (iframe HTML).
 * Makes every served page readable on phone + desktop and hides common ads.
 * Never runs site JavaScript in the admin origin; only transforms the HTML copy.
 */

const contentRouter = require('./content-router');
const layoutTemplates = require('./layout-templates');

/** CSS that hides common ad / tracking chrome without breaking main content. */
function adHideCss() {
  return [
    '/* SoloHost ad filter (display copy only) */',
    'iframe[src*="doubleclick"],iframe[src*="googlesyndication"],iframe[src*="googleadservices"],',
    'iframe[src*="facebook.com/tr"],iframe[src*="adservice"],iframe[src*="adnxs"],',
    'iframe[src*="taboola"],iframe[src*="outbrain"],iframe[src*="criteo"],iframe[src*="adsystem"],',
    '[id*="google_ads" i],[id*="ad-container" i],[id*="adcontainer" i],[id^="ad-"],[id$="-ad"],',
    '[class*="google-auto-placed" i],[class*="adsbygoogle" i],[class*="ad-slot" i],',
    '[class*="ad-banner" i],[class*="adbanner" i],[class*="ad-wrapper" i],[class*="adwrapper" i],',
    '[class*="sponsored" i],[data-ad],[data-ad-slot],[data-ad-client],[data-google-query-id],',
    'ins.adsbygoogle,.adsbox,.ad-unit,.adunit,.dfp-ad,.trc_rbox,.OUTBRAIN,.taboola,',
    '[class*="cookie-banner" i],[class*="cookie-consent" i],[id*="cookie-banner" i],',
    '[class*="newsletter-popup" i],[class*="modal-overlay" i][class*="subscribe" i]',
    '{display:none!important;visibility:hidden!important;height:0!important;max-height:0!important;',
    'overflow:hidden!important;pointer-events:none!important;margin:0!important;padding:0!important}'
  ].join('');
}

/**
 * Strip obvious ad markup from HTML string (conservative).
 */
function stripAdMarkup(html) {
  let out = String(html || '');
  const AD_HOST = /doubleclick|googlesyndication|googleadservices|adservice|adnxs|taboola|outbrain|criteo|facebook\.com\/tr|adsystem|2mdn\.net|scorecardresearch|googletagservices|pagead2/i;
  // Any iframe whose src points at known ad hosts
  out = out.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, (block) => {
    const src = (block.match(/\bsrc\s*=\s*["']([^"']+)/i) || [])[1] || '';
    return AD_HOST.test(src) ? '' : block;
  });
  out = out.replace(/<iframe\b[^>]*\/?>/gi, (block) => {
    const src = (block.match(/\bsrc\s*=\s*["']([^"']+)/i) || [])[1] || '';
    return AD_HOST.test(src) ? '' : block;
  });
  out = out.replace(/<ins\b[^>]*adsbygoogle[^>]*>[\s\S]*?<\/ins>/gi, '');
  out = out.replace(/<ins\b[^>]*class\s*=\s*["'][^"']*adsbygoogle[^"']*["'][^>]*>[\s\S]*?<\/ins>/gi, '');
  out = out.replace(/<img\b[^>]*(?:width\s*=\s*["']?1["']?[^>]*height\s*=\s*["']?1["']?|height\s*=\s*["']?1["']?[^>]*width\s*=\s*["']?1["']?)[^>]*>/gi, '');
  out = out.replace(/<img\b[^>]*src\s*=\s*["'][^"']*(?:pixel|tracking|beacon|\/ads\/|doubleclick)[^"']*["'][^>]*>/gi, '');
  out = out.replace(/<(?:div|section|aside)\b[^>]*(?:id|class)\s*=\s*["'][^"']*(?:google_ads|adsbygoogle|ad-slot|ad-banner|adbanner|dfp-ad)[^"']*["'][^>]*>[\s\S]*?<\/(?:div|section|aside)>/gi, '');
  return out;
}

/**
 * Apply full polish: ad strip + pageType + responsive layout CSS + viewport.
 * @param {string} html
 * @param {string} baseUrl
 * @param {{ pageType?: string }} [hints]
 * @returns {string}
 */
function polishHtml(html, baseUrl, hints = {}) {
  let out = stripAdMarkup(html);
  // Neutralize absolute/fixed inline styles that stack content on mobile.
  out = out.replace(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/gi, (full, q, style) => {
    let s = String(style);
    s = s.replace(/position\s*:\s*(absolute|fixed)\s*;?/gi, 'position:relative;');
    s = s.replace(/(?:^|;)\s*(?:left|right)\s*:\s*-?\d+px;?/gi, ';');
    s = s.replace(/min-width\s*:\s*\d{3,}px;?/gi, '');
    s = s.replace(/;{2,}/g, ';').replace(/^;|;$/g, '').trim();
    return s ? (' style=' + q + s + q) : '';
  });
  if (!out || !out.trim()) return out;

  const route = contentRouter.classify(baseUrl || '', hints);
  const pageType = layoutTemplates.normalizePageType(hints.pageType || route.pageType || 'generic');

  // data-sh-page-type on html/body for type CSS
  if (/<html\b/i.test(out)) {
    out = out.replace(/<html\b([^>]*)>/i, (m, attrs) => {
      const a = String(attrs || '').replace(/\sdata-sh-page-type\s*=\s*(["']).*?\1/ig, '');
      return '<html' + a + ' data-sh-page-type="' + pageType + '">';
    });
  }
  if (/<body\b/i.test(out)) {
    out = out.replace(/<body\b([^>]*)>/i, (m, attrs) => {
      const a = String(attrs || '').replace(/\sdata-sh-page-type\s*=\s*(["']).*?\1/ig, '');
      return '<body' + a + ' data-sh-page-type="' + pageType + '">';
    });
  } else if (!/<html\b/i.test(out)) {
    out = '<body data-sh-page-type="' + pageType + '">' + out + '</body>';
  }

  // Force mobile viewport
  out = out.replace(/<meta[^>]+name\s*=\s*["']viewport["'][^>]*>/gi, '');
  const viewport = '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=5,viewport-fit=cover">';
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => m + viewport);
  else out = viewport + out;

  // Unified layout templates + ad hide
  const style =
    layoutTemplates.bridgeStyleTag(pageType).replace(
      '</style>',
      adHideCss() + '</style>'
    );
  // Remove older injects to avoid duplicate rules
  out = out.replace(/<style\b[^>]*id=["']solohost-layout-fix["'][^>]*>[\s\S]*?<\/style>/gi, '');
  out = out.replace(/<style\b[^>]*id=["']sh-bridge-css["'][^>]*>[\s\S]*?<\/style>/gi, '');
  if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, style + '</head>');
  else out = style + out;

  return out;
}

module.exports = {
  adHideCss,
  stripAdMarkup,
  polishHtml
};
