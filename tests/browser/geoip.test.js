'use strict';
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const { getPublicIpGeoData, clearGeoCache, acceptLanguageFor, FALLBACK } = require(path.join(root, 'lib/geoip.js'));
const { STEALTH, buildInitScript } = require(path.join(root, 'lib/stealth.js'));

assert.strictEqual(FALLBACK.timezoneId, 'UTC');
assert.strictEqual(FALLBACK.locale, 'en-US');
assert.ok(STEALTH.timezoneId === 'UTC' || STEALTH.timezoneId);
assert.ok(!/Ho_Chi_Minh/i.test(STEALTH.timezoneId), 'stealth must not hardcode Ho Chi Minh');
assert.ok(acceptLanguageFor('vi-VN').includes('vi'));
assert.ok(buildInitScript(['vi-VN', 'vi']).includes('webdriver'));

clearGeoCache();
process.env.SOLOHOST_GEO_TIMEZONE = 'Europe/Berlin';
process.env.SOLOHOST_GEO_LOCALE = 'de-DE';
process.env.SOLOHOST_GEO_COUNTRY = 'DE';
getPublicIpGeoData().then((g) => {
  assert.strictEqual(g.timezoneId, 'Europe/Berlin');
  assert.strictEqual(g.locale, 'de-DE');
  assert.strictEqual(g.source, 'env');
  // cache hit
  return getPublicIpGeoData().then((g2) => {
    assert.strictEqual(g2.cached, true);
    delete process.env.SOLOHOST_GEO_TIMEZONE;
    delete process.env.SOLOHOST_GEO_LOCALE;
    delete process.env.SOLOHOST_GEO_COUNTRY;
    clearGeoCache();
    console.log('PASS geoip');
  });
}).catch((e) => { console.error(e); process.exit(1); });
