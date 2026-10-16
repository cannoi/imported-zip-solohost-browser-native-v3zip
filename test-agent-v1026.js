'use strict';
const assert = require('assert');
const path = require('path');

// --- Form must not swallow inputs (HTML fallback) ---
const agent = require('./lib/backend-agent');
const html = `<!doctype html><html><body>
<form data-sh-id="f1" action="/search">
  <input data-sh-id="e1" type="text" name="q" placeholder="Search">
  <button data-sh-id="e2" type="submit">Go</button>
</form>
<a data-sh-id="e3" href="/about">About</a>
</body></html>`;
const session = { html, url: 'https://example.com/', title: 't' };
const obs = agent.observeHtmlFallback(session, 0);
const labels = obs.elements.map((e) => e.tag + ':' + (e.label || ''));
console.log('elements', obs.elements);
assert.ok(obs.elements.some((e) => e.tag === 'input'), 'input inside form must appear');
assert.ok(obs.elements.some((e) => e.tag === 'button'), 'button inside form must appear');
assert.ok(!obs.elements.some((e) => e.tag === 'form'), 'form itself should not be a single matched control swallowing children');

// work memory summary must not mid-cut JSON structure only
const sum = agent.summarizeWorkMemory({
  findings: [{ fact: 'price is 10', url: 'https://a.example' }, { fact: 'sla 99.9', url: 'https://b.example' }],
  todo: ['compare', 'report'],
  visited: ['https://a.example']
});
assert.ok(sum.includes('FINDINGS'));
assert.ok(sum.includes('price is 10'));

// risk classifier
assert.strictEqual(agent.actionRisk({ type: 'click' }, 'Buy now checkout'), 'high');
assert.strictEqual(agent.actionRisk({ type: 'click' }, 'About us'), 'low');

// observer module loads
const observer = require('./lib/engine/observer');
assert.ok(typeof observer.observeLive === 'function');
assert.ok(observer.hashObservation({ url: 'x', elements: [] }).length >= 8);

// webkit still stubbed
const wk = require('./lib/engine/webkit-manager');
assert.strictEqual(wk.enabled(), false);

console.log('test-agent-v1026 PASS');
