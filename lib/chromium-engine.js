'use strict';
/** DISABLED_IN_V9 — Client WebView architecture. Legacy code: chromium-engine.js.v8-legacy */
module.exports = new Proxy({}, {
  get() { throw new Error('SoloHost Browser v9 uses client WebView — server engine "chromium-engine" is disabled'); }
});
