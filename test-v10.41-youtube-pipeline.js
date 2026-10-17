'use strict';
const assert = require('assert');
const yt = require('./lib/adapters/youtube');
const fp = require('./lib/frame-proxy');
const { hasRenderableText } = require('./lib/render-error');

assert.strictEqual(yt.classifyYouTube('https://www.youtube.com/results?search_query=a').kind, 'search');

// Desktop-style object fixture
const desk = `<html><script>var ytInitialData = ${JSON.stringify({
  contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [
    { itemSectionRenderer: { contents: [
      { videoRenderer: { videoId: 'dQw4w9WgXcQ', title: { simpleText: 'Desk' }, ownerText: { runs: [{ text: 'Ch' }] } } }
    ] } }
  ] } } } }
})};</script></html>`;
assert.ok(yt.parseSearchResults(desk).some(x => x.videoId === 'dQw4w9WgXcQ'));

// Mobile-style \x-escaped string fixture (minimal)
const payload = JSON.stringify({
  contents: { sectionListRenderer: { contents: [
    { itemSectionRenderer: { contents: [
      { videoWithContextRenderer: { videoId: 'abcdefghijk', title: { runs: [{ text: 'Mobile Hit' }] } } }
    ] } }
  ] } }
});
let esc = '';
for (let i = 0; i < payload.length; i++) {
  const c = payload.charCodeAt(i);
  esc += '\\x' + c.toString(16).padStart(2, '0');
}
const mobileHtml = `<html><script>var ytInitialData = '${esc}';</script></html>`;
const mobileItems = yt.parseSearchResults(mobileHtml);
assert.ok(mobileItems.some(x => x.videoId === 'abcdefghijk'), 'mobile escape parse');

assert.ok(hasRenderableText(yt.renderYouTube('https://www.youtube.com/', null, {}).html));
assert.ok(yt.renderYouTube('https://www.youtube.com/watch?v=dQw4w9WgXcQ', null, {}).html.includes('youtube-nocookie'));

// fetchDocument follows redirects (structure)
assert.strictEqual(typeof fp.fetchDocument, 'function');
console.log('[PASS] v10.41 youtube pipeline unit');
