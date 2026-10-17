'use strict';
const assert = require('assert');
const yt = require('./lib/adapters/youtube');
const { errorCard, hasRenderableText } = require('./lib/render-error');
const fp = require('./lib/frame-proxy');

assert.strictEqual(yt.videoIdFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
assert.strictEqual(yt.classifyYouTube('https://www.youtube.com/results?search_query=phim').kind, 'search');
assert.strictEqual(yt.classifyYouTube('https://www.youtube.com/').kind, 'home');

const home = yt.renderYouTube('https://www.youtube.com/', null, {});
assert.ok(hasRenderableText(home.html));
assert.ok(home.html.includes('Search YouTube'));

const player = yt.renderYouTube('https://www.youtube.com/watch?v=dQw4w9WgXcQ', null, { origin: 'http://localhost' });
assert.ok(player.html.includes('youtube-nocookie.com/embed/'));
assert.ok(player.html.includes('yt-fallback'));

// Fixture ytInitialData-like
const fixture = `<html><script>var ytInitialData = ${JSON.stringify({
  contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [
    { itemSectionRenderer: { contents: [
      { videoRenderer: { videoId: 'abc123XYZ12', title: { simpleText: 'Test Video' }, ownerText: { runs: [{ text: 'Ch' }] }, lengthText: { simpleText: '3:21' } } }
    ] } }
  ] } } } }
})};</script></html>`;
const items = yt.parseSearchResults(fixture);
assert.ok(items.length >= 1, 'parse videos');
assert.strictEqual(items[0].videoId, 'abc123XYZ12');
const search = yt.renderYouTube('https://www.youtube.com/results?search_query=test', fixture, {});
assert.ok(search.html.includes('Test Video'));
assert.ok(hasRenderableText(search.html));

const empty = errorCard({ title: 'x', url: 'https://example.com', reason: 'empty' });
assert.ok(hasRenderableText(empty));
assert.ok(empty.includes('data-sh-error-card'));

// specialShell home
const shell = fp.specialShell('https://www.youtube.com/');
assert.ok(shell && shell.includes('Search'));

console.log('[PASS] v10.39 youtube + never-blank');
