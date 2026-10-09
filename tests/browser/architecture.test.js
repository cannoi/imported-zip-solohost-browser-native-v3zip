'use strict';

const assert = require('assert');
const contentExtractor = require('../../lib/content-extractor');

async function run() {
  console.log('Running architecture.test.js (Phase 4 new data flow & JSON extraction)...');
  const result = await contentExtractor.extract('https://example.com');
  assert.ok(result, 'Extraction result must exist');
  assert.strictEqual(typeof result.title, 'string', 'Title must be string');
  assert.strictEqual(typeof result.clean_html, 'string', 'clean_html must be present');
  assert.strictEqual(typeof result.raw_text, 'string', 'raw_text must be present');
  assert.ok(result.duration_ms < 5000, 'Extraction duration should be reasonable');
  console.log('architecture.test.js passed.');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { run };
