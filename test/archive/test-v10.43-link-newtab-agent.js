'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, 'public/app.js'), 'utf8');
assert.ok(app.includes('function openContentLink'), 'openContentLink');
assert.ok(app.includes('linksNewTab'), 'linksNewTab state');
assert.ok(app.includes("type !== 'solohost-navigate'") || app.includes("d.type !== 'solohost-navigate'"), 'message types');
assert.ok(app.includes('openContentLink(next') || app.includes('openContentLink(abs)'), 'uses openContentLink');
assert.ok(app.includes('nav.link_new_tab') || app.includes('newTab(next)'), 'new tab path');
// Bridge: anchors open new tab, not only ctrl/meta
assert.ok(app.includes("closest('a[href]')"), 'plain anchor capture');
assert.ok(!app.match(/tag === 'a' && \(e\.ctrlKey \|\| e\.metaKey \|\| el\.target === '_blank'\)[\s\S]{0,80}newTab/), 'old ctrl-only path removed');

const fp = fs.readFileSync(path.join(__dirname, 'lib/frame-proxy.js'), 'utf8');
assert.ok(fp.includes("newTab:true") || fp.includes('newTab: true'), 'proxy intercept newTab');
assert.ok(!fp.includes("a.target==='_blank' || a.hasAttribute('download')) return"), 'blank still intercepted');

const yt = fs.readFileSync(path.join(__dirname, 'lib/adapters/youtube.js'), 'utf8');
assert.ok(yt.includes('newTab:true') || yt.includes('newTab: true'), 'yt intercept newTab');

const search = require('./lib/agent-search');
assert.strictEqual(typeof search.normalizeQuery, 'function');
assert.strictEqual(search.normalizeQuery('  iPhone   18  '), 'iphone 18');
// cache: second call should mark cached when first stored
search.setCachedSearch('hello world', ['bing','ddg'], {
  outcome: 'ok', results: [{ title: 't', url: 'https://example.com' }], engine: 'bing', blocked: [], ms: 1
});
const hit = search.getCachedSearch('Hello   World', ['bing','ddg']);
assert.ok(hit && hit.outcome === 'ok', 'cache hit normalized');

const ba = fs.readFileSync(path.join(__dirname, 'lib/backend-agent.js'), 'utf8');
assert.ok(ba.includes('agent.search.duplicate_skipped'));
assert.ok(ba.includes('agent.ai.quota_exhausted'));
assert.ok(ba.includes('agent.loop_detected'));
assert.ok(ba.includes('durationMs'));
assert.ok(ba.includes('partial_report') || ba.includes('partial'));

const panel = fs.readFileSync(path.join(__dirname, 'public/ai-panel.js'), 'utf8');
assert.ok(panel.includes('blockedEngines='));
assert.ok(panel.includes('durationMs='));
assert.ok(!panel.includes("bits.push('blocked=' + l.blocked)"), 'no ambiguous blocked=');

console.log('[PASS] v10.43 link-newtab + agent lean');
