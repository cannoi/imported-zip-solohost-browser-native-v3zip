'use strict';
const assert = require('assert');
const fp = require('./lib/frame-proxy');
const yt = require('./lib/adapters/youtube');
(async () => {
  const url = 'https://www.youtube.com/results?search_query=Phim%20hay';
  const doc = await fp.fetchDocument(url);
  assert.ok((doc.body || '').length > 1000, 'body after redirect+gzip');
  assert.ok(/ytInitialData/.test(doc.body));
  const items = yt.parseSearchResults(doc.body);
  assert.ok(items.length >= 5, 'parsed >=5 got ' + items.length);
  const y = yt.renderYouTube(doc.finalUrl || url, doc.body, {});
  assert.ok(y.count >= 5);
  assert.ok(y.html.includes('class="card"'));
  assert.ok(!/Empty response/.test(y.html));
  console.log('[PASS] v10.41 youtube live', items.length, 'videos');
})().catch(e => { console.error(e); process.exit(1); });
