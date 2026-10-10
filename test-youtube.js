'use strict';
const assert = require('assert');
const dns = require('dns').promises;
const proxy = require('./lib/frame-proxy');

// --- pure helpers ---
assert.strictEqual(proxy.youtubeVideoId(new URL('https://www.youtube.com/watch?v=VE3vaEdKOCk')), 'VE3vaEdKOCk');
assert.strictEqual(proxy.youtubeVideoId(new URL('https://youtu.be/Qi3i7bzTacI?t=3')), 'Qi3i7bzTacI');
assert.strictEqual(proxy.youtubeVideoId(new URL('https://www.youtube.com/shorts/abcDEF12345')), 'abcDEF12345');
assert.strictEqual(proxy.youtubeVideoId(new URL('https://www.youtube.com/results?search_query=x')), null);
assert.ok(proxy.youtubePlayerPage('VE3vaEdKOCk', 'T <b>', 'http://h:1').includes('youtube.com/embed/VE3vaEdKOCk'));
assert.ok(!proxy.youtubePlayerPage('VE3vaEdKOCk', 'T <b>', '').includes('<b>'), 'title escaped');

const yt = { contents: { a: [{ videoRenderer: { videoId: 'AAAAAAAAAAA', title: { runs: [{ text: 'Phim "hay" {x}' }] },
  ownerText: { runs: [{ text: 'Kênh' }] }, lengthText: { simpleText: '10:00' }, viewCountText: { simpleText: '1 N lượt xem' } } },
  { videoRenderer: { videoId: 'BBBBBBBBBBB', title: { simpleText: 'Two' } } }] } };
// large page (> old 120KB cap) with braces/quotes inside strings
const page = '<html><script>var ytcfg={};</script><script>var ytInitialData = ' + JSON.stringify(yt) + ';</script>' + 'x'.repeat(200000) + '</html>';
const items = proxy.parseYoutubeResults(page);
assert.strictEqual(items.length, 2);
assert.strictEqual(items[0].title, 'Phim "hay" {x}');
const rp = proxy.youtubeResultsPage('phim hay', items, 'http://h:1');
assert.ok(rp.includes('/api/proxy?url=' + encodeURIComponent('https://www.youtube.com/watch?v=AAAAAAAAAAA')));
assert.ok(!/<script/i.test(rp), 'native pages need no JS');

// Fallback forms must be plain GET to /api/browser/go and survive without scripts
const gf = proxy.googleFallbackHtml('phim', null, 'http://h:1');
assert.ok(gf.includes('action="http://h:1/api/browser/go"') && !/<script/i.test(gf));

// --- end-to-end with mocked network ---
dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
const realFetch = global.fetch;
function mockRes() {
  return { code: 200, headers: {}, body: '', removeHeader() {}, setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; }, type() { return this; }, send(b) { this.body = String(b); return this; }, redirect() {} };
}
function mockReq(url) { return { query: { url }, headers: { host: 'h:1' }, protocol: 'http' }; }
function htmlResp(body, url) {
  return { status: 200, url, headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
    body: new ReadableStream({ start(c) { c.enqueue(Buffer.from(body)); c.close(); } }) };
}
(async () => {
  // 1) /results -> native list
  global.fetch = async (u) => htmlResp(page, u);
  let r = mockRes();
  await proxy.handleProxy(mockReq('https://www.youtube.com/results?search_query=phim'), r);
  assert.ok(r.body.includes('Phim &quot;hay&quot;') && r.body.includes('i.ytimg.com/vi/AAAAAAAAAAA'), 'results rendered natively');

  // 2) /watch -> player page, never the skeleton
  global.fetch = async (u) => String(u).includes('oembed')
    ? { ok: true, json: async () => ({ title: 'Tiêu đề video' }) } : htmlResp('<html>skeleton</html>', u);
  r = mockRes();
  await proxy.handleProxy(mockReq('https://www.youtube.com/watch?v=VE3vaEdKOCk'), r);
  assert.ok(r.body.includes('/embed/VE3vaEdKOCk') && r.body.includes('Tiêu đề video'), 'watch -> player');

  // 3) Google interstitial -> auto DuckDuckGo results
  const interstitial = '<html><title>Google Search</title><a href="/httpservice/retry/enablejs">x</a> please click here if you are not redirected</html>';
  global.fetch = async (u) => String(u).includes('duckduckgo')
    ? htmlResp('<html><head></head><body><div class="result">KẾT QUẢ DDG</div></body></html>', u) : htmlResp(interstitial, u);
  r = mockRes();
  await proxy.handleProxy(mockReq('https://www.google.com/search?q=Phim'), r);
  assert.ok(r.body.includes('KẾT QUẢ DDG'), 'google interstitial -> DDG results');
  // 4) second search skips Google entirely
  let googleHit = false;
  global.fetch = async (u) => { if (String(u).includes('google.com')) googleHit = true; return htmlResp('<html><body>DDG2</body></html>', u); };
  r = mockRes();
  await proxy.handleProxy(mockReq('https://www.google.com/search?q=Phim2'), r);
  assert.ok(!googleHit && r.body.includes('DDG2'), 'google skipped while blocked');

  // 5) DDG POST form becomes GET
  const out = proxy.rewriteHtml('<html><head></head><body><form action="/html/" method="post"><input name="q"></form></body></html>', 'https://html.duckduckgo.com/html/?q=a');
  assert.ok(/method="get"/.test(out) && !/method="post"/i.test(out));

  global.fetch = realFetch;
  console.log('✓ youtube / google proxy regression tests');
})().catch(e => { console.error(e); process.exit(1); });
