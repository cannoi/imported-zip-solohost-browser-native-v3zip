'use strict';
/** Lightweight Chromium anti-automation patches for Playwright (no third-party deps). */

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
    '--lang=en-US,en'
  ];
}

async function applyToPage(page) {
  if (!page) return;
  try {
    await page.addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      } catch (_) {}
      try {
        // Remove common automation markers
        delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
        delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
        delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
      } catch (_) {}
      try {
        if (!window.chrome) window.chrome = { runtime: {} };
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
          get: () => [1, 2, 3, 4, 5]
        });
      } catch (_) {}
      try {
        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en']
        });
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
