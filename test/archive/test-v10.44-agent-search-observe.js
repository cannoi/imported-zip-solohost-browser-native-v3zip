'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const search = require('./lib/agent-search');
const ba = require('./lib/backend-agent');
const research = require('./lib/agent-web');

// --- safeFetch headers (behavioral with mock fetch) ---
{
  const orig = global.fetch;
  let seen;
  global.fetch = async (url, opts) => {
    seen = opts.headers;
    return {
      status: 200, ok: true,
      headers: { get: (k) => (k === 'content-type' ? 'text/html' : null) },
      arrayBuffer: async () => Buffer.from('<html></html>')
    };
  };
  // re-require not needed - already loaded function closes over global.fetch at call time
}
// Use live call via research
(async () => {
  const orig = global.fetch;
  let seen;
  global.fetch = async (url, opts) => {
    seen = opts && opts.headers;
    return {
      status: 200, ok: true,
      headers: { get: () => 'text/html' },
      arrayBuffer: async () => Buffer.from('ok')
    };
  };
  try {
    await research.safeFetch('https://example.com/', {
      headers: { 'X-Subscription-Token': 'brave-key-test', 'Accept-Language': 'vi-VN' }
    });
    assert.strictEqual(seen['X-Subscription-Token'], 'brave-key-test');
    assert.ok(seen['Accept-Language']);
  } finally {
    global.fetch = orig;
  }

  // --- parsers ---
  const bingHtml = fs.readFileSync(path.join(__dirname, 'test-fixtures/serp/bing-sample.html'), 'utf8');
  const bing = search.parseResults(bingHtml, 'https://www.bing.com/search?q=xe', 10);
  assert.ok(bing.length >= 2, 'bing results ' + bing.length);
  assert.ok(bing.every((r) => !/bing\.com/i.test(r.url)), 'no bing host links');
  assert.ok(bing[0].url.includes('chotot.com'));
  assert.ok(bing[0].snippet && /Quảng Trị|8 triệu/i.test(bing[0].snippet), 'snippet');
  assert.strictEqual(bing[0].rank, 1);

  const ddgHtml = fs.readFileSync(path.join(__dirname, 'test-fixtures/serp/ddg-sample.html'), 'utf8');
  const ddg = search.parseResults(ddgHtml, 'https://html.duckduckgo.com/html/', 10);
  assert.ok(ddg.some((r) => r.url.includes('chotot.com')), 'ddg unwrap uddg');

  // isBlockedHtml: captcha in script only should NOT block
  assert.strictEqual(search.isBlockedHtml(bingHtml, 'https://www.bing.com/search?q=x'), false);
  assert.strictEqual(
    search.isBlockedHtml('<html><title>Sorry</title><body>Unusual traffic from your computer network</body></html>', 'https://google.com/sorry'),
    true
  );

  // --- composite observation never blank ---
  const session = { url: 'about:blank', html: '', title: '' };
  const task = {
    lastToolResult: { action: 'search', query: 'xe điện 133s', outcome: 'blocked', reason: 'search_blocked', engine: null, resultCount: 0 },
    workMemory: { searchCandidates: [] },
    searchAttempts: [
      { engine: 'bing', outcome: 'blocked', reason: 'captcha', query: 'xe điện 133s' },
      { engine: 'ddg', outcome: 'empty', query: 'xe điện 133s' }
    ]
  };
  const obs = await ba.observeSession(session, 0, task);
  assert.ok(obs.readable);
  assert.ok(obs.text && obs.text.includes('LAST_TOOL'), 'has LAST_TOOL');
  assert.ok(obs.text.includes('SEARCH_ATTEMPTS') || (obs.attempts && obs.attempts.length), 'has attempts');
  assert.ok(obs.page === 'none' || obs.url === 'about:blank');
  assert.ok(obs.last_tool && obs.last_tool.outcome === 'blocked');

  // with candidates
  task.workMemory.searchCandidates = [
    { rank: 1, title: 'A', url: 'https://chotot.com/1', snippet: 'gia 8tr' },
    { rank: 2, title: 'B', url: 'https://example.com/2', snippet: 'x' }
  ];
  const obs2 = await ba.observeSession(session, 0, task);
  assert.ok(obs2.text.includes('chotot.com') || obs2.search_candidates.length === 2);

  // research_listings plan heuristic via planFromRules path is in start - unit the planner export
  const planner = require('./lib/agent-planner');
  assert.strictEqual(typeof planner.planWithLLM, 'function');

  // slice top ranks in summarizeWorkMemory
  const src = fs.readFileSync(path.join(__dirname, 'lib/backend-agent.js'), 'utf8');
  assert.ok(src.includes('searchCandidates.slice(0, 8)') || require('fs').readFileSync('lib/agent-web.js','utf8').includes('searchCandidates.slice(0, 8)'), 'top ranks not tail');

  console.log('[PASS] v10.44 agent search observe behavioral');
})().catch((e) => { console.error(e); process.exit(1); });
