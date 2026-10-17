'use strict';
const assert = require('assert');
const pe = require('./lib/engine/playwright-engine');

assert.strictEqual(typeof pe.isMobileSession, 'function');
assert.strictEqual(pe.isMobileSession({}), true);
assert.strictEqual(pe.isMobileSession({ mobile: false }), false);
assert.strictEqual(pe.isMobileSession({ mobile: true }), true);

const vp = pe.mobileViewport({});
assert.strictEqual(vp.width, 390);
assert.strictEqual(vp.height, 844);

const opts = pe.contextOptions({ mobile: true }, 'chromium');
assert.strictEqual(opts.isMobile, true);
assert.strictEqual(opts.hasTouch, true);
assert.ok(opts.userAgent && /Android/i.test(opts.userAgent) && /Mobile/i.test(opts.userAgent));
assert.ok(!/Windows NT/i.test(opts.userAgent));
assert.strictEqual(opts.viewport.width, 390);
assert.strictEqual(opts.deviceScaleFactor, 1);
assert.strictEqual(opts.reducedMotion, 'reduce');

const desk = pe.contextOptions({ mobile: false }, 'chromium');
assert.strictEqual(desk.isMobile, false);
assert.ok(/Windows NT|Macintosh/i.test(desk.userAgent) || !/Mobile Safari/i.test(desk.userAgent));

// Ad filter must not hardcode abort of image type — check source
const fs = require('fs');
const src = fs.readFileSync('lib/engine/playwright-engine.js', 'utf8');
assert.ok(!/type === 'image' \|\| type === 'media' \|\| type === 'font'/.test(src), 'must not abort image/media/font');
assert.ok(src.includes('Do NOT abort image/media/font'));

const agent = fs.readFileSync('lib/backend-agent.js', 'utf8');
assert.ok(/mobile:\s*true/.test(agent), 'agent sessions request mobile');

console.log('[PASS] v10.40 mobile-first profile');
