'use strict';
const assert = require('assert');
const pe = require('./lib/engine/playwright-engine');
const search = require('./lib/agent-search');
const compare = require('./lib/agent-playbooks/compare_products');
const retail = require('./lib/agent-sources/vn-retail');
const fs = require('fs');
const path = require('path');

// 1. Lease helpers exist
assert.strictEqual(typeof pe.isPinned, 'function');
assert.strictEqual(typeof pe.acquireLease, 'function');
assert.strictEqual(typeof pe.releaseLease, 'function');
console.log('[PASS] lease_api');

// 2. Sweep source has idle_2x and pin skip
const engSrc = fs.readFileSync(path.join(__dirname, 'lib/engine/playwright-engine.js'), 'utf8');
assert.ok(engSrc.includes('idle_2x'));
assert.ok(engSrc.includes('session_park_skipped') || engSrc.includes('isPinned(s)'));
assert.ok(engSrc.includes('Debounced disk persist') || engSrc.includes('persistSessionState(s).catch'));
assert.ok(!/img\.loading === 'lazy'\) img\.loading = 'eager'/.test(engSrc));
console.log('[PASS] session_sweep_and_nav_persist');

// 3. Search circuit + parallel timeout
assert.strictEqual(typeof search.markBlocked, 'function');
const map = {};
search.markBlocked(map, 'bing', 20);
assert.ok(search.isEngineBlocked(map, 'bing'));
console.log('[PASS] search_circuit_helpers');

// 4. Search blocked HTML detection via parse path - outcome shape
const fakeBlocked = search.parseResults('<html>ok</html>', 'https://example.com', 5);
assert.ok(Array.isArray(fakeBlocked));
console.log('[PASS] search_parse');

// 5. compare playbook
assert.ok(compare.matchCompareIntent('So sánh giá iPhone 18 tại FPT Shop và Thế Giới Di Động'));
const cl = compare.buildChecklist('giá iPhone 18 FPT Shop', 'vi');
assert.ok(cl.sources.length >= 1);
const acts = compare.suggestedActions('iPhone 18 Pro Max giá');
assert.ok(acts.length >= 1 && acts[0].type === 'navigate');
console.log('[PASS] compare_products_playbook');

// 6. JSON-LD product extract
const html = `<script type="application/ld+json">{"@type":"Product","name":"iPhone 18","offers":{"@type":"Offer","price":"29990000","priceCurrency":"VND"}}</script>`;
const offers = retail.extractProductOffers(html, 'https://fptshop.com.vn/p/iphone');
assert.ok(offers.length >= 1 && offers[0].price);
console.log('[PASS] product_jsonld');

// 7. Agent profile in backend source
const be = fs.readFileSync(path.join(__dirname, 'lib/backend-agent.js'), 'utf8');
assert.ok(be.includes("clientKey: 'agent-profile'"));
assert.ok(be.includes('timeoutMs: 3200') || be.includes('blockedMap'));
assert.ok(be.includes("outcome: 'blocked'") || be.includes('search_blocked'));
console.log('[PASS] agent_profile_and_search_outcome');

// 8. live-view referenced
const htmlIdx = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
assert.ok(htmlIdx.includes('live-view.js'));
console.log('[PASS] live_view_wired');

console.log('\nAll v10.32 automated checks PASS');
