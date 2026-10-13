'use strict';
/**
 * Lazy noVNC desktop — secondary path for login/CAPTCHA only.
 * Primary browsing stays on Bridge/proxy. Does not start at boot.
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const appLog = (() => { try { return require('./app-log'); } catch (_) { return { log() {} }; } })();

const DISPLAY = process.env.DISPLAY || ':99';
const VNC_PORT = 5900;
const WEB_PORT = Number(process.env.SOLOHOST_NOVNC_PORT || 6080);
const GEOM = process.env.SOLOHOST_VNC_GEOMETRY || '1440x900x24';

let state = {
  starting: false,
  ready: false,
  error: null,
  pids: []
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

async function ensureStarted() {
  if (!featureEnabled()) return { ok: false, error: 'disabled' };
  if (!packagesPresent()) return { ok: false, error: 'packages_missing' };
  if (state.ready) return { ok: true, ready: true };
  if (state.starting) {
    await new Promise((r) => setTimeout(r, 1500));
    return state.ready ? { ok: true, ready: true } : { ok: false, error: state.error || 'starting' };
  }
  state.starting = true;
  state.error = null;
  try {
    process.env.DISPLAY = DISPLAY;
    spawnBg('Xvfb', [DISPLAY, '-screen', '0', GEOM, '-ac', '-nolisten', 'tcp', '-noreset'], '/tmp/solohost-xvfb.log');
    await new Promise((r) => setTimeout(r, 600));
    if (hasBin('openbox')) spawnBg('openbox', [], '/tmp/solohost-openbox.log');
    const pw = String(process.env.NOVNC_VNC_PASSWORD || '');
    if (pw.length >= 6) {
      try {
        execFileSync('x11vnc', ['-storepasswd', pw, '/tmp/solohost-vnc.pass'], { stdio: 'ignore' });
        spawnBg('x11vnc', ['-display', DISPLAY, '-forever', '-shared', '-rfbport', String(VNC_PORT), '-localhost', '-rfbauth', '/tmp/solohost-vnc.pass', '-noxdamage'], '/tmp/solohost-x11vnc.log');
      } catch (_) {
        spawnBg('x11vnc', ['-display', DISPLAY, '-forever', '-shared', '-rfbport', String(VNC_PORT), '-localhost', '-nopw', '-noxdamage'], '/tmp/solohost-x11vnc.log');
      }
    } else {
      spawnBg('x11vnc', ['-display', DISPLAY, '-forever', '-shared', '-rfbport', String(VNC_PORT), '-localhost', '-nopw', '-noxdamage'], '/tmp/solohost-x11vnc.log');
    }
    await new Promise((r) => setTimeout(r, 400));
    const webRoot = fs.existsSync('/usr/share/novnc') ? '/usr/share/novnc' : '/usr/share/novnc';
    spawnBg('websockify', ['--web=' + webRoot, '0.0.0.0:' + WEB_PORT, 'localhost:' + VNC_PORT], '/tmp/solohost-websockify.log');
    const up = await waitPort(WEB_PORT, 8000);
    state.ready = !!up;
    state.error = up ? null : 'novnc_port_timeout';
    process.env.DISPLAY = DISPLAY;
    process.env.SOLOHOST_BROWSER_HEADFUL = '1';
    // Bring Playwright Chromium onto the same Xvfb display so noVNC shows the real browser.
    if (up) {
      try {
        const pw = require('./engine/playwright-engine');
        if (pw && typeof pw.ensureHeadfulDisplay === 'function') {
          const hr = await pw.ensureHeadfulDisplay();
          appLog.log('info', 'novnc.chromium_headful', hr || {});
        }
      } catch (e) {
        appLog.log('warn', 'novnc.chromium_headful_fail', { error: String(e.message || e).slice(0, 160) });
      }
    }
    appLog.log(up ? 'info' : 'warn', 'novnc.lazy_start', { ready: state.ready, error: state.error, display: DISPLAY });
    return { ok: up, ready: state.ready, error: state.error, display: DISPLAY, headful: true };
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
  return {
    featureEnabled: featureEnabled(),
    packagesPresent: packagesPresent(),
    ready: state.ready,
    starting: state.starting,
    error: state.error,
    role: 'login_secondary',
    primaryBrowse: 'bridge'
  };
}

module.exports = { ensureStarted, status, packagesPresent, featureEnabled };
