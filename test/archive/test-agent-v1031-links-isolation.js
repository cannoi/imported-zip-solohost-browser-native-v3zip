'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'solohost-agent-v1031-'));
process.env.SOLOHOST_DATA_DIR = tmp;
const evidence = require('./lib/agent-evidence');
const links = require('./lib/agent-links');
const search = require('./lib/agent-search');
const report = require('./lib/agent-report');

// Canonicalization: tracking is removed but meaningful query parameters remain.
assert.strictEqual(links.canonicalizeUrl('https://shop.example/p?id=18&utm_source=x&gclid=abc#details'), 'https://shop.example/p?id=18');
// Balanced parentheses and Unicode survive; punctuation outside the URL does not.
assert.deepStrictEqual(links.extractUrls('See https://en.wikipedia.org/wiki/IPhone_(h%C3%A3ng)). and https://example.com/a?x=1&y=2.'), [
  'https://en.wikipedia.org/wiki/IPhone_(h%C3%A3ng)', 'https://example.com/a?x=1&y=2'
]);
assert.deepStrictEqual(links.extractUrls('[Wiki](https://en.wikipedia.org/wiki/IPhone_(h%C3%A3ng))'), ['https://en.wikipedia.org/wiki/IPhone_(h%C3%A3ng)']);
assert.strictEqual(links.classifyUrl('https://www.google.com/sorry/index?continue=x'), 'captcha');
assert.strictEqual(links.classifyUrl('https://www.google.com/search?q=iphone'), 'search_results');
assert.strictEqual(links.classifyUrl('https://www.google.com/url?q=https%3A%2F%2Fshop.example'), 'redirector');
assert.strictEqual(links.unwrapSearchRedirect('https://www.google.com/url?q=https%3A%2F%2Fshop.example%2Fp'), 'https://shop.example/p');
assert.strictEqual(links.classifyUrl('javascript:alert(1)'), 'invalid');

const fixture = `<html><body><li class="b_algo"><h2><a href="https://shop.example/iphone-18">iPhone 18 price</a></h2><p>Official product page</p></li><li><a href="https://docs.example/spec">Technical specifications</a></li></body></html>`;
const parsed = search.parseResults(fixture, 'https://www.bing.com/search?q=iphone', 10);
assert.ok(parsed.some(x => x.url === 'https://shop.example/iphone-18'));
assert.ok(parsed.every(x => !['search_results','captcha','redirector','invalid'].includes(links.classifyUrl(x.url))));

// Task A's ledger cannot leak into Task B's report; client-provided notes are not findings.
evidence.addEvidence('task-A', { kind:'page', url:'https://news.example/a', title:'Old news headline', snippet:'OLD_TASK_SENTINEL prior report', text:'OLD_TASK_SENTINEL prior report' });
evidence.addEvidence('task-B', { kind:'page', url:'https://shop.example/iphone-18', title:'Product page', snippet:'Current product price listed on page', text:'Current product price listed on page' });
evidence.addEvidence('task-B', { kind:'serp', url:'https://candidate.example/serp-result', title:'Search candidate', snippet:'SERP_ONLY_SENTINEL', text:'SERP_ONLY_SENTINEL' });
const b = report.buildAgentReport({ id:'task-B', lang:'en', task:'Compare phone prices', message:'Partial summary', workMemory:{ notes:['OLD_TASK_SENTINEL leaked note'], findings:[], visited:['https://www.google.com/sorry/index?token=dead'] }, errors:[{message:'backend transient failure'}], history:[] });
assert.ok(!b.markdown.includes('OLD_TASK_SENTINEL'), 'task B report must not contain task A memory');
assert.ok(!b.markdown.includes('SERP_ONLY_SENTINEL'), 'SERP snippets are not report evidence');
assert.ok(!b.markdown.includes('google.com/sorry'), 'captcha URLs must never appear as sources');
assert.ok(b.markdown.includes('backend transient failure'), 'system errors belong in scope/limitations');
assert.ok(b.links.includes('https://shop.example/iphone-18'));
const grounded = report.groundSummary({ id:'task-B', lang:'en' }, 'Price: $999 [E1]');
assert.ok(grounded.includes('https://shop.example/iphone-18'), 'valid evidence IDs render as source links');
assert.ok(!grounded.includes('Not independently verified'), 'valid evidence citation is not marked unverified');
assert.ok(!b.links.includes('https://candidate.example/serp-result'));

// Browser client no longer stores task summaries/errors in persistent work memory.
const ui = fs.readFileSync(path.join(__dirname, 'public/ai-panel.js'), 'utf8');
assert.ok(!ui.includes("notes: (workMemory.notes || []).concat([String(out.message"), 'old output-to-notes persistence removed');
assert.ok(ui.includes('Client stores only UI metadata'), 'local storage is metadata only');
const backend = fs.readFileSync(path.join(__dirname, 'lib/backend-agent.js'), 'utf8');
assert.ok(backend.includes('workMemory: (restored && restored.workMemory'), 'server initializes task-owned memory');
assert.ok(!backend.includes("active.stop = true;\n      active.status = 'stopped';\n      active.message = 'Superseded by new task';"), 'new task must not overwrite active task');

links.verifyLinks(['http://127.0.0.1/'], { timeoutMs:100 }).then(results => {
  assert.strictEqual(results.length, 1);
  assert.ok(!results[0].ok, 'SSRF/private destinations must never pass link verification');
  console.log('test-agent-v1031-links-isolation PASS');
}).catch(e => { console.error(e); process.exitCode = 1; });
