'use strict';
const assert = require('assert');
const { detectChallenge } = require('../lib/challenge');
assert.strictEqual(detectChallenge({ url: 'https://example.com', html: '<script>var captcha=1</script><p>Hello</p>' }).blocked, false, 'script-only captcha word is not blocked');
assert.strictEqual(detectChallenge({ url: 'https://www.google.com/sorry/index', html: 'unusual traffic' }).kind, 'sorry');
assert.strictEqual(detectChallenge({ url: 'https://accounts.google.com/signin/rejected', html: '' }).kind, 'login');
console.log('[PASS] test/challenge');
