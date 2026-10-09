'use strict';
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.SOLOHOST_BROWSER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'solohost-test-'));
const root = path.join(__dirname, '..', '..');
const X = require(path.join(root, 'lib/content-extractor'));
const { ContentExtractor, ExtractorError } = X;

/* ---------- pure helpers ---------- */
assert.strictEqual(X.normalizeText('  a \t b\r\n\r\n\r\n\r\nc  '), 'a b\n\nc');
assert.strictEqual(X.countWords('xin chào  thế giới\nvui'), 5);
assert.strictEqual(X.toIsoDate('2026-03-05T10:00:00+07:00'), '2026-03-05T03:00:00.000Z');
assert.strictEqual(X.toIsoDate('abc'), null);
assert.strictEqual(X.toIsoDate('1800-01-01'), null);
assert.strictEqual(X.safeUrl('/a?b=1', 'https://x.test/p'), 'https://x.test/a?b=1');
assert.strictEqual(X.safeUrl('javascript:alert(1)', 'https://x.test/'), null);
assert.strictEqual(X.cleanAuthor('By   Nguyễn Văn A'), 'Nguyễn Văn A');
assert.strictEqual(X.cleanAuthor('Tác giả: Lê B'), 'Lê B');
assert.strictEqual(X.cleanAuthor('https://facebook.com/someone'), null);
assert.strictEqual(X.pickLocale('vi-VN,vi;q=0.9,en;q=0.8'), 'vi-VN');
assert.strictEqual(X.pickLocale('???', 'en-US'), 'en-US');

/* ---------- fake Playwright ---------- */
function makeFakeChromium(scenario = {}) {
  const log = { launches: 0, contexts: [], closedContexts: 0, routes: [], maxParallel: 0, parallel: 0 };
  const browser = {
    connected: true,
    version: () => '120.0.6099.28',
    isConnected() { return this.connected; },
    on() {},
    async close() { this.connected = false; },
    async newContext(opts) {
      const ctx = {
        opts,
        setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
        async route(pattern, handler) { log.routes.push(handler); },
        async newPage() {
          const handlers = {};
          return {
            on(evt, fn) { handlers[evt] = fn; },
            async goto(url, o) {
              log.lastGoto = { url, o };
              log.parallel += 1; log.maxParallel = Math.max(log.maxParallel, log.parallel);
              try {
                if (scenario.delay) await new Promise(r => setTimeout(r, scenario.delay));
                if (scenario.gotoError) throw new Error(scenario.gotoError);
                for (const r of scenario.responses || []) handlers.response && handlers.response(r);
                return { status: () => scenario.status || 200, headers: () => ({ 'content-type': scenario.contentType || 'text/html; charset=utf-8' }) };
              } finally { log.parallel -= 1; }
            },
            async waitForLoadState() {},
            url() { return scenario.finalUrl || log.lastGoto.url; },
            async content() { return '<html><body>hi</body></html>'; },
            async title() { return 'Fallback title'; }
          };
        },
        async close() { log.closedContexts += 1; }
      };
      log.contexts.push(ctx);
      return ctx;
    }
  };
  return { log, browser, chromium: { async launch() { log.launches += 1; browser.connected = true; return browser; } } };
}
const resp = (url, status, headers) => ({ url: () => url, status: () => status, headers: () => headers || {} });

class Stub extends ContentExtractor {
  parseHtml(html, url) {
    this.parsedWith = { html, url };
    return { title: 'Parsed title', author: 'Tác giả', site_name: 'Site', favicon: 'https://x.test/favicon.ico', published_at: '2026-01-02T00:00:00.000Z', lang: 'vi', excerpt: 'ex', clean_html: '<p>x</p>', raw_text: 'x', word_count: 1, reading_minutes: 1, readable: true, truncated: false };
  }
}

(async () => {
  /* happy path + media sniffing + locale */
  {
    const f = makeFakeChromium({
      finalUrl: 'https://example.com/final',
      responses: [resp('https://cdn.example.com/live/master.m3u8', 200, { 'content-type': 'application/vnd.apple.mpegurl' }), resp('https://cdn.example.com/clip.mp4', 200, { 'content-type': 'video/mp4' }), resp('https://example.com/app.js', 200, { 'content-type': 'text/javascript' })]
    });
    const ex = new Stub({ deps: { chromium: f.chromium }, settleMs: 0 });
    const out = await ex.extract('https://example.com/post', { acceptLanguage: 'vi-VN,vi;q=0.9' });
    assert.strictEqual(f.log.lastGoto.o.waitUntil, 'domcontentloaded');
    assert.strictEqual(f.log.contexts[0].opts.locale, 'vi-VN');
    assert.ok(!/Headless/i.test(f.log.contexts[0].opts.userAgent), 'user agent must not say HeadlessChrome');
    assert.strictEqual(f.log.contexts[0].opts.acceptDownloads, false);
    assert.strictEqual(ex.parsedWith.url, 'https://example.com/final');
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.final_url, 'https://example.com/final');
    for (const k of ['title', 'author', 'site_name', 'favicon', 'published_at', 'clean_html', 'raw_text', 'media', 'extracted_at', 'duration_ms']) assert.ok(k in out, 'missing field ' + k);
    assert.deepStrictEqual(out.media.map(m => m.type), ['m3u8', 'mp4']);
    assert.strictEqual(f.log.closedContexts, 1, 'context must be closed');
    await ex.close();
    assert.strictEqual(f.browser.connected, false);
  }
  /* HTTP error */
  {
    const f = makeFakeChromium({ status: 404 });
    const ex = new Stub({ deps: { chromium: f.chromium }, settleMs: 0 });
    await assert.rejects(() => ex.extract('https://example.com/missing'), e => e.code === 'HTTP_ERROR' && e.httpStatus === 404);
    assert.strictEqual(f.log.closedContexts, 1);
  }
  /* non-HTML resources are not parsed */
  {
    const f = makeFakeChromium({ contentType: 'application/pdf' });
    const ex = new Stub({ deps: { chromium: f.chromium }, settleMs: 0 });
    const out = await ex.extract('https://example.com/doc.pdf');
    assert.strictEqual(out.kind, 'pdf');
    assert.strictEqual(out.readable, false);
    assert.strictEqual(ex.parsedWith, undefined);
  }
  /* error mapping */
  for (const [msg, code] of [['page.goto: Timeout 30000ms exceeded.', 'NAVIGATION_TIMEOUT'], ['net::ERR_NAME_NOT_RESOLVED at https://x', 'DNS_FAILED'], ['net::ERR_BLOCKED_BY_CLIENT', 'BLOCKED'], ['net::ERR_CERT_AUTHORITY_INVALID', 'TLS_ERROR'], ['net::ERR_CONNECTION_REFUSED', 'CONNECTION_FAILED']]) {
    const f = makeFakeChromium({ gotoError: msg });
    const ex = new Stub({ deps: { chromium: f.chromium }, settleMs: 0 });
    await assert.rejects(() => ex.extract('https://example.com/'), e => e instanceof ExtractorError && e.code === code, msg);
    assert.strictEqual(f.log.closedContexts, 1);
  }
  /* concurrency limit + queue overflow */
  {
    const f = makeFakeChromium({ delay: 30 });
    const ex = new Stub({ deps: { chromium: f.chromium }, settleMs: 0, maxConcurrent: 1, maxQueue: 5 });
    await Promise.all([1, 2, 3].map(i => ex.extract('https://example.com/' + i)));
    assert.strictEqual(f.log.maxParallel, 1);
    const g = makeFakeChromium({ delay: 30 });
    const busy = new Stub({ deps: { chromium: g.chromium }, settleMs: 0, maxConcurrent: 1, maxQueue: 0 });
    const first = busy.extract('https://example.com/a');
    await assert.rejects(() => busy.extract('https://example.com/b'), e => e.code === 'BUSY');
    await first;
  }
  /* browser relaunch after crash */
  {
    const f = makeFakeChromium();
    const ex = new Stub({ deps: { chromium: f.chromium }, settleMs: 0 });
    await ex.extract('https://example.com/1');
    f.browser.connected = false;
    await ex.extract('https://example.com/2');
    assert.strictEqual(f.log.launches, 2);
  }
  /* network route policy: private hosts and heavy resources are aborted */
  {
    const f = makeFakeChromium();
    const ex = new Stub({ deps: { chromium: f.chromium }, settleMs: 0 });
    await ex.extract('https://93.184.216.34/');
    const handler = f.log.routes[0];
    const run = async (url, type) => { let r; await handler({ request: () => ({ url: () => url, resourceType: () => type }), abort: async x => { r = 'abort:' + x; }, continue: async () => { r = 'continue'; } }); return r; };
    assert.strictEqual(await run('http://10.0.0.5/admin', 'document'), 'abort:blockedbyclient');
    assert.strictEqual(await run('http://localhost:8080/', 'xhr'), 'abort:blockedbyclient');
    assert.strictEqual(await run('http://169.254.169.254/latest/meta-data', 'fetch'), 'abort:blockedbyclient');
    assert.strictEqual(await run('chrome://settings', 'document'), 'abort:blockedbyclient');
    assert.strictEqual(await run('https://93.184.216.34/pic.png', 'image'), 'abort:blockedbyclient');
    assert.strictEqual(await run('https://93.184.216.34/page', 'document'), 'continue');
    assert.strictEqual(await run('https://93.184.216.34/video.mp4', 'media'), 'continue');
  }
  /* missing dependency is reported clearly */
  {
    const ex = new ContentExtractor({ deps: {} });
    const real = (() => { try { require.resolve('playwright-core'); return true; } catch { return false; } })();
    if (!real) await assert.rejects(() => ex.extract('https://example.com/'), e => e.code === 'DEPENDENCY_MISSING');
  }

  /* ---------- real jsdom + readability (runs after `npm install`; skipped otherwise) ---------- */
  let haveLibs = true;
  try { require.resolve('jsdom'); require.resolve('@mozilla/readability'); } catch { haveLibs = false; }
  if (!haveLibs) {
    console.log('SKIP real jsdom/readability parsing (dependencies not installed in this environment)');
  } else {
    const para = 'Đây là một đoạn văn dài để Readability nhận ra nội dung chính của bài viết, có dấu phẩy, có nhiều từ, và đủ dài để vượt qua ngưỡng ký tự tối thiểu của thuật toán. ';
    const html = `<!doctype html><html lang="vi"><head><title>Bài viết thử nghiệm | Báo Mẫu</title>
      <meta property="og:site_name" content="Báo Mẫu"><meta name="author" content="Nguyễn Văn A">
      <meta property="article:published_time" content="2026-03-05T08:00:00+07:00">
      <link rel="icon" href="/static/fav.png"></head><body>
      <nav><a href="/a">Menu</a><a href="/b">Tin khác</a></nav>
      <article><h1>Bài viết thử nghiệm</h1>
      ${[1, 2, 3, 4, 5].map(i => `<p>${para.repeat(2)} (${i})</p>`).join('\n')}
      <p><img src="x" onerror="alert(1)"> <a href="javascript:alert(2)">bad</a> <a href="/ok">good</a></p>
      <script>alert(3)</script></article>
      <footer>Bản quyền</footer></body></html>`;
    const out = new ContentExtractor().parseHtml(html, 'https://baomau.test/bai-viet');
    assert.strictEqual(out.readable, true);
    assert.strictEqual(out.site_name, 'Báo Mẫu');
    assert.strictEqual(out.author, 'Nguyễn Văn A');
    assert.ok(out.published_at && out.published_at.startsWith('2026-03-0'));
    assert.strictEqual(out.favicon, 'https://baomau.test/static/fav.png');
    assert.strictEqual(out.lang, 'vi');
    assert.ok(out.raw_text.includes('đoạn văn dài'));
    assert.ok(out.word_count > 100 && out.reading_minutes >= 1);
    for (const bad of ['<script', 'onerror', 'javascript:', 'alert(3)']) assert.ok(!out.clean_html.includes(bad), 'clean_html must not contain ' + bad);
    assert.ok(out.clean_html.includes('https://baomau.test/ok'));
    console.log('PASS real jsdom + readability parsing');
  }

  console.log('PASS content extractor (orchestration, media sniffing, policy, errors, concurrency)');
})().catch(e => { console.error(e); process.exit(1); });
