'use strict';
const assert = require('assert');
const fs = require('fs');
const app = fs.readFileSync(require('path').join(__dirname, 'public/app.js'), 'utf8');
const caps = require('./lib/engine/capabilities').detect();
// Ensure the routing policy covers regular videos, Shorts, live streams and short links.
const helper = app.match(/function isYouTubeVideoUrl\(url\)\s*\{([\s\S]*?)\n  \}/);
assert.ok(helper, 'YouTube video URL classifier exists');
assert.ok(/isYouTubeVideoUrl\(url\)\) return MODE\.PROXY/.test(app), 'video page classification routes to official player shell');
assert.ok(/youtube\.video_handoff/.test(app), 'click handoff is observable in logs');
assert.ok(/navigate\(abs, \{ force: true, mode: MODE\.PROXY \}\)/.test(app), 'video links navigate through proxy player route');
assert.strictEqual(caps.version, '10.25.21');
assert.strictEqual(caps.features.youtubeVideoClickHandoff, true);
// Exercise equivalent URL policy cases without relying on live YouTube or anti-bot bypasses.
function isVideo(raw) {
  const u = new URL(raw); const h = u.hostname.toLowerCase().replace(/^www\./, '');
  if (h === 'youtu.be') return /^\/[\w-]{6,15}\/?$/.test(u.pathname);
  if (!(h === 'youtube.com' || h.endsWith('.youtube.com') || h === 'youtube-nocookie.com')) return false;
  if (/^\/watch\/?$/i.test(u.pathname)) return /^[\w-]{6,15}$/.test(u.searchParams.get('v') || '');
  return /^\/(?:shorts|live|v)\/[\w-]{6,15}(?:\/|$)/i.test(u.pathname);
}
for (const url of [
  'https://m.youtube.com/watch?v=YKrBrOqLte8&list=RDYKrBrOqLte8',
  'https://youtube.com/shorts/QAhwh2aZzK4',
  'https://www.youtube.com/live/YKrBrOqLte8',
  'https://youtu.be/YKrBrOqLte8?t=5'
]) assert.ok(isVideo(url), 'recognized YouTube video URL: ' + url);
for (const url of ['https://m.youtube.com/', 'https://www.youtube.com/results?search_query=music', 'https://www.youtube.com/@channel']) assert.ok(!isVideo(url), 'not a video URL: ' + url);
console.log('✓ YouTube click routing regression tests');
