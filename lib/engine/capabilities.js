
'use strict';
function detect() {
  return {
    version: '10.9.8',
    mode: 'playwright-multi-engine-mobile-bridge',
    features: {
      playwrightChromium: process.env.SOLOHOST_PLAYWRIGHT !== '0',
      playwrightFirefoxFallback: process.env.SOLOHOST_PLAYWRIGHT !== '0',
      playwrightWebKitFallback: process.env.SOLOHOST_PLAYWRIGHT !== '0',
      mobileFirstBridge: process.env.SOLOHOST_BROWSER_MOBILE !== '0',
      sessionRecovery: true,
      googleVerificationFallback: true,
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
      'Google verification/challenges cannot be bypassed; search falls back transparently when possible',
      'Firefox/WebKit are launch-time fallback engines; site anti-bot blocks are not fixed by engine switching',
      'EXTERNAL still used for Meta/Netflix policy hosts'
    ]
  };
}
module.exports = { detect };
