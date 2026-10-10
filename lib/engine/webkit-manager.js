'use strict';

/**
 * WebKitGTK worker manager — Node side.
 * Spawns Python worker, JSON-lines IPC. Never blocks the main HTTP server loop
 * beyond bounded await timeouts. Proxy remains the interactive UI path.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const appLog = require('../app-log');

const WORKER_SCRIPT = path.join(__dirname, '..', '..', 'native', 'webkit-worker', 'worker.py');
const REQUEST_TIMEOUT_MS = Number(process.env.SOLOHOST_WEBKIT_IPC_TIMEOUT_MS || 8000);
const MAX_RESTARTS = 5;
const ENABLED = process.env.SOLOHOST_WEBKIT !== '0';

class WebKitManager {
  constructor() {
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.restarts = 0;
    this.lastError = null;
    this.ready = false;
    this.starting = null;
    this.buf = '';
    this.xvfb = null;
    this.display = process.env.SOLOHOST_WEBKIT_DISPLAY || ':99';
    this.negativeUntil = 0;
  }

  isEnabled() {
    return ENABLED && fs.existsSync(WORKER_SCRIPT);
  }

  async ensureStarted() {
    if (!this.isEnabled()) {
      return { ok: false, error: 'webkit_disabled_or_missing' };
    }
    if (this.proc && !this.proc.killed) return { ok: true };
    if (this.starting) return this.starting;
    this.starting = this._start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async _startXvfb() {
    if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
      return process.env.DISPLAY || null;
    }
    // Start private Xvfb for this worker only (not VNC — no remote client)
    try {
      const { spawn: sp } = require('child_process');
      this.xvfb = sp('Xvfb', [this.display, '-screen', '0', '1280x720x24', '-ac', '-nolisten', 'tcp'], {
        stdio: 'ignore',
        detached: false
      });
      this.xvfb.on('error', (err) => {
        this.lastError = 'xvfb_spawn:' + err.message;
        this.xvfb = null;
      });
      this.xvfb.on('exit', () => { this.xvfb = null; });
      await new Promise((r) => setTimeout(r, 400));
      return this.display;
    } catch (e) {
      this.lastError = 'xvfb_failed:' + e.message;
      return null;
    }
  }

  async _start() {
    const display = await this._startXvfb();
    const env = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      SOLOHOST_WEBKIT_WORKER_ID: 'wk1'
    };
    if (display) env.DISPLAY = display;

    let child;
    try {
      child = spawn('python3', [WORKER_SCRIPT], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false
      });
    } catch (e) {
      this.lastError = e.message;
      this.ready = false;
      appLog.log('error', 'webkit.spawn_fail', { error: e.message });
      return { ok: false, error: e.message };
    }
    child.on('error', (err) => {
      this.lastError = 'spawn:' + err.message;
      this.ready = false;
      this.proc = null;
      appLog.log('error', 'webkit.spawn_error', { error: err.message });
    });

    this.proc = child;
    this.buf = '';
    this.ready = false;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const s = String(chunk).trim();
      if (s) appLog.log('info', 'webkit.worker_stderr', { line: s.slice(0, 400) });
    });
    child.on('exit', (code, signal) => {
      appLog.log('warn', 'webkit.worker_exit', { code, signal });
      this.ready = false;
      this.proc = null;
      for (const [id, p] of this.pending) {
        p.reject(new Error('worker_exited'));
        this.pending.delete(id);
      }
      if (this.restarts < MAX_RESTARTS && ENABLED) {
        this.restarts += 1;
        setTimeout(() => { this.ensureStarted().catch(() => {}); }, 800);
      }
    });

    // Wait for boot line / first status
    try {
      const st = await this.request('engine.status', {}, 2000);
      this.ready = !!(st && st.ready);
      this.lastError = st && st.error ? st.error : null;
      if (!this.ready) this.negativeUntil = Date.now() + 5 * 60 * 1000;
      appLog.log('info', 'webkit.worker_started', { ready: this.ready, error: this.lastError });
      return { ok: true, status: st };
    } catch (e) {
      this.lastError = e.message;
      appLog.log('error', 'webkit.worker_boot_timeout', { error: e.message });
      return { ok: false, error: e.message };
    }
  }

  _onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg && msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error || 'worker_error'));
      } else if (msg && msg.result && msg.result.event === 'boot') {
        this.ready = !!msg.result.ready;
        this.lastError = msg.result.error || null;
      }
    }
  }

  request(cmd, args = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise(async (resolve, reject) => {
      if (!this.proc || this.proc.killed) {
        const boot = await this.ensureStarted();
        if (!boot.ok && !this.proc) {
          return reject(new Error(boot.error || 'worker_not_running'));
        }
      }
      if (!this.proc || !this.proc.stdin.writable) {
        return reject(new Error('worker_stdin_closed'));
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('ipc_timeout'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      try {
        this.proc.stdin.write(JSON.stringify({ id, cmd, args }) + '\n');
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  async status() {
    if (!this.isEnabled()) {
      return {
        ok: true,
        enabled: false,
        ready: false,
        mode: 'hybrid-proxy',
        webkit: { available: false, reason: 'disabled_or_script_missing' },
        fallback: 'proxy'
      };
    }
    if (Date.now() < this.negativeUntil) {
      return {
        ok: true,
        enabled: true,
        ready: false,
        mode: 'hybrid-proxy',
        webkit: { available: false, reason: 'cooldown', until: this.negativeUntil },
        fallback: 'proxy',
        lastError: this.lastError
      };
    }
    try {
      await this.ensureStarted();
      const st = await this.request('engine.status', {}, 1500);
      return {
        ok: true,
        enabled: true,
        ready: !!st.ready,
        mode: st.ready ? 'webkit-worker' : 'hybrid-proxy',
        webkit: st,
        fallback: 'proxy',
        lastError: this.lastError
      };
    } catch (e) {
      this.negativeUntil = Date.now() + 5 * 60 * 1000;
      this.lastError = e.message;
      return {
        ok: true,
        enabled: true,
        ready: false,
        mode: 'hybrid-proxy',
        webkit: { available: false, error: e.message },
        fallback: 'proxy',
        lastError: e.message
      };
    }
  }

  async createSession() {
    await this.ensureStarted();
    return this.request('session.create', {});
  }

  async navigate(sessionId, url) {
    return this.request('session.navigate', { sessionId, url });
  }

  async getState(sessionId) {
    return this.request('session.getState', { sessionId });
  }

  async getContent(sessionId) {
    return this.request('session.getContent', { sessionId });
  }

  async dispatchEvent(sessionId, event) {
    return this.request('session.dispatchEvent', { sessionId, ...event });
  }

  async closeSession(sessionId) {
    try {
      return await this.request('session.close', { sessionId }, 5000);
    } catch (e) {
      return { closed: false, error: e.message };
    }
  }

  async shutdown() {
    try {
      if (this.proc && this.proc.stdin.writable) {
        this.proc.stdin.write(JSON.stringify({ id: this.nextId++, cmd: 'shutdown', args: {} }) + '\n');
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill('SIGTERM'); } catch (_) {}
      setTimeout(() => {
        try { if (this.proc) this.proc.kill('SIGKILL'); } catch (_) {}
      }, 1500);
    }
    if (this.xvfb && !this.xvfb.killed) {
      try { this.xvfb.kill('SIGTERM'); } catch (_) {}
    }
    this.proc = null;
    this.ready = false;
  }
}

const singleton = new WebKitManager();

function installShutdownHooks() {
  const stop = () => {
    singleton.shutdown().catch(() => {});
  };
  process.on('exit', stop);
  process.on('SIGTERM', () => { stop(); process.exit(0); });
  process.on('SIGINT', () => { stop(); process.exit(0); });
}

module.exports = { WebKitManager, webkitManager: singleton, installShutdownHooks };
