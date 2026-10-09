#!/usr/bin/env node
'use strict';
/**
 * Real end-to-end check of the Chromium extractor.
 * Run INSIDE the built container (or any machine with playwright + Chromium installed):
 *
 *   docker compose exec web node scripts/smoke-extract.js https://example.com
 *   npm run smoke:extract -- https://vnexpress.net/
 *
 * Prints a short JSON summary; exits non-zero on failure.
 */
const { ContentExtractor } = require('../lib/content-extractor');

(async () => {
  const url = process.argv[2] || 'https://example.com/';
  const extractor = new ContentExtractor();
  const started = Date.now();
  try {
    const r = await extractor.extract(url, { acceptLanguage: process.env.SMOKE_LANG || 'en-US' });
    console.log(JSON.stringify({
      ok: r.ok, final_url: r.final_url, http_status: r.http_status, kind: r.kind, readable: r.readable,
      title: r.title, author: r.author, site_name: r.site_name, favicon: r.favicon, published_at: r.published_at, lang: r.lang,
      word_count: r.word_count, reading_minutes: r.reading_minutes,
      text_preview: String(r.raw_text || '').slice(0, 200),
      html_bytes: Buffer.byteLength(r.clean_html || ''),
      media: r.media, duration_ms: Date.now() - started, extractor: extractor.stats()
    }, null, 2));
    process.exitCode = r.ok ? 0 : 1;
  } catch (err) {
    console.error(JSON.stringify({ ok: false, code: err.code || 'ERROR', error: err.message }, null, 2));
    process.exitCode = 1;
  } finally {
    await extractor.close();
  }
})();
