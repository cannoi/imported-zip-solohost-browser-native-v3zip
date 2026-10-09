const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const { classifyMedia, ContentExtractor } = require(path.join(root, 'lib/content-extractor'));
const manager = fs.readFileSync(path.join(root, 'lib/chromium-engine.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');

// Media sniffing: .m3u8 / .mp4 by extension or content-type; everything else ignored.
assert.strictEqual(classifyMedia('https://cdn.x/live/index.m3u8?token=1'), 'm3u8');
assert.strictEqual(classifyMedia('https://cdn.x/playlist', 'application/vnd.apple.mpegurl; charset=utf-8'), 'm3u8');
assert.strictEqual(classifyMedia('https://cdn.x/a/b/video.MP4'), 'mp4');
assert.strictEqual(classifyMedia('https://cdn.x/stream', 'video/mp4'), 'mp4');
assert.strictEqual(classifyMedia('https://cdn.x/page.html', 'text/html'), null);
assert.strictEqual(classifyMedia('https://cdn.x/seg.ts', 'video/mp2t'), null);
assert.strictEqual(classifyMedia('not a url'), null);

const fakeResponse = (url, status = 200, headers = {}) => ({ url: () => url, status: () => status, headers: () => headers });
const ex = new ContentExtractor();
const bucket = new Map();
ex._collectMedia(fakeResponse('https://a.test/x.m3u8#frag'), bucket);
ex._collectMedia(fakeResponse('https://a.test/x.m3u8#other'), bucket);           // duplicate
ex._collectMedia(fakeResponse('https://a.test/v.mp4', 206, { 'content-type': 'video/mp4', 'content-length': '1234' }), bucket);
ex._collectMedia(fakeResponse('https://a.test/gone.mp4', 404), bucket);           // failed request
ex._collectMedia(fakeResponse('https://a.test/redirect.mp4', 302), bucket);       // redirect has no body
ex._collectMedia(fakeResponse('https://a.test/app.js', 200, { 'content-type': 'text/javascript' }), bucket);
const found = [...bucket.values()];
assert.deepStrictEqual(found.map(m => m.type), ['m3u8', 'mp4']);
assert.strictEqual(found[1].size, 1234);

// Shell media buttons still exist (frontend unchanged) and the engine accepts their commands as no-ops.
for (const item of ['media-play', 'media-mute', 'media-volume', 'media-captions', 'media-fullscreen']) {
  assert.ok(html.includes(item) && app.includes(item), `missing media control: ${item}`);
  assert.ok(manager.includes(item), `engine must accept ${item}`);
}
console.log('PASS media sniffing (m3u8/mp4) and shell media command compatibility');
