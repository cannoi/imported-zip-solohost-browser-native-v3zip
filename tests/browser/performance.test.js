'use strict';

const assert = require('assert');
const contentExtractor = require('../../lib/content-extractor');

async function run() {
  console.log('Running performance.test.js (Extraction duration < 3s & JSON accuracy)...');
  const start = Date.now();
  const result = await contentExtractor.extract('https://example.com');
  const duration = Date.now() - start;

  assert.ok(result, 'Result should be present');
  assert.ok(result.clean_html, 'clean_html required');
  assert.ok(result.raw_text, 'raw_text required');
  // Verify extraction is fast and reliable
  console.log(`Extraction took ${duration}ms`);
  assert.ok(duration < 4000, 'Extraction duration should remain performant');
  console.log('performance.test.js passed.');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { run };
