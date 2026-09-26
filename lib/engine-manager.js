'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const CDP_PORT = Number(process.env.CHROME_CDP_PORT || 9222);
const VNC_PORT = Number(process.env.VNC_PORT || 5900);
const DISPLAY_PORT = Number(process.env.DISPLAY_PORT || 6080);
const DISPLAY = process.env.DISPLAY || ':99';
const startedAt = Date.now();

const CHROME = [
  process.env.CHROME_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome'
].filter(Boolean);

let xvfb = null;
let vnc = null;
let sock = null;
let chrome = null;
let status = 'STARTING';
let lastError = null;
let version = '';
let gpu = 'unknown';
let restarts = 0;
let starting = null;

function exists(p) {
  try { return !!(p && fs.existsSync(p)); } catch { return false; }
}

function findChrome() {
  return CHROME.find(exists) || null;
}

function writableDir(preferred) {
  const list = [
    preferred,
    path.join('/app/data', 'chromium-profile'),
    path.join(os.homedir() || '/tmp', '.solohost-browser', 'chromium-profile'),
    path.join(os.tmpdir(), 'solohost-browser', 'chromium-profile')
  ];
  for (const dir of list) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.w');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      return dir;
    } catch { /* next */ }
  }
  return list[list.length - 1];
}

const PROFILE = writableDir(process.env.SOLOHOST_BROWSER_DATA || '/app/data/chromium-profile');

function chromiumEnv() {
  const env = { ...process.env, DISPLAY, HOME: process.env.HOME || '/tmp/solohost-browser' };
  if (process.env.CHROMIUM_USE_PROXY !== '1') {
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;
    delete env.ALL_PROXY;
    delete env.http_proxy;
    delete env.https_proxy;
    delete env.all_proxy;
  }
  return env;
}

function spawnLogged(cmd, args, extra = {}) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: extra.env || { ...process.env, DISPLAY, HOME: process.env.HOME || '/tmp/solohost-browser' } });
  child.on('error', (err) => { lastError = err.message; });
  return child;
}

function waitPort(port, tries = 30) {
  return new Promise((resolve, reject) => {
    const tick = (n) => {
      const s = require('net').connect({ host: '127.0.0.1', port }, () => { s.end(); resolve(true); });
      s.on('error', () => {
        if (n <= 0) reject(new Error('port ' + port + ' timeout'));
        else setTimeout(() => tick(n - 1), 200);
      });
    };
    tick(tries);
  });
}

function cdpGet(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${CDP_PORT}${pathname}`, { timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body || 'null')); } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('cdp timeout')); });
  });
}

async function detectGpu() {
  try {
    const ver = await cdpGet('/json/version');
    version = (ver && ver['Browser']) || version;
    gpu = process.env.CHROMIUM_GPU === '0' ? 'software' : 'auto';
  } catch {
    gpu = 'unknown';
  }
}

// Higher baseline resolution + dynamic resize (see resize=remote in public/app.js)
// fixes the blurry page rendering that a fixed low-res 1280x800 framebuffer
// produced once it was CSS/canvas-scaled up to fill a larger viewport.
const SCREEN_W = Number(process.env.SOLOHOST_SCREEN_W || 1920);
const SCREEN_H = Number(process.env.SOLOHOST_SCREEN_H || 1080);

function chromeArgs() {
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--disable-infobars',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${CDP_PORT}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${PROFILE}`,
    `--window-size=${SCREEN_W},${SCREEN_H}`,
    '--window-position=0,0',
    '--start-fullscreen',
    '--kiosk',
    '--disable-features=Translate,MediaRouter,TranslateUI'
  ];
  if (process.env.CHROMIUM_GPU === '0') {
    args.unshift('--disable-gpu', '--use-gl=swiftshader');
  }
  return args;
}

async function boot() {
  status = restarts ? 'RESTARTING' : 'STARTING';
  lastError = null;
  const bin = findChrome();
  if (!bin) {
    status = 'CRASHED';
    lastError = 'chromium binary not found';
    return;
  }
  if (exists('/usr/bin/Xvfb') && !xvfb) {
    xvfb = spawnLogged('Xvfb', [DISPLAY, '-screen', '0', `${SCREEN_W}x${SCREEN_H}x24`, '-ac', '+extension', 'RANDR']);
    await new Promise((r) => setTimeout(r, 300));
  }
  chrome = spawnLogged(bin, chromeArgs(), { env: chromiumEnv() });
  chrome.on('exit', (code) => {
    chrome = null;
    if (status !== 'STOPPING') {
      status = 'CRASHED';
      lastError = 'chromium exit ' + code;
      scheduleRestart();
    }
  });
  try {
    await waitPort(CDP_PORT, 40);
    await detectGpu();
  } catch (err) {
    lastError = err.message;
    status = 'DEGRADED';
  }
  if (exists('/usr/bin/x11vnc') && !vnc) {
    // -xrandr lets x11vnc follow RandR resolution changes so the client's
    // resize=remote request (see public/app.js) gets a native, unscaled
    // framebuffer instead of a stretched/blurry one.
    vnc = spawnLogged('x11vnc', ['-display', DISPLAY, '-forever', '-shared', '-nopw', '-localhost', '-rfbport', String(VNC_PORT), '-quiet', '-nocursor', '-xrandr']);
  }
  if (exists('/usr/bin/websockify') && !sock) {
    const web = exists('/usr/share/novnc') ? '/usr/share/novnc' : '/usr/share/novnc';
    sock = spawnLogged('websockify', ['--web=' + web, '127.0.0.1:' + DISPLAY_PORT, '127.0.0.1:' + VNC_PORT]);
  }
  try {
    if (exists('/usr/bin/websockify')) await waitPort(DISPLAY_PORT, 25);
    status = 'READY';
  } catch (err) {
    status = chrome ? 'DEGRADED' : 'CRASHED';
    lastError = lastError || err.message;
  }
}

function scheduleRestart() {
  if (restarts > 8) return;
  restarts += 1;
  const delay = Math.min(15000, 800 * restarts);
  setTimeout(() => { start().catch(() => {}); }, delay);
}

function start() {
  if (starting) return starting;
  starting = boot().finally(() => { starting = null; });
  return starting;
}

function snapshot() {
  return {
    engine: 'chromium',
    status: status.toLowerCase(),
    gpu,
    version: version || null,
    profile: PROFILE,
    uptime: Date.now() - startedAt,
    display: exists('/usr/bin/websockify') ? 'chromium-kiosk-rfb' : 'none',
    cdp: CDP_PORT,
    error: lastError,
    restarts,
    binary: findChrome(),
    args: chromeArgs(),
    proxyInherited: process.env.CHROMIUM_USE_PROXY === '1'
  };
}

function ready() {
  return status === 'READY';
}

module.exports = { start, snapshot, ready, findChrome, PROFILE, CDP_PORT };
