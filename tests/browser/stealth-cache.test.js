'use strict';
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.SOLOHOST_BROWSER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'solohost-cache-'));
const root = path.join(__dirname, '..', '..');
const { ContentExtractor } = require(path.join(root, 'lib/content-extractor.js'));
const { STEALTH } = require(path.join(root, 'lib/stealth.js'));
const { createEngine } = require(path.join(root, 'lib/chromium-engine.js'));
const gw = require(path.join(root, 'browser-gateway.js'));

/* ---------- stealth profile ---------- */
assert.ok(STEALTH.locale === 'en-US' || STEALTH.locale === 'en-US');
assert.ok(STEALTH.acceptLanguage.includes('en'));
assert.ok(STEALTH.timezoneId === 'UTC' || !!STEALTH.timezoneId);
assert.ok(/^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\)/.test(STEALTH.userAgent) && !/Headless/i.test(STEALTH.userAgent));
assert.ok(STEALTH.launchArgs.includes('--disable-blink-features=AutomationControlled'));
// the init script really hides webdriver
{
  const navigator = {};
  new Function('navigator', 'window', STEALTH.initScript)(navigator, {});
  assert.strictEqual(navigator.webdriver, undefined);
  assert.ok(Array.isArray(navigator.languages) && navigator.languages[0] === 'en-US');
}

/* ---------- fake chromium that counts real navigations ---------- */
function fakeChromium(html = '<html><body>x</body></html>') {
  const log = { launches: 0, gotos: 0, launchArgs: null, pagesOpen: 0, pagesClosed: 0, ctxOpts: [] };
  const browser = {
    connected: true, isConnected() { return this.connected; }, on() {}, async close() { this.connected = false; },
    async newContext(opts) {
      log.ctxOpts.push(opts);
      return {
        setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, async route() {}, async addInitScript() {},
        async newPage() {
          log.pagesOpen += 1;
          return {
            on() {},
            async goto(url) { log.gotos += 1; await new Promise(r => setTimeout(r, 20)); return { status: () => 200, headers: () => ({ 'content-type': 'text/html' }) }; },
            async waitForLoadState() {}, url() { return 'https://news.test/a'; }, async content() { return html; }, async title() { return 'T'; },
            async close() { log.pagesClosed += 1; }
          };
        },
        async close() {}
      };
    }
  };
  return { log, chromium: { async launch(o) { log.launches += 1; log.launchArgs = o.args; return browser; } } };
}
let readable = true;
class Stub extends ContentExtractor {
  parseHtml() {
    return { title: 'Tiêu đề', author: 'Tác giả', site_name: 'news.test', favicon: null, published_at: null, lang: 'vi', excerpt: 'e', clean_html: '<article><p>x</p></article>', raw_text: 'x', word_count: 1, reading_minutes: 1, readable, truncated: false, tier: 1, extraction_method: 'json-ld' };
  }
}

(async () => {
  /* ---------- LRU cache ---------- */
  {
    const f = fakeChromium();
    const ex = new Stub({ deps: { chromium: f.chromium }, settleMs: 0 });
    assert.ok(['lru-cache', 'fallback'].includes(ex.stats().cache.impl), 'cache impl: ' + ex.stats().cache.impl);
    const a = await ex.extract('https://news.test/a#frag1');
    assert.strictEqual(a.cached, false);
    const b = await ex.extract('https://news.test/a#frag2');         // fragment is not part of the key
    assert.strictEqual(b.cached, true);
    assert.strictEqual(f.log.gotos, 1, 'second call must not touch Chromium');
    assert.ok(b.duration_ms < 15, 'cache hit must be near-instant, got ' + b.duration_ms);
    assert.strictEqual(b.raw_text, a.raw_text);
    b.raw_text = 'mutated'; b.media.push({ url: 'x' });                // callers cannot corrupt the cache
    const c = await ex.extract('https://news.test/a');
    assert.strictEqual(c.raw_text, 'x'); assert.strictEqual(c.media.length, 0);
    const d = await ex.extract('https://news.test/a', { noCache: true });
    assert.strictEqual(d.cached, false); assert.strictEqual(f.log.gotos, 2, 'noCache must re-scrape');
    await ex.extract('https://news.test/other?id=1'); await ex.extract('https://news.test/other?id=2');
    assert.strictEqual(f.log.gotos, 4, 'query string is part of the key');
    const st = ex.stats().cache;
    assert.ok(st.hits >= 2 && st.misses >= 3 && st.entries === 3, JSON.stringify(st));
    assert.strictEqual(f.log.pagesOpen, f.log.pagesClosed, 'every page closed');
    assert.ok(f.log.launchArgs.includes('--disable-blink-features=AutomationControlled'));
    assert.ok(f.log.ctxOpts[0].timezoneId === 'UTC' || typeof f.log.ctxOpts[0].timezoneId === 'string');
    await ex.close();
  }
  /* TTL = 20 minutes by default, configurable */
  {
    assert.strictEqual(new Stub({ deps: {} }).stats().cache.ttlMs, 20 * 60 * 1000);
    const f = fakeChromium();
    const ex = new Stub({ deps: { chromium: f.chromium }, settleMs: 0, cacheTtlMs: 40 });
    await ex.extract('https://news.test/ttl');
    await new Promise(r => setTimeout(r, 90));
    const again = await ex.extract('https://news.test/ttl');
    assert.strictEqual(again.cached, false, 'entry must expire after the TTL');
    assert.strictEqual(f.log.gotos, 2);
    await ex.close();
  }
  /* concurrent identical requests share one scrape */
  {
    const f = fakeChromium();
    const ex = new Stub({ deps: { chromium: f.chromium }, settleMs: 0 });
    const rs = await Promise.all([1, 2, 3, 4].map(() => ex.extract('https://news.test/burst')));
    assert.strictEqual(f.log.gotos, 1);
    assert.ok(rs.every(r => r.raw_text === 'x'));
    await ex.close();
  }
  /* unreadable results are never cached */
  {
    readable = false;
    const f = fakeChromium();
    const ex = new Stub({ deps: { chromium: f.chromium }, settleMs: 0 });
    await ex.extract('https://news.test/empty'); await ex.extract('https://news.test/empty');
    assert.strictEqual(f.log.gotos, 2, 'unreadable pages must be retried, not cached');
    await ex.close();
    readable = true;
  }
  /* EMBED / WEBVIEW stay hybrid-routed: no Chromium, never cached */
  {
    const f = fakeChromium();
    const ex = new Stub({ deps: { chromium: f.chromium }, settleMs: 0 });
    const yt = await ex.extract('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    const fb = await ex.extract('https://www.facebook.com/');
    assert.strictEqual(yt.mode, 'EMBED'); assert.strictEqual(fb.mode, 'WEBVIEW');
    assert.strictEqual(yt.cached, false);
    assert.strictEqual(f.log.launches, 0);
    await ex.close();
  }
  /* failures are not cached and still release the page */
  {
    const f = fakeChromium();
    f.chromium.launch = async function () { f.log.launches += 1; return { connected: true, isConnected() { return true; }, on() {}, async close() {}, async newContext() { return { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, async route() {}, async addInitScript() {}, async close() {}, async newPage() { return { on() {}, async goto() { throw new Error('page.goto: Timeout 30000ms exceeded.'); }, async close() { f.log.pagesClosed += 1; } }; } }; } }; };
    const ex = new Stub({ deps: { chromium: f.chromium }, settleMs: 0 });
    await assert.rejects(() => ex.extract('https://news.test/slow'), e => e.code === 'NAVIGATION_TIMEOUT');
    assert.strictEqual(f.log.pagesClosed, 1, 'page closed in finally after a timeout');
    await ex.close();
  }

  /* ---------- engine: shared extractor, stealth wiring, reload bypasses cache ---------- */
  {
    const seen = [];
    const fake = { async warmUp() {}, isAlive() { return true; }, async close() {}, stats() { return {}; },
      async extract(url, opts) { seen.push(opts); return { ok: true, url, final_url: url, title: 'T', kind: 'html', media: [] }; } };
    const engine = createEngine({ extractor: fake });
    await engine.start();
    await engine.handle({ type: 'create', id: 't1', url: 'https://news.test/a' });
    await engine.handle({ type: 'navigate', id: 't1', url: 'https://news.test/b' });
    await engine.handle({ type: 'back', id: 't1' });
    await engine.handle({ type: 'reload', id: 't1' });
    assert.deepStrictEqual(seen.map(o => o.noCache), [false, false, false, true], 'only reload skips the cache');
    await engine.stop();
    const real = createEngine();
    assert.strictEqual(real.extractor.opts.stealth, STEALTH);
    assert.strictEqual(real.extractor.opts.locale, 'en-US');
assert.ok(STEALTH.acceptLanguage.includes('en'));
    await real.stop();
  }

  /* ---------- JSON schema of GET /api/browser/parse ---------- */
  {
    const out = gw.toParseSchema({
      mode: 'READER', url: 'https://example.com/bai-viet', final_url: 'https://example.com/bai-viet', cached: true,
      title: 'Tiêu đề bài viết', author: 'Tác giả', site_name: 'example.com',
      clean_html: '<article>...</article>', raw_text: 'Nội dung văn bản thuần...', reading_minutes: 2,
      media: [{ url: 'https://cdn.example.com/a.mp4', type: 'mp4' }, { url: 'https://cdn.example.com/s.m3u8', type: 'm3u8' }]
    });
    assert.deepStrictEqual(
      { success: out.success, mode: out.mode, url: out.url, cached: out.cached,
        metadata: { title: out.metadata.title, byline: out.metadata.byline, siteName: out.metadata.siteName },
        content: { clean_html: out.content.clean_html, raw_text: out.content.raw_text, reading_time_min: out.content.reading_time_min } },
      { success: true, mode: 'READER', url: 'https://example.com/bai-viet', cached: true,
        metadata: { title: 'Tiêu đề bài viết', byline: 'Tác giả', siteName: 'example.com' },
        content: { clean_html: '<article>...</article>', raw_text: 'Nội dung văn bản thuần...', reading_time_min: 2 } });
    assert.deepStrictEqual(out.media, { videos: [{ type: 'mp4', src: 'https://cdn.example.com/a.mp4' }, { type: 'hls', src: 'https://cdn.example.com/s.m3u8' }] });
    assert.strictEqual(out.content.reading_time_minutes, 2, 'legacy alias kept for the Reader UI');
    assert.strictEqual(gw.toParseSchema({ mode: 'READER', url: 'https://x.test/' }).cached, false);
    assert.deepStrictEqual(gw.toParseSchema({ mode: 'READER', url: 'https://x.test/' }).media, { videos: [] });
  }
  console.log('PASS stealth + lru cache + page lifecycle + parse schema');
})().catch(e => { console.error(e); process.exit(1); });
