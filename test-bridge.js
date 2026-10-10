'use strict';
const assert = require('assert');
const { sanitizeHtml, annotateInteractive, createSession, authSession, navigate, dispatchEvent, destroySession } = require('./lib/engine/dom-bridge');

async function main() {
  console.log('Bridge unit tests...');

  // Sanitize strips scripts
  const dirty = '<html><head><script>alert(1)</script></head><body onclick="x()"><a href="javascript:alert(1)">x</a><a href="https://example.com/p">ok</a></body></html>';
  const clean = sanitizeHtml(dirty, 'https://example.com/');
  assert.ok(!/<script/i.test(clean));
  assert.ok(!/onclick/i.test(clean));
  assert.ok(!/javascript:/i.test(clean));
  console.log('  sanitize OK');

  const ann = annotateInteractive('<a href="/p">p</a><button>b</button>');
  assert.ok(ann.mapCount >= 2);
  assert.ok(ann.html.includes('data-sh-id'));
  console.log('  annotate OK');

  // Session auth
  const created = await createSession({ clientKey: 'test' });
  assert.ok(created.sessionId && created.token);
  assert.strictEqual(authSession(created.sessionId, 'bad'), null);
  const s = authSession(created.sessionId, created.token);
  assert.ok(s);

  // Unauthorized pattern simulated
  console.log('  session auth OK backend=', created.backend);

  // Navigate example.com (network may work)
  try {
    const st = await navigate(s, 'https://example.com/');
    assert.ok(st.sessionId);
    console.log('  navigate example.com ok=', !!st.hasContent, 'url=', st.url, 'err=', st.error || null);
    if (st.hasContent) {
      // find a link id and click
      const ids = Object.keys(s.map);
      const linkId = ids.find((id) => s.map[id].tag === 'a' && s.map[id].href);
      if (linkId) {
        const ev = await dispatchEvent(s, { type: 'click', targetId: linkId });
        console.log('  click mapped link ok=', ev.ok, 'url=', ev.url);
      }
    }
  } catch (e) {
    console.log('  navigate network limited:', e.message);
  }

  await destroySession(created.sessionId);
  assert.strictEqual(authSession(created.sessionId, created.token), null);
  console.log('  session destroy OK');
  console.log('Bridge tests PASSED');
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
