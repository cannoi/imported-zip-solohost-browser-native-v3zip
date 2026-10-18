'use strict';
const assert = require('assert');
const fs = require('fs');
const src = fs.readFileSync('lib/browser-agent.js', 'utf8');
assert.ok(src.includes('Evidence First'));
assert.ok(src.includes('Honest Partial Reports'));
assert.ok(src.includes('SEARCH_CANDIDATES'));
assert.ok(src.includes('last_tool'));
assert.ok(src.includes('search_candidates'));
assert.ok(src.includes('fetch_feed'));
assert.ok(src.includes('Never invent facts'));
// Must still list actions used by executeAction
for (const a of ['navigate','search','extract_page','fetch_doc','done','fail','ask_user']) {
  assert.ok(src.includes('"type":"' + a + '"') || src.includes('type":"' + a), a);
}
console.log('[PASS] v10.44.1 agent prompt');
