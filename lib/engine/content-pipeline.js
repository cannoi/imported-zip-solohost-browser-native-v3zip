'use strict';

/**
 * Shared live-page extraction pipeline for SoloHost Bridge and Static Capture.
 * It consumes an existing Playwright Page (never launches its own browser), so
 * cookies, localStorage, IndexedDB and authenticated state remain in the user's
 * Chromium BrowserContext. The interactive DOM snapshot remains the Bridge's
 * display contract; Readability is used as a structured content signal/fallback,
 * not as a destructive replacement for interactive pages.
 */
const contentRouter = require('./content-router');

async function inspectLivePage(page) {
  const raw = await page.evaluate(() => {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    const meta = (selector) => document.querySelector(selector)?.getAttribute('content') || '';
    const jsonLd = [];
    for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(node.textContent || 'null');
        if (parsed && jsonLd.length < 30) jsonLd.push(parsed);
      } catch (_) {}
    }
    const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 3000).map(a => ({
      href: a.href, text: (a.innerText || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 240)
    })).filter(a => /^https?:/i.test(a.href));
    const signals = {
      password: !!document.querySelector('input[type="password"]'),
      search: !!document.querySelector('form[role="search"],input[type="search"],input[name="q"]'),
      products: document.querySelectorAll('[itemtype*="Product" i],[itemprop="price"],[data-testid*="product" i]').length,
      media: document.querySelectorAll('video,audio,iframe[src*="youtube" i],iframe[src*="vimeo" i]').length,
      social: document.querySelectorAll('[role="feed"],[data-pagelet*="Feed" i],[data-testid*="post" i]').length,
      articles: document.querySelectorAll('article,[itemprop="articleBody"]').length,
      forms: document.querySelectorAll('form').length,
      controls: document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"]').length
    };
    return {
      url: location.href, title: document.title || '', textLength: text.length,
      description: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
      siteName: meta('meta[property="og:site_name"]'),
      canonical: document.querySelector('link[rel="canonical"]')?.href || '',
      lang: document.documentElement.lang || '',
      links, jsonLd, signals
    };
  });
  let domType = '';
  if (raw.signals.password) domType = 'login';
  else if (raw.signals.search && raw.links.length >= 2) domType = 'search';
  else if (raw.signals.products >= 2) domType = 'commerce';
  else if (raw.signals.media && /watch|video|player|clip|shorts/i.test(new URL(raw.url).pathname)) domType = 'video';
  else if (raw.signals.social >= 2) domType = 'social';
  else if (raw.signals.articles && raw.textLength > 280) domType = 'article';
  else if (raw.signals.forms >= 1 && raw.signals.controls >= 3) domType = 'form';
  const route = contentRouter.classify(raw.url, { pageType: domType || undefined });
  return { ...raw, route, pageType: route.pageType || 'generic' };
}


function extractReadable(html, url, fallbackTitle) {
  const { JSDOM } = require('jsdom');
  const { Readability } = require('@mozilla/readability');
  let title = String(fallbackTitle || url || 'Page');
  let byline = '', excerpt = '', content = '', textContent = '', length = 0;
  const dom = new JSDOM(String(html || ''), { url: String(url || 'https://example.invalid/'), contentType: 'text/html' });
  try {
    const doc = dom.window.document;
    for (const [selector, attr] of [['a[href]', 'href'], ['img[src]', 'src'], ['video[src]', 'src'], ['source[src]', 'src']]) {
      for (const el of doc.querySelectorAll(selector)) {
        try { el.setAttribute(attr, new URL(el.getAttribute(attr), url).href); } catch (_) { el.removeAttribute(attr); }
      }
    }
    const parsed = new Readability(doc, { charThreshold: 80, maxElemsToParse: 50000 }).parse();
    if (parsed && parsed.content) {
      title = parsed.title || title; byline = parsed.byline || ''; excerpt = parsed.excerpt || '';
      content = parsed.content; textContent = parsed.textContent || ''; length = Number(parsed.length) || textContent.length;
    }
    if (!content) {
      const fallback = doc.querySelector('main, article, [role="main"], #content, .content') || doc.body;
      content = fallback ? fallback.innerHTML || '' : '';
      textContent = fallback ? (fallback.textContent || '').replace(/\s+/g, ' ').trim() : '';
      title = doc.title || title;
      const meta = doc.querySelector('meta[name="description"],meta[property="og:description"]');
      excerpt = meta ? meta.getAttribute('content') || '' : '';
      length = textContent.length;
    }
  } finally { dom.window.close(); }
  return { title: String(title).slice(0, 300), byline: String(byline).slice(0, 200), excerpt: String(excerpt).slice(0, 600), content, textContent, length };
}

async function captureLivePage(page, options = {}) {
  if (!page || typeof page.evaluate !== 'function') throw new Error('playwright_page_required');
  // Capture the Bridge's interactive display snapshot on the actual live page.
  const snapshot = typeof options.snapshot === 'function' ? await options.snapshot(page) : null;
  let metadata = null;
  try { metadata = await inspectLivePage(page); } catch (_) { metadata = null; }
  let readable = null;
  try {
    if (metadata && ['article', 'generic', 'docs'].includes(metadata.pageType) && metadata.textLength >= 180) {
      const html = await page.content();
      if (html.length <= 1500000) readable = extractReadable(html, metadata.url, metadata.title);
    }
  } catch (_) {}
  return {
    ...(snapshot || {}),
    extraction: metadata,
    readable,
    url: (metadata && metadata.url) || (snapshot && snapshot.url) || page.url(),
    title: (snapshot && snapshot.title) || (metadata && metadata.title) || '',
    pageType: (snapshot && snapshot.pageType) || (metadata && metadata.pageType) || 'generic',
    textLen: (snapshot && snapshot.textLen) || (metadata && metadata.textLength) || 0
  };
}

module.exports = { inspectLivePage, captureLivePage, extractReadable };
