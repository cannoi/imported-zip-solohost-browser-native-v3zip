'use strict';
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.SOLOHOST_BROWSER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'solohost-engine-'));
const { createEngine } = require('../../lib/chromium-engine');

function fakeExtractor() {
  const calls = [];
  return {
    calls, alive: false, closed: false, failNext: null,
    async warmUp() { this.alive = true; },
    isAlive() { return this.alive; },
    async close() { this.closed = true; this.alive = false; },
    stats() { return { launches: 1, alive: this.alive }; },
    async extract(url, opts) {
      calls.push(url);
      if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
      await new Promise(r => setTimeout(r, 10));
      return { ok: true, url, final_url: url.replace('http://', 'https://'), title: 'T ' + url, site_name: 'S', kind: 'html', clean_html: '<p>x</p>', raw_text: 'x', media: [] };
    }
  };
}

(async () => {
  const ex = fakeExtractor();
  const engine = createEngine({ extractor: ex });
  assert.strictEqual(engine.ready(), false);
  assert.strictEqual(engine.snapshot().status, 'starting');
  assert.strictEqual(engine.snapshot().engine, 'chromium');

  await engine.start();
  assert.strictEqual(engine.ready(), true);
  assert.strictEqual(engine.snapshot().status, 'ready');

  // create + immediate duplicate navigate (what the shell really sends) → one extraction.
  const created = engine.handle({ type: 'create', id: 'tab-a', url: 'http://a.test/1' });
  const dup = engine.handle({ type: 'navigate', url: 'http://a.test/1' });
  const [c1, c2] = await Promise.all([created, dup]);
  assert.strictEqual(ex.calls.length, 1, 'duplicate navigation must be coalesced');
  assert.strictEqual(c1.url, 'https://a.test/1');
  assert.strictEqual(c2.state.active, 'tab-a');
  assert.strictEqual(c1.engine, 'chromium');

  // history: navigate, back, forward, reload
  await engine.handle({ type: 'navigate', id: 'tab-a', url: 'http://a.test/2' });
  assert.strictEqual(engine.snapshot().tabs[0].url, 'https://a.test/2');
  let r = await engine.handle({ type: 'back', id: 'tab-a' });
  assert.strictEqual(r.url, 'https://a.test/1');
  r = await engine.handle({ type: 'forward', id: 'tab-a' });
  assert.strictEqual(r.url, 'https://a.test/2');
  const before = ex.calls.length;
  await engine.handle({ type: 'reload', id: 'tab-a' });
  assert.strictEqual(ex.calls.length, before + 1);

  // content API
  const content = engine.getContent();
  assert.strictEqual(content.tab.id, 'tab-a');
  assert.strictEqual(content.content.kind, 'html');
  assert.strictEqual(content.loading, false);

  // tabs
  await engine.handle({ type: 'create', id: 'tab-b', url: 'http://b.test/' });
  assert.strictEqual(engine.snapshot().active, 'tab-b');
  await engine.handle({ type: 'activate', id: 'tab-a' });
  assert.strictEqual(engine.snapshot().active, 'tab-a');
  await engine.handle({ type: 'activate', id: 'home' });
  assert.strictEqual(engine.snapshot().active, 'home');
  await engine.handle({ type: 'close', id: 'tab-b' });
  assert.strictEqual(engine.snapshot().tabs.length, 1);

  // errors keep the tab usable and are exposed to the reader view
  ex.failNext = Object.assign(new Error('The page took too long to load'), { code: 'NAVIGATION_TIMEOUT' });
  await assert.rejects(() => engine.handle({ type: 'navigate', id: 'tab-a', url: 'http://slow.test/' }), /too long/);
  assert.strictEqual(engine.getContent('tab-a').error.code, 'NAVIGATION_TIMEOUT');
  assert.strictEqual(engine.getContent('tab-a').content, null);

  // shell commands that no longer have a target are accepted silently
  for (const type of ['zoom', 'find', 'find-next', 'media-play', 'media-mute', 'media-volume', 'media-captions', 'media-fullscreen', 'fullscreen', 'stop']) {
    const out = await engine.handle({ type, id: 'tab-a' });
    assert.strictEqual(out.ok, true, type);
  }

  // revision counter moves when state changes (reader view polls it)
  const rev = engine.revision().rev;
  await engine.handle({ type: 'navigate', id: 'tab-a', url: 'http://a.test/3' });
  assert.ok(engine.revision().rev > rev);

  // about:blank does not hit the extractor
  const n = ex.calls.length;
  await engine.handle({ type: 'navigate', id: 'tab-a', url: 'about:blank' });
  assert.strictEqual(ex.calls.length, n);

  await engine.stop();
  assert.strictEqual(ex.closed, true);
  assert.strictEqual(engine.snapshot().status, 'stopped');

  // start failure is reported, not thrown past the supervisor
  const bad = fakeExtractor();
  bad.warmUp = async () => { throw new Error('Missing dependency "playwright-core"'); };
  const broken = createEngine({ extractor: bad });
  await assert.rejects(() => broken.start(), /playwright-core/);
  assert.strictEqual(broken.ready(), false);
  assert.strictEqual(broken.snapshot().status, 'crashed');
  assert.match(broken.snapshot().error, /playwright-core/);
  await broken.stop();

  console.log('PASS chromium engine (tabs, history, dedupe, errors, lifecycle)');
})().catch(e => { console.error(e); process.exit(1); });
