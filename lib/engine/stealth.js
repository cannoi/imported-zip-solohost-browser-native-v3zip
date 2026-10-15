'use strict';
/**
 * Lightweight Chromium anti-automation patches for Playwright (no third-party deps).
 * Applied via addInitScript before any page scripts run.
 * Does not claim to defeat advanced enterprise bot systems (Cloudflare Turnstile, etc.).
 */

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

function chromiumLaunchArgs() {
  return [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--lang=en-US,en',
    '--disable-infobars',
    '--no-first-run',
    '--no-default-browser-check'
  ];
}

/**
 * CDP / init-script fingerprint softening:
 * - navigator.webdriver
 * - automation cdc_* markers
 * - chrome runtime stub
 * - plugins / languages / permissions
 * - Canvas / WebGL / AudioContext light noise (deterministic per session seed)
 */
async function applyToPage(page) {
  if (!page) return;
  try {
    await page.addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      } catch (_) {}

      try {
        const cdcKeys = Object.keys(window).filter((k) => /^cdc_/i.test(k) || /^\$cdc_/i.test(k));
        for (const k of cdcKeys) {
          try { delete window[k]; } catch (_) {}
        }
        try {
          delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
          delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
          delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
        } catch (_) {}
      } catch (_) {}

      try {
        if (!window.chrome) window.chrome = { runtime: {} };
        else if (!window.chrome.runtime) window.chrome.runtime = {};
      } catch (_) {}

      try {
        const orig = navigator.permissions && navigator.permissions.query;
        if (orig) {
          navigator.permissions.query = (params) =>
            params && params.name === 'notifications'
              ? Promise.resolve({ state: Notification.permission })
              : orig.call(navigator.permissions, params);
        }
      } catch (_) {}

      try {
        Object.defineProperty(navigator, 'plugins', {
          get: () => {
            const arr = [
              { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
              { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
              { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
            ];
            arr.item = (i) => arr[i] || null;
            arr.namedItem = (n) => arr.find((p) => p.name === n) || null;
            arr.refresh = () => {};
            return arr;
          }
        });
      } catch (_) {}

      try {
        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en']
        });
      } catch (_) {}

      try {
        Object.defineProperty(navigator, 'hardwareConcurrency', {
          get: () => 8
        });
      } catch (_) {}

      try {
        Object.defineProperty(navigator, 'deviceMemory', {
          get: () => 8
        });
      } catch (_) {}

      try {
        if (navigator.connection) {
          Object.defineProperty(navigator.connection, 'rtt', { get: () => 50 });
          Object.defineProperty(navigator.connection, 'downlink', { get: () => 10 });
        }
      } catch (_) {}

      // Canvas: subtle noise so hash differs from pure SwiftShader defaults without breaking images
      try {
        const toDataURL = HTMLCanvasElement.prototype.toDataURL;
        HTMLCanvasElement.prototype.toDataURL = function (...args) {
          try {
            const ctx = this.getContext && this.getContext('2d');
            if (ctx && this.width > 0 && this.height > 0) {
              const x = (this.width - 1) | 0;
              const y = (this.height - 1) | 0;
              const d = ctx.getImageData(x, y, 1, 1);
              d.data[0] = d.data[0] ^ 1;
              d.data[1] = d.data[1] ^ 2;
              ctx.putImageData(d, x, y);
            }
          } catch (_) {}
          return toDataURL.apply(this, args);
        };
      } catch (_) {}

      // WebGL vendor/renderer — avoid empty/SwiftShader-only fingerprint when possible
      try {
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (param) {
          if (param === 37445) return 'Intel Inc.'; // UNMASKED_VENDOR_WEBGL
          if (param === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
          return getParameter.call(this, param);
        };
        if (typeof WebGL2RenderingContext !== 'undefined') {
          const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
          WebGL2RenderingContext.prototype.getParameter = function (param) {
            if (param === 37445) return 'Intel Inc.';
            if (param === 37446) return 'Intel Iris OpenGL Engine';
            return getParameter2.call(this, param);
          };
        }
      } catch (_) {}

      // AudioContext: tiny constant offset on getChannelData (common anti-bot check)
      try {
        if (typeof AudioBuffer !== 'undefined' && AudioBuffer.prototype.getChannelData) {
          const orig = AudioBuffer.prototype.getChannelData;
          AudioBuffer.prototype.getChannelData = function (channel) {
            const data = orig.call(this, channel);
            if (data && data.length > 0) {
              const i = data.length > 100 ? 100 : 0;
              data[i] = data[i] + 0.0000001;
            }
            return data;
          };
        }
      } catch (_) {}
    });
  } catch (_) {}
}

module.exports = {
  DESKTOP_UA,
  MOBILE_UA,
  chromiumLaunchArgs,
  applyToPage
};
