
'use strict';
function detect() {
  return {
    version: '10.9.0',
    mode: 'playwright-hybrid',
    features: {
      playwrightChromium: process.env.SOLOHOST_PLAYWRIGHT !== '0',
      webkitGtkWorker: process.env.SOLOHOST_WEBKIT_BRIDGE === '1',
      proxyHtml: true,
      domBridge: true,
      cookiesInEngine: true,
      fullJavascriptInEngine: true,
      vnc: false,
      cdpScreencastPrimary: false
    },
    display: {
      note: 'Interactive viewport uses DOM Bridge snapshots from Playwright (scripts already executed in Chromium). Not VNC. Login passwords typed via bridge events stay in engine context and are not logged.'
    },
    limits: [
      'DRM/Widevine not claimed',
      'Pixel-perfect SPA UI may differ from snapshot',
      'EXTERNAL still used for Meta/Netflix policy hosts'
    ]
  };
}
module.exports = { detect };
