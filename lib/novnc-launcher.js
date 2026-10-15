'use strict';
/**
 * Lazy noVNC desktop — secondary path for login/CAPTCHA only.
 * Primary browsing stays on Bridge/proxy. Does not start at boot.
 * VNC password = same as app admin (BROWSER_ACCESS_PASSWORD / ACCESS_PASSWORD).
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const appLog = (() => { try { return require('./app-log'); } catch (_) { return { log() {} }; } })();

const DISPLAY = process.env.DISPLAY || ':99';
const VNC_PORT = 5900;
const WEB_PORT = Number(process.env.SOLOHOST_NOVNC_PORT || 6080);
const GEOM = process.env.SOLOHOST_VNC_GEOMETRY || '1440x900x24';
const PASS_FILE = '/tmp/solohost-vnc.pass';

let state = {
  starting: false,
  ready: false,
  error: null,
  pids: [],
  passwordProtected: false
};

function hasBin(name) {
  try {
    execFileSync('sh', ['-c', 'command -v ' + name], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function packagesPresent() {
  return hasBin('Xvfb') && hasBin('x11vnc') && hasBin('websockify') &&
    (fs.existsSync('/usr/share/novnc') || fs.existsSync('/usr/share/novnc/vnc.html'));
}

function featureEnabled() {
  return String(process.env.SOLOHOST_NOVNC_ENABLED || '1') !== '0';
}

/** Shared with SoloHost Browser admin gate — one password for app + noVNC. */
function resolveVncPassword() {
  // Prefer explicit NOVNC override only if set; otherwise app admin password.
  const novncOnly = String(process.env.NOVNC_VNC_PASSWORD || '').trim();
  if (novncOnly) return novncOnly;
  let v = String(process.env.BROWSER_ACCESS_PASSWORD || process.env.ACCESS_PASSWORD || '').trim();
  if (v) return v;
  try {
    const dataDir = process.env.SOLOHOST_DATA_DIR || path.join(__dirname, '..', 'data');
    const p = path.join(dataDir, '.access_password');
    if (fs.existsSync(p)) {
      v = String(fs.readFileSync(p, 'utf8') || '').trim().split(/\r?\n/)[0] || '';
      if (v) return v;
    }
  } catch (_) {}
  return '';
}

function spawnBg(cmd, args, logFile) {
  const out = fs.openSync(logFile, 'a');
  const child = spawn(cmd, args, {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, DISPLAY }
  });
  child.unref();
  state.pids.push(child.pid);
  return child;
}

function waitPort(port, ms) {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const tryOnce = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 800 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => {
        if (Date.now() > deadline) resolve(false);
        else setTimeout(tryOnce, 400);
      });
    };
    tryOnce();
  });
}

function startX11vnc(pw) {
  if (pw) {
    try {
      execFileSync('x11vnc', ['-storepasswd', pw, PASS_FILE], { stdio: 'ignore' });
      try { fs.chmodSync(PASS_FILE, 0o600); } catch (_) {}
      spawnBg('x11vnc', [
        '-display', DISPLAY, '-forever', '-shared',
        '-rfbport', String(VNC_PORT), '-localhost',
        '-rfbauth', PASS_FILE, '-noxdamage'
      ], '/tmp/solohost-x11vnc.log');
      state.passwordProtected = true;
      return true;
    } catch (e) {
      appLog.log('warn', 'novnc.rfbauth_fail', { error: String(e.message || e).slice(0, 120) });
    }
  }
  spawnBg('x11vnc', [
    '-display', DISPLAY, '-forever', '-shared',
    '-rfbport', String(VNC_PORT), '-localhost',
    '-nopw', '-noxdamage'
  ], '/tmp/solohost-x11vnc.log');
  state.passwordProtected = false;
  return false;
}

async function ensureStarted() {
  if (!featureEnabled()) return { ok: false, error: 'disabled' };
  if (!packagesPresent()) return { ok: false, error: 'packages_missing' };
  if (state.ready) {
    return {
      ok: true,
      ready: true,
      passwordRequired: state.passwordProtected,
      passwordHint: state.passwordProtected ? 'same_as_app_admin' : null
    };
  }
  if (state.starting) {
    await new Promise((r) => setTimeout(r, 1500));
    return state.ready
      ? { ok: true, ready: true, passwordRequired: state.passwordProtected, passwordHint: state.passwordProtected ? 'same_as_app_admin' : null }
      : { ok: false, error: state.error || 'starting' };
  }
  state.starting = true;
  state.error = null;
  try {
    process.env.DISPLAY = DISPLAY;
    spawnBg('Xvfb', [DISPLAY, '-screen', '0', GEOM, '-ac', '-nolisten', 'tcp', '-noreset'], '/tmp/solohost-xvfb.log');
    await new Promise((r) => setTimeout(r, 600));
    if (hasBin('openbox')) spawnBg('openbox', [], '/tmp/solohost-openbox.log');

    const pw = resolveVncPassword();
    startX11vnc(pw);

    await new Promise((r) => setTimeout(r, 400));
    const webRoot = fs.existsSync('/usr/share/novnc') ? '/usr/share/novnc' : '/usr/share/novnc';
    spawnBg('websockify', ['--web=' + webRoot, '0.0.0.0:' + WEB_PORT, 'localhost:' + VNC_PORT], '/tmp/solohost-websockify.log');
    const up = await waitPort(WEB_PORT, 8000);
    state.ready = !!up;
    state.error = up ? null : 'novnc_port_timeout';
    process.env.DISPLAY = DISPLAY;
    process.env.SOLOHOST_BROWSER_HEADFUL = '1';
    if (up) {
      try {
        const eng = require('./engine/playwright-engine');
        if (eng && typeof eng.ensureHeadfulDisplay === 'function') {
          const hr = await eng.ensureHeadfulDisplay();
          appLog.log('info', 'novnc.chromium_headful', hr || {});
        }
      } catch (e) {
        appLog.log('warn', 'novnc.chromium_headful_fail', { error: String(e.message || e).slice(0, 160) });
      }
    }
    appLog.log(up ? 'info' : 'warn', 'novnc.lazy_start', {
      ready: state.ready,
      error: state.error,
      display: DISPLAY,
      passwordProtected: state.passwordProtected
    });
    return {
      ok: up,
      ready: state.ready,
      error: state.error,
      display: DISPLAY,
      headful: true,
      passwordRequired: state.passwordProtected,
      passwordHint: state.passwordProtected ? 'same_as_app_admin' : null
    };
  } catch (e) {
    state.error = String(e.message || e);
    state.ready = false;
    appLog.log('error', 'novnc.lazy_fail', { error: state.error });
    return { ok: false, error: state.error };
  } finally {
    state.starting = false;
  }
}

function status() {
  const pw = resolveVncPassword();
  return {
    featureEnabled: featureEnabled(),
    packagesPresent: packagesPresent(),
    ready: state.ready,
    starting: state.starting,
    error: state.error,
    display: DISPLAY,
    webPort: WEB_PORT,
    role: 'login_secondary',
    passwordRequired: state.ready ? state.passwordProtected : !!pw,
    passwordHint: (state.passwordProtected || !!pw) ? 'same_as_app_admin' : null
  };
}

module.exports = {
  ensureStarted,
  status,
  packagesPresent,
  featureEnabled,
  resolveVncPassword
};
