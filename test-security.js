'use strict';
const assert = require('assert');
const { assertPublicHttpUrl, isPrivateIp } = require('./lib/frame-proxy');
const { authSession, createSession, destroySession, sanitizeHtml, rateOk } = require('./lib/engine/dom-bridge');

async function expectBlock(url, code) {
  try {
    await assertPublicHttpUrl(url);
    assert.fail('should block ' + url);
  } catch (e) {
    if (code) assert.strictEqual(e.code, code, url + ' code ' + e.code);
    else assert.ok(e.code, url);
  }
}

async function main() {
  console.log('Security tests...');

  assert.strictEqual(isPrivateIp('127.0.0.1'), true);
  assert.strictEqual(isPrivateIp('169.254.169.254'), true);
  assert.strictEqual(isPrivateIp('10.0.0.1'), true);
  assert.strictEqual(isPrivateIp('192.168.0.1'), true);
  assert.strictEqual(isPrivateIp('8.8.8.8'), false);

  await expectBlock('http://127.0.0.1/', 'BLOCKED_HOST');
  await expectBlock('http://localhost:8090/', 'BLOCKED_HOST');
  await expectBlock('http://169.254.169.254/latest/meta-data/', 'BLOCKED_HOST');
  await expectBlock('http://metadata.google.internal/', 'BLOCKED_HOST');
  await expectBlock('file:///etc/passwd', 'BAD_SCHEME');
  await expectBlock('ftp://example.com/', 'BAD_SCHEME');
  await expectBlock('https://example.com:2375/', 'BLOCKED_PORT');
  await expectBlock('https://example.com:22/', 'BLOCKED_PORT');
  await expectBlock('https://user:pass@example.com/', 'INVALID_URL');

  // public allowed
  const ok = await assertPublicHttpUrl('https://example.com/path');
  assert.ok(ok.href.startsWith('https://example.com'));
  console.log('  SSRF blocks PASS');

  // session isolation
  const a = await createSession({ clientKey: 'a' });
  const b = await createSession({ clientKey: 'b' });
  assert.ok(!authSession(a.sessionId, b.token));
  assert.ok(!authSession(a.sessionId, 'x'));
  assert.ok(authSession(a.sessionId, a.token));
  await destroySession(a.sessionId);
  assert.ok(!authSession(a.sessionId, a.token));
  await destroySession(b.sessionId);
  console.log('  session token isolation PASS');

  // sanitize strips active content
  const dirty = '<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a>';
  const clean = sanitizeHtml(dirty, 'https://example.com');
  assert.ok(!/<script/i.test(clean));
  assert.ok(!/onerror/i.test(clean));
  assert.ok(!/javascript:/i.test(clean));
  console.log('  HTML sanitize PASS');

  // rate limiter returns boolean
  assert.strictEqual(typeof rateOk('t'), 'boolean');
  console.log('  rate limit API PASS');

  console.log('Security tests PASSED');
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
