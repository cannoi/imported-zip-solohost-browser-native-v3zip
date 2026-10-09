const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const gw = require(path.join(root, 'browser-gateway.js'));
assert.strictEqual(typeof gw.parseUrl, 'function');
assert.strictEqual(typeof gw.chromiumHealth, 'function');
assert.strictEqual(gw.isValidHttpUrl('https://example.com'), true);
assert.strictEqual(gw.isValidHttpUrl('ftp://x'), false);
const schema = gw.toParseSchema({
  url: 'https://example.com/a',
  final_url: 'https://example.com/a',
  title: 'Hello',
  author: 'Ann',
  site_name: 'Example',
  favicon: 'https://example.com/f.ico',
  clean_html: '<p>x</p>',
  raw_text: 'x',
  reading_minutes: 2,
  media: [{ url: 'https://cdn.example/v.mp4', type: 'mp4' }, { url: 'https://cdn.example/s.m3u8', type: 'm3u8' }]
});
assert.strictEqual(schema.success, true);
assert.strictEqual(schema.metadata.title, 'Hello');
assert.strictEqual(schema.metadata.byline, 'Ann');
assert.strictEqual(schema.content.reading_time_minutes, 2);
assert.strictEqual(schema.media.videos.length, 2);
assert.ok(schema.media.videos.some(v => v.type === 'hls'));
assert.ok(schema.media.videos.some(v => v.type === 'mp4'));
const serverSrc = require('fs').readFileSync(path.join(root, 'server.js'), 'utf8');
assert.ok(serverSrc.includes("require('express')"));
assert.ok(serverSrc.includes('/api/browser/parse'));
assert.ok(serverSrc.includes('handleApiHealth') || serverSrc.includes('chromiumHealth'));
console.log('PASS api-gateway');
