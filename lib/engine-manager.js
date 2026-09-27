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

// The container has no window manager, so a resized Xvfb/RandR screen never
// made Chromium's already-open kiosk window follow it (that caused the
// "content cropped" bug fixed previously). Instead we keep Xvfb at one large
// fixed CANVAS the whole time, and make the *visible* viewport (Chromium's
// actual window size + the exact rectangle x11vnc exports) something we can
// change live, driven by CDP (see lib/cdp-control.js applyResize) whenever
// the SoloHost window changes shape/orientation. Nothing here needs xrandr.
const CANVAS_W = Number(process.env.SOLOHOST_CANVAS_W || 2560);
const CANVAS_H = Number(process.env.SOLOHOST_CANVAS_H || 2560);
const MIN_DIM = 320;

// Initial/default viewport, used until the client reports its real size.
let viewport = {
  width: clampW(Number(process.env.SOLOHOST_SCREEN_W || 1920)),
  height: clampH(Number(process.env.SOLOHOST_SCREEN_H || 1080))
};
let vncBusy = null;

function clampW(n) {
  n = Math.round(Number(n) || 0);
  if (!n) return MIN_DIM;
  return Math.max(MIN_DIM, Math.min(CANVAS_W, n));
}
function clampH(n) {
  n = Math.round(Number(n) || 0);
  if (!n) return MIN_DIM;
  return Math.max(MIN_DIM, Math.min(CANVAS_H, n));
}

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
    `--window-size=${viewport.width},${viewport.height}`,
    '--window-position=0,0',
    // No --start-fullscreen: the virtual screen (CANVAS_W x CANVAS_H) is
    // now much bigger than the intended browser window, and fullscreen
    // would size Chromium to the whole canvas instead of --window-size.
    // --kiosk alone still hides all of Chromium's own UI chrome.
    '--kiosk',
    '--disable-features=Translate,MediaRouter,TranslateUI'
  ];
  if (process.env.CHROMIUM_GPU === '0') {
    args.unshift('--disable-gpu', '--use-gl=swiftshader');
  }
  return args;
}

function vncArgs() {
  return ['-display', DISPLAY, '-forever', '-shared', '-nopw', '-localhost', '-rfbport', String(VNC_PORT), '-quiet', '-nocursor',
    '-clip', `${viewport.width}x${viewport.height}+0+0`];
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
    xvfb = spawnLogged('Xvfb', [DISPLAY, '-screen', '0', `${CANVAS_W}x${CANVAS_H}x24`, '-ac', '+extension', 'RANDR']);
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
    vnc = spawnLogged('x11vnc', vncArgs());
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

// Called (only) after Chromium's own window has already been resized via CDP
// (see cdp-control.js applyResize) so the two always stay in lock-step: we
// never move the "window" x11vnc exports unless we know Chromium's real
// window now matches it, or we'd recreate the old cropping bug.
function respawnVncClip(width, height) {
  const w = clampW(width);
  const h = clampH(height);
  if (w === viewport.width && h === viewport.height) return Promise.resolve({ ok: true, unchanged: true, width: w, height: h });
  const run = () => new Promise((resolve) => {
    viewport = { width: w, height: h };
    const old = vnc;
    vnc = null;
    let settled = false;
    const spawnNew = () => {
      if (settled) return;
      settled = true;
      if (!exists('/usr/bin/x11vnc')) { resolve({ ok: false, error: 'x11vnc not found' }); return; }
      vnc = spawnLogged('x11vnc', vncArgs());
      resolve({ ok: true, width: w, height: h });
    };
    if (old) {
      old.once('exit', spawnNew);
      try { old.kill(); } catch { spawnNew(); }
      // Safety net: if the old process never emits 'exit' (hung/zombie),
      // don't leave every future resize stuck waiting on it forever.
      setTimeout(() => {
        if (settled) return;
        try { old.kill('SIGKILL'); } catch { /* already gone */ }
        spawnNew();
      }, 3000);
    } else {
      spawnNew();
    }
  });
  // Serialize: never overlap two respawns.
  vncBusy = (vncBusy || Promise.resolve()).then(run, run);
  return vncBusy;
}

function currentViewport() {
  return { ...viewport };
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
    viewport: currentViewport(),
    proxyInherited: process.env.CHROMIUM_USE_PROXY === '1'
  };
}

function ready() {
  return status === 'READY';
}

module.exports = { start, snapshot, ready, findChrome, PROFILE, CDP_PORT, respawnVncClip, currentViewport };
