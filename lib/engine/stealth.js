
'use strict';
/**
 * SoloHost Browser — lightweight Chromium consistency layer for Playwright.
 *
 * Goals (honest scope):
 *  - Reduce trivial automation signals (navigator.webdriver, missing chrome, odd permissions).
 *  - Align User-Agent / Client Hints with the bundled Chromium major version.
 *  - Prefer stable desktop profiles for documentation research.
 *
 * Non-goals (explicitly NOT claimed):
 *  - Bypassing Cloudflare/Akamai/Kasada enterprise bot management
 *  - Solving CAPTCHA / Google "sorry" interstitials
 *  - Perfect JA3/JA4 TLS fingerprint matching outside Chromium's own stack
 *  - GPU-perfect WebGL fingerprints inside all Docker hosts
 *
 * Sites may still challenge shared datacenter IPs. Users should complete challenges
 * or use Open ↗ for sensitive flows.
 */

const CHROME_MAJOR = '131';
const CHROME_FULL = '131.0.0.0';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' +
  CHROME_FULL + ' Safari/537.36';

const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' +
  CHROME_FULL + ' Mobile Safari/537.36';

function clientHintHeaders(locale, mobile) {
  const lang = String(locale || 'en-US');
  const primary = lang.split(',')[0].trim() || 'en-US';
  return {
    'Accept-Language': primary + (primary.toLowerCase().startsWith('en') ? ',en;q=0.9' : ',' + primary.split('-')[0] + ';q=0.9,en;q=0.8'),
    'sec-ch-ua': '"Google Chrome";v="' + CHROME_MAJOR + '", "Chromium";v="' + CHROME_MAJOR + '", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': mobile ? '?1' : '?0',
    'sec-ch-ua-platform': mobile ? '"Android"' : '"Windows"',
    'Upgrade-Insecure-Requests': '1',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
  };
}

/** Chromium launch flags that reduce common automation markers without privileged GPU. */
function chromiumLaunchArgs() {
  return [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process,AutomationControlled',
    '--disable-infobars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-ipc-flooding-protection',
    '--password-store=basic',
    '--use-mock-keychain',
    // Prefer ANGLE software path that looks closer than pure SwiftShader when GPU absent
    '--use-gl=angle',
    '--use-angle=swiftshader-webgl'
  ];
}

/**
 * Init script injected before page JS. Keep deterministic (no random fingerprints
 * that change every load and look more suspicious).
 */
function initScriptSource() {
  return `(() => {
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
  } catch (_) {}

  try {
    // Remove common Playwright/Chromium automation leftovers if present
    const kill = [
      '__playwright', '__pw_manual', '__PW_inspect',
      'cdc_adoQpoasnfa76pfcZLmcfl', 'cdc_adoQpoasnfa76pfcZLmcFl'
    ];
    for (const k of kill) {
      try { delete window[k]; } catch (_) {}
      try { delete document[k]; } catch (_) {}
    }
  } catch (_) {}

  try {
    if (!window.chrome) {
      window.chrome = { runtime: {}, loadTimes: function(){}, csi: function(){}, app: {} };
    } else if (!window.chrome.runtime) {
      window.chrome.runtime = {};
    }
  } catch (_) {}

  try {
    Object.defineProperty(navigator, 'languages', {
      get: () => Object.freeze(['en-US', 'en']),
      configurable: true
    });
  } catch (_) {}

  try {
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const fake = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
        ];
        fake.item = (i) => fake[i] || null;
        fake.namedItem = (n) => fake.find((p) => p.name === n) || null;
        fake.refresh = () => {};
        return fake;
      },
      configurable: true
    });
  } catch (_) {}

  try {
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
  } catch (_) {}
  try {
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });
  } catch (_) {}
  try {
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0, configurable: true });
  } catch (_) {}

  try {
    const orig = navigator.permissions && navigator.permissions.query;
    if (orig) {
      navigator.permissions.query = (params) => {
        if (params && params.name === 'notifications') {
          return Promise.resolve({ state: Notification.permission || 'default', onchange: null });
        }
        return orig.call(navigator.permissions, params);
      };
    }
  } catch (_) {}

  try {
    // Soft WebGL vendor/renderer (software GL in Docker still detectable via other signals)
    const proto = WebGLRenderingContext && WebGLRenderingContext.prototype;
    if (proto && proto.getParameter) {
      const raw = proto.getParameter;
      proto.getParameter = function (param) {
        const UNMASKED_VENDOR = 0x9245;
        const UNMASKED_RENDERER = 0x9246;
        if (param === UNMASKED_VENDOR) return 'Google Inc. (NVIDIA)';
        if (param === UNMASKED_RENDERER) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1050 Direct3D11 vs_5_0 ps_5_0)';
        return raw.apply(this, arguments);
      };
    }
  } catch (_) {}

  try {
    // Minimal canvas noise: only when toDataURL is called (deterministic offset)
    const toDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function () {
      try {
        const ctx = this.getContext && this.getContext('2d');
        if (ctx && this.width > 16 && this.height > 16) {
          const img = ctx.getImageData(0, 0, 2, 2);
          if (img && img.data && img.data.length >= 4) {
            img.data[0] = img.data[0] ^ 1;
            ctx.putImageData(img, 0, 0);
          }
        }
      } catch (_) {}
      return toDataURL.apply(this, arguments);
    };
  } catch (_) {}
})();`;
}

async function applyToPage(page) {
  if (!page) return;
  try {
    await page.addInitScript({ content: initScriptSource() });
  } catch (_) {
    try {
      await page.addInitScript(initScriptSource());
    } catch (_) {}
  }
}

module.exports = {
  CHROME_MAJOR,
  CHROME_FULL,
  DESKTOP_UA,
  MOBILE_UA,
  clientHintHeaders,
  chromiumLaunchArgs,
  initScriptSource,
  applyToPage
};
