'use strict';
/** WebKitGTK worker removed — Chromium + proxy only. Stub keeps require() stable. */
const webkitManager = {
  enabled: () => false,
  status: async () => ({ ok: true, ready: false, engine: 'webkit', reason: 'removed_chromium_only' }),
  createSession: async () => { throw new Error('webkit_removed'); },
  navigate: async () => { throw new Error('webkit_removed'); },
  getState: async () => ({ ready: false }),
  closeSession: async () => ({ closed: false }),
  ensureStarted: async () => ({ ok: false, reason: 'webkit_removed' })
};
module.exports = { webkitManager, enabled: () => false };
