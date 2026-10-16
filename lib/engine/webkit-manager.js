'use strict';
/** WebKit backend removed — Chromium is the only engine. Stub keeps API shape for callers. */
const webkitManager = {
  async status() { return { ready: false, error: 'webkit_disabled', backend: 'none' }; },
  async createSession() { throw new Error('webkit_disabled'); },
  async navigate() { throw new Error('webkit_disabled'); },
  async getState() { return { ready: false }; },
  async closeSession() { return { ok: true }; },
  async getContent() { return { html: '', error: 'webkit_disabled' }; },
  async dispatchEvent() { return { ok: false, error: 'webkit_disabled' }; }
};
module.exports = { webkitManager };
