'use strict';
const assert = require('assert');
const { handle, render, esc } = require('../../lib/reader-view');

function run(engine, headers = {}, method = 'GET') {
  const out = { headers: {}, body: '' };
  const res = { writeHead(code, h) { out.code = code; out.headers = h; }, end(b) { out.body = b ? String(b) : ''; } };
  handle({ method, headers }, res, engine);
  return out;
}
const engineWith = view => ({ getContent: () => ({ rev: 7, active: 't', ...view }) });

// empty state, both languages
let o = run(engineWith({ tab: null, content: null }), { 'accept-language': 'vi-VN,vi;q=0.9' });
assert.strictEqual(o.code, 200);
assert.ok(o.body.includes('Nhập địa chỉ'));
assert.ok(o.body.includes('<html lang="vi">'));
o = run(engineWith({ tab: null, content: null }), { 'accept-language': 'en-US' });
assert.ok(o.body.includes('Enter an address'));

// article with metadata, icons and media list
const content = { kind: 'html', readable: true, final_url: 'https://news.test/a', title: 'Tiêu đề <b>', site_name: 'News', author: 'An', published_at: '2026-03-05T00:00:00.000Z', reading_minutes: 3, word_count: 600, favicon: 'https://news.test/f.ico', clean_html: '<p>Nội dung</p>', media: [{ type: 'm3u8', url: 'https://cdn.test/x.m3u8' }] };
o = run(engineWith({ tab: { id: 't' }, content, loading: false }), { 'accept-language': 'vi' });
assert.ok(o.body.includes('<p>Nội dung</p>'));
assert.ok(o.body.includes('Tiêu đề &lt;b&gt;'), 'title must be escaped');
assert.ok(o.body.includes('3 phút đọc'));
assert.ok(o.body.includes('M3U8'));
assert.ok(o.body.includes('2026-03-05'));
assert.ok(!o.body.includes('Tiêu đề <b>'));

// strict CSP + nonce + framing rules
const csp = o.headers['Content-Security-Policy'];
const nonce = (csp.match(/script-src 'nonce-([^']+)'/) || [])[1];
assert.ok(nonce && o.body.includes(`<script nonce="${nonce}">`));
assert.ok(csp.includes("default-src 'none'") && csp.includes("base-uri 'none'") && !csp.includes("'unsafe-eval'"));
assert.strictEqual(o.headers['X-Frame-Options'], 'SAMEORIGIN');
assert.ok(o.body.includes('rev=7') || o.body.includes('var rev=7'));

// error, loading, non-html file
o = run(engineWith({ tab: { id: 't' }, content: null, loading: false, error: { message: 'DNS <fail>' } }), { 'accept-language': 'en' });
assert.ok(o.body.includes('Page unavailable') && o.body.includes('DNS &lt;fail&gt;'));
o = run(engineWith({ tab: { id: 't' }, content: null, loading: true }), { 'accept-language': 'en' });
assert.ok(o.body.includes('Loading page'));
o = run(engineWith({ tab: { id: 't' }, content: { ...content, kind: 'pdf', clean_html: '' } }), { 'accept-language': 'en' });
assert.ok(o.body.includes('is a file'));

// unreadable pages are labelled; only GET/HEAD allowed
o = run(engineWith({ tab: { id: 't' }, content: { ...content, readable: false } }), { 'accept-language': 'en' });
assert.ok(o.body.includes('No clear article'));
assert.strictEqual(run(engineWith({}), {}, 'POST').code, 405);
assert.strictEqual(esc('<&"\'>'), '&lt;&amp;&quot;&#39;&gt;');
console.log('PASS reader view (i18n, escaping, CSP, states)');
