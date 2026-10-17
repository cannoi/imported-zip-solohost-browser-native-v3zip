'use strict';
const assert = require('assert');
const { config } = require('../lib/config');
assert.ok(config.PORT);
assert.ok('GEO_LOOKUP' in config);
assert.ok('DEFAULT_SEARCH' in config);
console.log('[PASS] test/config');
