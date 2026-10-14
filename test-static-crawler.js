'use strict';
const assert = require('assert');
const crawler = require('./lib/engine/static-crawler');
const fs = require('fs');
const pkg = require('./package.json');
const server = fs.readFileSync('server-app.js', 'utf8');
const ui = fs.readFileSync('public/static-capture.html', 'utf8');
const menu = fs.readFileSync('public/index.html', 'utf8');
const engine = fs.readFileSync('lib/engine/playwright-engine.js', 'utf8');
const pipeline = fs.readFileSync('lib/engine/content-pipeline.js', 'utf8');
const crawlerSource = fs.readFileSync('lib/engine/static-crawler.js', 'utf8');

assert.strictEqual(crawler.validateOptions({ url: 'https://example.com/a/', scope: 'domain', maxPages: 999 }).maxPages, 30);
assert.strictEqual(crawler.validateOptions({ url: 'https://example.com', scope: 'sitemap', maxPages: 5 }).scope, 'sitemap');
assert.throws(() => crawler.validateOptions({ url: 'file:///etc/passwd' }), /HTTP\(S\)/);
assert.throws(() => crawler.validateOptions({ url: 'https://user:pass@example.com' }), /credentials/);
assert.throws(() => crawler.validateOptions({ url: 'not a url' }), /invalid/i);

const hasExtractionDeps = ['jsdom', '@mozilla/readability', 'sanitize-html'].every(name => {
  try { require.resolve(name); return true; } catch (_) { return false; }
});
if (hasExtractionDeps) {
  const clean = crawler.safeContent('<h1>Hello</h1><script>alert(1)</script><img src="https://example.com/a.jpg" onerror="alert(2)"><a href="javascript:alert(3)">bad link</a><a href="https://example.com/">safe</a>');
  assert.ok(clean.includes('<h1>Hello</h1>'));
  assert.ok(!clean.includes('<script'));
  assert.ok(!clean.includes('onerror'));
  assert.ok(!clean.includes('javascript:'));
  assert.ok(clean.includes('https://example.com/'));

  const rec = crawler.extractRecord('<!doctype html><html><head><title>Article title</title></head><body><main><h1>Article title</h1><p>This is a sufficiently long paragraph of article text to be selected by the Readability parser in this static capture regression test.</p><p>More article content ensures the extraction contains a meaningful amount of readable text.</p></main></body></html>', 'https://example.com/article', 'fallback');
  assert.ok(rec.title);
  assert.ok(rec.content.includes('Article title'));
  assert.ok(!rec.content.includes('<script'));
} else {
  console.log('Static Capture extraction tests SKIPPED (npm dependencies unavailable in this environment)');
}
assert.strictEqual(crawler.canonical('https://example.com/a/?utm_source=x#section'), 'https://example.com/a');
for (const dep of ['@mozilla/readability', 'jsdom', 'sanitize-html', 'archiver']) assert.ok(pkg.dependencies[dep], 'required capture dependency ' + dep);
assert.ok(server.includes("app.post('/api/browser/static-captures'") && server.includes("app.get('/api/browser/static-captures/:id/site.zip'"), 'capture job and ZIP endpoints are mounted');
assert.ok(ui.includes('id="capture-form"') && ui.includes('name="scope"') && ui.includes('name="maxPages"'), 'mobile capture UI has URL, scope and page limit controls');
assert.ok(ui.includes('profileId:browserProfileId()'), 'Static Capture selects the same browser profile ID as the main app');
assert.ok(menu.includes('id="btn-static-capture"'), 'Static Capture is discoverable from the browser menu');
assert.ok(engine.includes('contentPipeline.captureLivePage') && engine.includes('createCapturePage'), 'Bridge uses shared content pipeline and profile-aware capture pages');
assert.ok(crawlerSource.includes('playwrightEngine.createCapturePage') && !crawlerSource.includes('chromium.launch({ headless: true'), 'Static Capture reuses the shared persistent Chromium profile instead of launching a separate browser');
assert.ok(crawlerSource.includes('contentPipeline.extractReadable'), 'Static Capture uses the shared Readability extraction pipeline');
assert.ok(pipeline.includes('inspectLivePage') && pipeline.includes('extractReadable'), 'shared pipeline exposes live DOM classification and Readability extraction');
console.log('Static Capture validation, extraction and HTML sanitization: PASS');
