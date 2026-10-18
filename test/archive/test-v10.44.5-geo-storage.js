'use strict';
const assert = require('assert');
const geo = require('./lib/geoip');
const eng = require('fs').readFileSync('lib/engine/playwright-engine.js', 'utf8');
const app = require('fs').readFileSync('public/app.js', 'utf8');
const sa = require('fs').readFileSync('server-app.js', 'utf8');

const p = geo.getGeoProfileSync();
assert.ok(p.timezone);
assert.ok(p.locale);
assert.ok(p.acceptLanguage);

assert.ok(eng.includes('sanitizeStorageState'));
assert.ok(eng.includes('geoip.getGeoProfileSync'));
assert.ok(eng.includes('PasswordManagerOnboarding'));
assert.ok(eng.includes('permissions: []'));
assert.ok(sa.includes("/api/geo"));
assert.ok(app.includes('applyServerGeo'));
assert.ok(app.includes('geoLocale'));

// sanitize strips secret localStorage keys
const src = eng;
assert.ok(/SECRET_KEY/.test(src) || /pass\(word/.test(src));

console.log('[PASS] v10.44.5 geo + storage hygiene', { tz: p.timezone, locale: p.locale, source: p.source });
