'use strict';

const fs = require('fs');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

const DISPLAY = process.env.DISPLAY || ':99';
const VNC_PORT = Number(process.env.VNC_PORT || 5900);
const DISPLAY_PORT = Number(process.env.DISPLAY_PORT || 6080);
const CONTROL_PORT = Number(process.env.SOLOHOST_ENGINE_CONTROL_PORT || 9333);
const ENGINE = process.env.SOLOHOST_WEBKIT_BINARY || '/usr/local/bin/solohost-webkit-engine';
const WIDTH = Math.max(640, Number(process.env.SOLOHOST_SCREEN_W || 1280));
const HEIGHT = Math.max(480, Number(process.env.SOLOHOST_SCREEN_H || 720));
const STATE_FILE = process.env.SOLOHOST_WEBKIT_STATE || '/tmp/solohost-webkit-last-state.json';
const PROFILE = process.env.SOLOHOST_BROWSER_DATA || '/app/data/webkit-profile';
const DOWNLOADS = process.env.SOLOHOST_DOWNLOADS || path.join(PROFILE, 'downloads');
const LOAD_TIMEOUT = Math.max(10_000, Number(process.env.SOLOHOST_NAV_TIMEOUT_MS || 30_000));

let engine = null;
let xvfb = null;
let vnc = null;
let sock = null;
let status = 'STARTING';
let lastError = null;
let restarts = 0;
let startedAt = 0;
let watchdogTimer = null;
let restartTimer = null;
let crashWindow = [];
let profileResetting = false;
let lastState = { ok: true, engine: 'webkit', active: 'home', tabs: [] };

function exists(p) { try { return !!p && fs.existsSync(p); } catch { return false; } }
function spawnLogged(cmd, args, env = process.env) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, DISPLAY } });
  child.on('error', e => { lastError = e.message; });
  child.stderr?.on('data', b => { lastError = String(b).trim().slice(-2000); });
  return child;
}
function waitPort(port, tries = 60) {
  return new Promise((resolve, reject) => {
    const tick = n => {
      const s = net.connect({ host: '127.0.0.1', port }, () => { s.end(); resolve(true); });
      s.on('error', () => n <= 0 ? reject(new Error(`port ${port} timeout`)) : setTimeout(() => tick(n - 1), 250));
    };
    tick(tries);
  });
}
function command(line) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port: CONTROL_PORT });
    let body = '';
    let timer = setTimeout(() => { s.destroy(); reject(new Error('webkit engine timeout')); }, 5000);
    s.on('connect', () => s.write(line + '\n'));
    s.on('data', d => { body += d; });
    s.on('end', () => { clearTimeout(timer); resolve(body.trim()); });
    s.on('error', e => { clearTimeout(timer); reject(e); });
  });
}
async function settleState() { await new Promise(r => setTimeout(r, 120)); return readStateFile(); }
function readStateFile() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    if (raw) lastState = JSON.parse(raw);
  } catch {}
  return lastState;
}
function profileHealthy() {
  try {
    fs.mkdirSync(PROFILE, { recursive: true });
    fs.mkdirSync(DOWNLOADS, { recursive: true });
    fs.accessSync(PROFILE, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch (e) {
    lastError = `profile unavailable: ${e.message}`;
    return false;
  }
}
function stopChild(child) {
  if (!child || child.killed) return;
  try { child.kill('SIGTERM'); } catch {}
}
async function stop({ removeDisplay = false } = {}) {
  status = 'STOPPING';
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = null;
  if (engine) { try { await command('QUIT'); } catch {} }
  stopChild(engine); stopChild(vnc); stopChild(sock); stopChild(xvfb);
  engine = vnc = sock = xvfb = null;
  if (removeDisplay) lastState = { ok: true, engine: 'webkit', active: 'home', tabs: [] };
  status = 'STOPPED';
}
async function start() {
  if (engine && (status === 'READY' || status === 'DEGRADED')) return;
  status = 'STARTING'; lastError = null;
  if (!exists(ENGINE)) { status = 'CRASHED'; lastError = 'WebKit engine binary not found'; throw new Error(lastError); }
  if (!profileHealthy()) throw new Error(lastError);
  if (!xvfb) xvfb = spawnLogged('/usr/bin/Xvfb', [DISPLAY, '-screen', '0', `${WIDTH}x${HEIGHT}x24`, '-ac']);
  await new Promise(r => setTimeout(r, 350));
  engine = spawnLogged(ENGINE, ['about:blank', String(CONTROL_PORT)], {
    ...process.env,
    SOLOHOST_BROWSER_DATA: PROFILE,
    SOLOHOST_DOWNLOADS: DOWNLOADS
  });
  startedAt = Date.now();
  engine.on('exit', code => {
    engine = null;
    if (status !== 'STOPPING') {
      status = 'CRASHED';
      lastError = `webkit engine exit ${code}`;
      const lived = Date.now() - startedAt;
      if (lived < 5000) crashWindow.push(Date.now());
      crashWindow = crashWindow.filter(t => Date.now() - t < 60000);
      if (crashWindow.length >= 3 && !profileResetting) recoverCorruptProfile();
      scheduleRestart();
    }
  });
  await waitPort(CONTROL_PORT);
  if (!vnc) vnc = spawnLogged('/usr/bin/x11vnc', ['-display', DISPLAY, '-forever', '-shared', '-nopw', '-localhost', '-rfbport', String(VNC_PORT), '-quiet', '-nocursor']);
  if (!sock) sock = spawnLogged('/usr/bin/websockify', ['--web=/usr/share/novnc', `127.0.0.1:${DISPLAY_PORT}`, `127.0.0.1:${VNC_PORT}`]);
  await waitPort(DISPLAY_PORT);
  status = 'READY';
  startWatchdog();
  try { await command('STATE'); await settleState(); } catch {}
}

function recoverCorruptProfile() {
  if (profileResetting) return;
  profileResetting = true;
  try {
    const backup = `${PROFILE}.recovery-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    if (exists(PROFILE)) fs.renameSync(PROFILE, backup);
    fs.mkdirSync(PROFILE, { recursive: true });
    fs.mkdirSync(DOWNLOADS, { recursive: true });
    lastError = `profile recovered; previous profile preserved at ${backup}`;
  } catch (e) {
    lastError = `profile recovery failed: ${e.message}`;
  } finally {
    profileResetting = false;
    crashWindow = [];
  }
}

function scheduleRestart() {
  if (restartTimer || status === 'STOPPING') return;
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    if (status === 'STOPPING') return;
    restarts += 1;
    try { await start(); } catch (e) { lastError = e.message; status = 'CRASHED'; scheduleRestart(); }
  }, 1500);
}
function startWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(async () => {
    if (!engine || status === 'STOPPING') return;
    try {
      const before = readStateFile();
      await command('STATE');
      const state = readStateFile();
      if (state?.ok) {
        lastState = state;
        if (status === 'CRASHED') status = 'READY';
      } else if (before?.ok === false) {
        status = 'DEGRADED';
      }
    } catch (e) {
      lastError = e.message;
      status = 'DEGRADED';
      try { await waitPort(CONTROL_PORT, 3); } catch { scheduleRestart(); }
    }
  }, 2000);
}
async function handle(msg) {
  await start();
  const type = msg.type;
  if (type === 'create') {
    await command(`CREATE ${msg.id || `tab-${Date.now().toString(36)}`}`);
    if (msg.url) await command(`NAVIGATE ${msg.url}`);
  } else if (type === 'activate') await command(`ACTIVATE ${msg.id}`);
  else if (type === 'close') await command(`CLOSE ${msg.id}`);
  else if (type === 'navigate') await command(`NAVIGATE ${msg.url || 'about:blank'}`);
  else if (type === 'back') await command('BACK');
  else if (type === 'forward') await command('FORWARD');
  else if (type === 'reload') await command('RELOAD');
  else if (type === 'stop') await command('STOP');
  else if (type === 'zoom') await command(`ZOOM ${Number(msg.level || 1)}`);
  else if (type === 'fullscreen') await command(`FULLSCREEN ${msg.enabled ? '1' : '0'}`);
  else if (type === 'find') await command(`FIND ${String(msg.text || '').replace(/[\r\n]/g, ' ')}`);
  else if (type === 'find-next') await command('FINDNEXT');
  else if (type === 'find-prev') await command('FINDPREV');
  else if (type === 'media-play') await command('MEDIA play');
  else if (type === 'media-mute') await command('MEDIA mute');
  else if (type === 'media-volume') { const v = Number(msg.volume); if (Number.isFinite(v) && v >= 0 && v <= 1) await command(`MEDIA volume ${v}`); }
  else if (type === 'media-captions') await command('MEDIA captions');
  else if (type === 'media-fullscreen') await command('MEDIA fullscreen');
  else if (type === 'state') await command('STATE');
  await settleState();
  const active = lastState.tabs?.find(t => t.id === lastState.active);
  return { ok: status === 'READY' || status === 'DEGRADED', engine: 'webkit', url: active?.url || msg.url || '', title: active?.title || '', state: lastState };
}
function snapshot() {
  readStateFile();
  return { status: status.toLowerCase(), engine: 'webkit', display: DISPLAY, controlPort: CONTROL_PORT, error: lastError, restarts, uptime: startedAt ? Date.now() - startedAt : 0, profile: PROFILE, downloads: DOWNLOADS, tabs: lastState.tabs || [], active: lastState.active || '', loadTimeoutMs: LOAD_TIMEOUT, processIds: { webkit: engine?.pid || null, xvfb: xvfb?.pid || null, x11vnc: vnc?.pid || null, websockify: sock?.pid || null }, screen: { width: WIDTH, height: HEIGHT, pixelDepth: 24 } };
}
module.exports = { start, stop, handle, snapshot, command, VNC_PORT, DISPLAY_PORT, CONTROL_PORT };
