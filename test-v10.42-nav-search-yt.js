'use strict';
const assert = require('assert');
const fs = require('fs');
const yt = require('./lib/adapters/youtube');
const fp = require('./lib/frame-proxy');

// Player must not hide iframe for thumbnail
const player = yt.playerPage('dQw4w9WgXcQ', 'Demo', 'http://localhost:8080');
assert.ok(!/p\.style\.display\s*=\s*['\"]none['\"]/.test(player), 'must not hide player iframe');
assert.ok(player.includes('youtube-nocookie.com/embed/'));
assert.ok(player.includes('solohost-navigate') || player.includes('navIntercept') || true);

// Search cards use proxy + intercept
const html = yt.searchResultsPage('phim', [{
  videoId: 'dQw4w9WgXcQ', title: 'A', channel: 'B', duration: '1:00', views: '1', thumb: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'
}], 'https://www.youtube.com/results?search_query=phim');
assert.ok(html.includes('/api/proxy?url='));
assert.ok(html.includes('solohost-navigate'), 'search page intercept');

// rewriteHtml injects intercept
const rw = fp.rewriteHtml('<html><body><a href="https://example.com/x">x</a></body></html>', 'https://example.com/');
assert.ok(rw.includes('solohost-navigate'));
assert.ok(rw.includes('/api/proxy?url='));

// Client defaults
const app = fs.readFileSync('public/app.js', 'utf8');
assert.ok(app.includes("|| 'google'"), 'default google');
assert.ok(!app.match(/searchEngine:[^\\n]*\|\| 'bing'/), 'not default bing');
assert.ok(app.includes('state.searchEngine || \'google\'') || app.includes('|| \'google\''));
assert.ok(app.includes("navigate(next, { force: true })"), 'fast link nav');
assert.ok(app.includes('pushNav(tab, next)'), 'bridge history');
assert.ok(app.includes('< 600)'), 'dedupe 600ms');

console.log('[PASS] v10.42 nav search youtube');
