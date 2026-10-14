'use strict';
const fs = require('fs');
const assert = require('assert');
const read = (p) => fs.readFileSync(p, 'utf8');
const docker = read('Dockerfile');
const compose = read('docker-compose.yml');
const start = read('start.sh');
const engine = read('lib/engine/playwright-engine.js');
const launcher = read('lib/novnc-launcher.js');
const server = read('server-app.js');
const html = read('public/index.html');
const js = read('public/app.js');
assert(/xvfb.*x11vnc.*openbox.*novnc.*websockify/.test(docker), 'desktop packages installed');
assert(/CMD \["\.\/start\.sh"\]/.test(docker), 'Docker runs startup script');
assert(/EXPOSE 8080\b/.test(docker) && !/EXPOSE[^\n]*6080/.test(docker) && server.includes("app.use('/novnc'"), 'noVNC is proxied through the main app port rather than exposed directly');
assert(/'-localhost'/.test(launcher) && /'-rfbauth'/.test(launcher) && /-storepasswd/.test(launcher), 'VNC is loopback-only and password protected');
assert(/NOVNC_VNC_PASSWORD/.test(launcher) && /password_required/.test(launcher) && /length >= 8/.test(launcher), 'missing or short password disables noVNC');
assert(/headless: !interactiveDisplay/.test(engine), 'shared Playwright browser can run headed under X display');
assert(/\/api\/novnc\/status/.test(server), 'noVNC status endpoint exists');
assert(/btn-novnc/.test(html) && /btn-novnc/.test(js), 'UI exposes noVNC control');
assert(/SOLOHOST_NOVNC_ENABLED/.test(compose) && /NOVNC_VNC_PASSWORD/.test(compose) && /NOVNC_VNC_PASSWORD/.test(read('solohost/docker-compose.yml')), 'compose supports password-gated noVNC overrides');
(async () => {
  const launcherApi = require('./lib/novnc-launcher');
  const enabled = process.env.SOLOHOST_NOVNC_ENABLED;
  const password = process.env.NOVNC_VNC_PASSWORD;
  process.env.SOLOHOST_NOVNC_ENABLED = '1';
  delete process.env.NOVNC_VNC_PASSWORD;
  try {
    assert.strictEqual(launcherApi.status().reason, 'password_required');
    assert.deepStrictEqual(await launcherApi.ensureStarted(), { ok: false, error: 'password_required' });
  } finally {
    if (enabled == null) delete process.env.SOLOHOST_NOVNC_ENABLED;
    else process.env.SOLOHOST_NOVNC_ENABLED = enabled;
    if (password == null) delete process.env.NOVNC_VNC_PASSWORD;
    else process.env.NOVNC_VNC_PASSWORD = password;
  }
  console.log('noVNC upgrade tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
