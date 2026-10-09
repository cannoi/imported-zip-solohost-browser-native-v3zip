'use strict';
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const T = require(path.join(root, 'lib/extraction-tiers.js'));
const { ContentExtractor, detectChallenge, TIER1_MIN_WORDS } = require(path.join(root, 'lib/content-extractor.js'));

const sentence = 'Đây là một câu trong bài viết thử nghiệm, đủ dài để mô phỏng nội dung thật của báo điện tử. ';
const body = sentence.repeat(12).trim();           // ~200 words
assert.ok(body.split(/\s+/).length > TIER1_MIN_WORDS);

/* ---------- tracker hosts ---------- */
for (const h of ['www.google-analytics.com', 'stats.g.doubleclick.net', 'connect.facebook.net', 'analytics.tiktok.com', 'static.hotjar.com', 'cdn.adtima.vn']) assert.ok(T.isTrackerHost(h), h);
for (const h of ['example.com', 'facebook.com', 'vnexpress.net', 'cdn.jsdelivr.net', 'notanalytics.com']) assert.ok(!T.isTrackerHost(h), h);

/* ---------- Tier 1: JSON-LD ---------- */
const ldPage = (obj, extra = '') => `<!doctype html><html lang="vi"><head><title>Tiêu đề | Báo Mẫu</title>
  <meta property="og:site_name" content="Báo Mẫu"><link rel="icon" href="/fav.png">${extra}
  <script type="application/ld+json">${JSON.stringify(obj)}</script></head><body><div id="root"></div></body></html>`;

{ // NewsArticle inside @graph with typed array + HTML entities + author object
  const html = ldPage({ '@context': 'https://schema.org', '@graph': [
    { '@type': 'WebSite', name: 'Báo Mẫu' },
    { '@type': ['NewsArticle', 'Thing'], headline: 'Tin &amp; Bài', articleBody: body, description: 'Mô tả ngắn của bài viết này.',
      author: [{ '@type': 'Person', name: 'Nguyễn Văn A' }], publisher: { '@type': 'Organization', name: 'Báo Mẫu' }, datePublished: '2026-03-05T08:00:00+07:00' }
  ] });
  const ld = T.findJsonLdArticle(html);
  assert.ok(ld && ld.body.length > 500);
  assert.strictEqual(ld.headline, 'Tin & Bài');
  assert.strictEqual(ld.author, 'Nguyễn Văn A');
  assert.strictEqual(ld.publisher, 'Báo Mẫu');

  const out = new ContentExtractor().parseHtml(html, 'https://baomau.test/bai-viet');
  assert.strictEqual(out.tier, 1);
  assert.strictEqual(out.extraction_method, 'json-ld');
  assert.strictEqual(out.title, 'Tin & Bài');
  assert.strictEqual(out.author, 'Nguyễn Văn A');
  assert.strictEqual(out.site_name, 'Báo Mẫu');
  assert.strictEqual(out.favicon, 'https://baomau.test/fav.png');
  assert.strictEqual(out.lang, 'vi');
  assert.ok(out.published_at.startsWith('2026-03-0'));
  assert.ok(out.clean_html.startsWith('<article>') && out.clean_html.endsWith('</article>'));
  assert.ok(out.word_count > 150 && out.reading_minutes >= 1);
  assert.strictEqual(out.readable, true);
  assert.strictEqual(out.needs_hydration, false);
}
{ // BlogPosting with raw control chars in the JSON (common CMS bug) still parses
  const raw = '{"@type":"BlogPosting","headline":"H","articleBody":"' + body.replace(/\. /g, '.\n\n') + '"}';
  const html = `<html><head><script type="application/ld+json">${raw}</script></head><body></body></html>`;
  const ld = T.findJsonLdArticle(html);
  assert.ok(ld && ld.body.includes('\n'));
  const out = new ContentExtractor().parseHtml(html, 'https://blog.test/p');
  assert.strictEqual(out.tier, 1);
  assert.ok((out.clean_html.match(/<p>/g) || []).length >= 10, 'paragraphs preserved');
}
{ // HTML inside articleBody is not trusted without jsdom → skipped here, covered in the jsdom block
  const ld = T.findJsonLdArticle(ldPage({ '@type': 'Article', headline: 'X', articleBody: '<p>x</p>' }));
  assert.ok(ld && T.bodyKind(ld.body).hasMarkup);
}
{ // teaser-only articleBody (< threshold) must NOT win Tier 1
  const html = ldPage({ '@type': 'NewsArticle', headline: 'Teaser', articleBody: 'Chỉ có vài từ.', description: 'd' });
  const ld = T.findJsonLdArticle(html);
  assert.ok(ld && T.bodyKind(ld.body).words < TIER1_MIN_WORDS);
}
{ // non-article types are ignored
  assert.strictEqual(T.findJsonLdArticle(ldPage({ '@type': 'Product', name: 'Giày', description: body })), null);
  assert.strictEqual(T.findJsonLdArticle('<html><body>no ld here</body></html>'), null);
}

/* ---------- Tier 3: hydration ---------- */
{
  const next = { props: { pageProps: { menu: [{ title: 'Trang chủ', body: 'x' }], article: { title: 'Bài từ Next', author: { name: 'Lê B' }, publishedAt: '2026-02-01T00:00:00Z', content: '<p>' + body + '</p>' } } } };
  const html = `<html><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script></body></html>`;
  const src = T.extractHydrationFromHtml(html);
  assert.strictEqual(src.length, 1);
  const found = T.findBodyInHydration(src[0].data);
  assert.ok(found && found.isHtml);
  assert.strictEqual(found.title, 'Bài từ Next');
  assert.strictEqual(found.author, 'Lê B');
  assert.ok(found.published.startsWith('2026-02-01'));
  assert.strictEqual(T.findBodyInHydration({ a: { css: '.x{color:red}'.repeat(80), body: '{"json":' + '1,'.repeat(300) + '}' } }), null, 'code/JSON blobs are not articles');
  // Nuxt 3 flat payload (keyless long strings)
  const nuxt = [['ShallowReactive', 1], { data: 2 }, { post: 3 }, 'tiêu đề', body];
  const f2 = T.findBodyInHydration(nuxt);
  assert.ok(f2 && f2.body === body);
}

/* ---------- static helpers ---------- */
{
  const html = `<html lang="en-GB"><head><title> A &amp; B </title><meta name="author" content="By Ann Lee"><meta property="og:site_name" content="Site">
    <link rel="apple-touch-icon" href="/a.png"></head><body><video src="/v/clip.mp4"></video><source src="https://cdn.test/live.m3u8"><meta property="og:video" content="/x.mp4"></body></html>`;
  const q = T.quickMeta(html, 'https://s.test/p');
  assert.strictEqual(q.title, 'A & B');
  assert.strictEqual(q.author, 'Ann Lee');
  assert.strictEqual(q.site_name, 'Site');
  assert.strictEqual(q.favicon, 'https://s.test/a.png');
  assert.strictEqual(q.lang, 'en-GB');
  const v = T.scanVideoSources(html, 'https://s.test/p');
  assert.deepStrictEqual(v.map(x => x.type + ':' + x.url), ['mp4:https://s.test/v/clip.mp4', 'm3u8:https://cdn.test/live.m3u8', 'mp4:https://s.test/x.mp4']);
}

/* ---------- challenge detection: no more false positives ---------- */
{
  const article = '<html><body><form><div class="g-recaptcha"></div></form></body></html>';
  assert.strictEqual(detectChallenge(article, body.repeat(2), 'https://x.test/'), null, 'recaptcha widget on a real article is not a challenge');
  assert.ok(detectChallenge(article, 'Vui lòng xác minh', 'https://x.test/'), 'recaptcha on an otherwise empty page is');
  assert.ok(detectChallenge('<html>Checking your browser before accessing example.com</html>', 'x'.repeat(5000), 'https://x.test/'));
}

/* ---------- Tier 2 / 3 with real jsdom + readability (skipped when not installed) ---------- */
let haveLibs = true;
try { require.resolve('jsdom'); require.resolve('@mozilla/readability'); } catch { haveLibs = false; }
if (!haveLibs) {
  console.log('SKIP tier 2/3 jsdom checks (jsdom / @mozilla/readability not installed in this environment)');
} else {
  const ex = new ContentExtractor();
  const para = n => `<p>${sentence.repeat(2)} (${n})</p>`;
  { // Tier 2: classic article page, no JSON-LD
    const html = `<html lang="vi"><head><title>Bài | Báo</title></head><body><nav><a href="/a">Menu</a></nav><article><h1>Bài</h1>${[1,2,3,4,5,6].map(para).join('')}</article><footer>Bản quyền</footer></body></html>`;
    const out = ex.parseHtml(html, 'https://baomau.test/b');
    assert.strictEqual(out.tier, 2); assert.strictEqual(out.extraction_method, 'readability'); assert.strictEqual(out.needs_hydration, false);
    assert.ok(out.raw_text.includes('câu trong bài viết') && !out.raw_text.includes('Bản quyền'));
  }
  { // Tier 3a: client-rendered shell + __NEXT_DATA__
    const next = { props: { pageProps: { post: { title: 'Bài Next', content: '<p>' + body + '</p>' } } } };
    const html = `<html><head><title>T</title></head><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script></body></html>`;
    const out = ex.parseHtml(html, 'https://app.test/p');
    assert.strictEqual(out.tier, 3); assert.ok(out.extraction_method.startsWith('hydration:'));
    assert.ok(out.raw_text.includes('câu trong bài viết')); assert.strictEqual(out.needs_hydration, false);
  }
  { // Tier 3a via window globals handed in from the live page
    const html = '<html><head><title>T</title></head><body><div id="app"></div></body></html>';
    const out = ex.parseHtml(html, 'https://app.test/p', { hydration: [{ source: 'window.__NUXT__', data: { data: [{ article: { title: 'N', body } }] } }] });
    assert.strictEqual(out.tier, 3); assert.strictEqual(out.extraction_method, 'hydration:window.__NUXT__');
  }
  { // Tier 3c: nothing structured, only live innerText
    const out = ex.parseHtml('<html><body><div id="app"></div></body></html>', 'https://app.test/p', { innerText: body });
    assert.strictEqual(out.tier, 3); assert.strictEqual(out.extraction_method, 'inner-text');
  }
  { // empty SPA shell asks for the slow path
    const out = ex.parseHtml('<html><head><title>App</title></head><body><div id="root"></div></body></html>', 'https://app.test/');
    assert.strictEqual(out.needs_hydration, true); assert.strictEqual(out.readable, false);
  }
  { // markup inside JSON-LD articleBody is sanitised
    const html = ldPage({ '@type': 'Article', headline: 'H', articleBody: `<p onclick="x()">${body}</p><script>alert(1)</script><a href="javascript:alert(2)">bad</a>` });
    const out = ex.parseHtml(html, 'https://baomau.test/x');
    assert.strictEqual(out.tier, 1);
    for (const bad of ['<script', 'onclick', 'javascript:', 'alert(']) assert.ok(!out.clean_html.includes(bad), bad);
  }
  console.log('PASS tier 2/3 with real jsdom + readability');
}
console.log('PASS extraction-tiers');
