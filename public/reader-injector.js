/**
 * Client-side content extraction + Reader Mode helpers for SoloHost Browser v9.
 * Works on same-origin documents only (cross-origin iframe is blocked by the browser).
 */
(function (global) {
  'use strict';

  function textFrom(el) {
    if (!el) return '';
    return String(el.innerText || el.textContent || '').replace(/\s+\n/g, '\n').trim();
  }

  function pickMeta(doc) {
    const get = (sel, attr) => {
      const n = doc.querySelector(sel);
      return n ? (attr ? n.getAttribute(attr) : n.textContent) : '';
    };
    return {
      title: get('meta[property="og:title"]', 'content') || get('title') || '',
      byline: get('meta[name="author"]', 'content') || get('meta[property="article:author"]', 'content') || '',
      siteName: get('meta[property="og:site_name"]', 'content') || (doc.location && doc.location.hostname) || '',
      description: get('meta[name="description"]', 'content') || get('meta[property="og:description"]', 'content') || ''
    };
  }

  /** Lightweight Readability-style extraction without external deps. */
  function extractFromDocument(doc) {
    if (!doc || !doc.body) {
      return { ok: false, error: 'NO_DOCUMENT', title: '', clean_html: '', raw_text: '', metadata: {} };
    }
    const meta = pickMeta(doc);
    const candidates = [
      'article',
      '[role="main"]',
      'main',
      '.post-content',
      '.article-content',
      '.entry-content',
      '#content',
      '.content'
    ];
    let best = null;
    let bestScore = 0;
    for (const sel of candidates) {
      const nodes = doc.querySelectorAll(sel);
      for (const n of nodes) {
        const t = textFrom(n);
        const score = t.length;
        if (score > bestScore) {
          bestScore = score;
          best = n;
        }
      }
    }
    if (!best || bestScore < 80) {
      best = doc.body;
      bestScore = textFrom(best).length;
    }
    const clone = best.cloneNode(true);
    clone.querySelectorAll('script,style,nav,aside,iframe,noscript,svg,form,button').forEach((n) => {
      try { n.remove(); } catch (_) {}
    });
    const clean_html = clone.innerHTML || '';
    const raw_text = textFrom(clone) || textFrom(best);
    return {
      ok: true,
      title: meta.title || (doc.title || ''),
      clean_html,
      raw_text,
      metadata: meta,
      word_count: raw_text.split(/\s+/).filter(Boolean).length
    };
  }

  function getFrameDocument(frame) {
    try {
      if (!frame) return null;
      return frame.contentDocument || (frame.contentWindow && frame.contentWindow.document) || null;
    } catch (e) {
      return null; // cross-origin
    }
  }

  function extractCurrentPageDOM(frameOrDoc) {
    try {
      let doc = null;
      if (frameOrDoc && frameOrDoc.nodeType === 9) doc = frameOrDoc;
      else doc = getFrameDocument(frameOrDoc) || document;
      const out = extractFromDocument(doc);
      try {
        out.url = (doc.defaultView && doc.defaultView.location && doc.defaultView.location.href)
          || (frameOrDoc && frameOrDoc.src) || '';
      } catch (_) {
        out.url = (frameOrDoc && frameOrDoc.src) || '';
      }
      return out;
    } catch (err) {
      return { ok: false, error: String(err.message || err), title: '', clean_html: '', raw_text: '', metadata: {} };
    }
  }

  const READER_CSS = `
    html,body{background:#f7f3ea!important;color:#1a1a1a!important}
    body{max-width:42rem;margin:0 auto!important;padding:1.5rem!important;font:18px/1.7 Georgia,serif!important}
    nav,header,footer,aside,.sidebar,.ads,.advert,.cookie,.modal,.popup,[class*="cookie"],[id*="cookie"]{display:none!important}
    img,video{max-width:100%!important;height:auto!important}
    a{color:#0b57d0!important}
  `;

  function toggleReaderView(frame, enable) {
    try {
      const doc = getFrameDocument(frame);
      if (!doc) return { ok: false, error: 'CROSS_ORIGIN', message: 'Reader Mode needs same-origin page or Open page in a full tab.' };
      const id = 'solohost-reader-style';
      let style = doc.getElementById(id);
      if (enable === false) {
        if (style) style.remove();
        return { ok: true, enabled: false };
      }
      if (!style) {
        style = doc.createElement('style');
        style.id = id;
        style.textContent = READER_CSS;
        (doc.head || doc.documentElement).appendChild(style);
      }
      return { ok: true, enabled: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  }

  global.SoloReader = {
    extractCurrentPageDOM,
    extractFromDocument,
    toggleReaderView,
    getFrameDocument
  };
})(typeof window !== 'undefined' ? window : globalThis);
