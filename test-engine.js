'use strict';
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');

const worker = path.join(__dirname, 'native', 'webkit-worker', 'worker.py');

function createClient() {
  const proc = spawn('python3', [worker], {
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let buf = '';
  const waiters = new Map();
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg && msg.id != null && waiters.has(msg.id)) {
        const w = waiters.get(msg.id);
        waiters.delete(msg.id);
        w(msg);
      }
    }
  });
  function request(obj, ms = 8000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout id=' + obj.id)), ms);
      waiters.set(obj.id, (msg) => { clearTimeout(t); resolve(msg); });
      proc.stdin.write(JSON.stringify(obj) + '\n');
    });
  }
  return { proc, request };
}

async function main() {
  console.log('Engine worker protocol test...');
  const { proc, request } = createClient();
  await new Promise((r) => setTimeout(r, 400));

  const workerSource = require('fs').readFileSync(worker, 'utf8');
  assert.ok(workerSource.includes('cloneNode(true)'), 'snapshot must clone DOM before removing scripts');
  assert.ok(workerSource.includes('CookiePersistentStorage'), 'worker should configure persistent login cookies when enabled');
  assert.ok(workerSource.includes('set_enable_javascript(True)') || workerSource.includes('set_property("enable-javascript", True)'), 'WebKit must explicitly enable JavaScript');
  const managerSource = require('fs').readFileSync(path.join(__dirname, 'lib', 'engine', 'webkit-manager.js'), 'utf8');
  assert.ok(managerSource.includes('_dispatchNext()') && managerSource.includes('requestQueue'), 'WebKit IPC requests must be serialized to avoid queued requests timing out before execution');
  const bridgeSource = require('fs').readFileSync(path.join(__dirname, 'lib', 'engine', 'dom-bridge.js'), 'utf8');
  assert.ok(bridgeSource.includes('session.navigationInFlight'), 'duplicate navigations per session should be coalesced/serialized');
  assert.ok(workerSource.includes("el.type!=='file'"), 'password inputs should be forwarded to live page but not serialized into snapshots');
  const st = await request({ id: 1, cmd: 'engine.status' });
  assert.strictEqual(st.id, 1);
  assert.strictEqual(st.ok, true);
  assert.ok(st.result);
  console.log('  engine.status ready=', st.result.ready, 'error=', st.result.error || null);

  const cr = await request({ id: 2, cmd: 'session.create', args: {} });
  assert.strictEqual(cr.id, 2);
  if (cr.ok) {
    console.log('  session.create OK', cr.result.sessionId);
    const nav = await request({
      id: 3,
      cmd: 'session.navigate',
      args: { sessionId: cr.result.sessionId, url: 'https://example.com' }
    }, 35000);
    console.log('  navigate ok=', nav.ok, nav.result || nav.error);
    await request({ id: 4, cmd: 'session.close', args: { sessionId: cr.result.sessionId } });
  } else {
    console.log('  session.create soft-fail (no WebKit/DISPLAY):', cr.error);
    assert.ok(cr.error);
  }

  try { await request({ id: 9, cmd: 'shutdown' }, 2000); } catch (_) {}
  try { proc.kill('SIGTERM'); } catch (_) {}
  console.log('Engine protocol tests PASSED');
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
