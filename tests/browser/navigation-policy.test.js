const assert = require('assert');
const { validateNavigation } = require('../../lib/navigation-policy');
assert.strictEqual(validateNavigation('https://example.com/'), 'https://example.com/');
assert.strictEqual(validateNavigation('about:blank'), 'about:blank');
assert.throws(() => validateNavigation('javascript:alert(1)'), /Blocked unsafe/);
assert.throws(() => validateNavigation('ftp://example.com/'), /Unsupported URL scheme/);
assert.throws(() => validateNavigation('mailto:test@example.com'), /External scheme/);
console.log('PASS navigation policy');
