'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const monitor = require(path.join(root, 'lib/performance-monitor'));
const gw = require(path.join(root, 'browser-gateway.js'));

const sample = monitor.sample({ status: 'ready', tabs: [{ id: 'home' }], active: 'home', processIds: {} });
assert.ok(sample.node && Number.isFinite(sample.node.rssBytes));
assert.ok(sample.cgroupMemory && 'currentBytes' in sample.cgroupMemory);
assert.strictEqual(sample.browser.tabCount, 1);

const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
assert.ok(server.includes("p === '/api/performance'") || server.includes('/api/performance'));
assert.ok(fs.existsSync(path.join(root, 'scripts/benchmark.js')));

// Schema mapping of extract result must be well under 3 seconds (pure CPU, no network).
const t0 = Date.now();
for (let i = 0; i < 200; i++) {
  const schema = gw.toParseSchema({
    url: 'https://example.com/post/' + i,
    final_url: 'https://example.com/post/' + i,
    title: 'Sample Article ' + i,
    author: 'Author',
    site_name: 'Example',
    favicon: 'https://example.com/favicon.ico',
    clean_html: '<p>' + 'word '.repeat(80) + '</p>',
    raw_text: ('word '.repeat(80)).trim(),
    reading_minutes: 2,
    word_count: 80,
    readable: true,
    media: [
      { url: 'https://cdn.example.com/v.mp4', type: 'mp4' },
      { url: 'https://cdn.example.com/s.m3u8', type: 'm3u8' }
    ]
  });
  assert.strictEqual(schema.success, true);
  assert.ok(schema.metadata.title);
  assert.ok(schema.content.clean_html.includes('<p>'));
  assert.ok(schema.media.videos.length >= 1);
}
const elapsed = Date.now() - t0;
assert.ok(elapsed < 3000, 'schema mapping of 200 articles took ' + elapsed + 'ms (need < 3000ms)');
console.log('PASS performance telemetry + parse schema <3s (' + elapsed + 'ms for 200 maps)');
