'use strict';

/**
 * Anti-bot stealth profile for headless Chromium contexts.
 *
 * User-Agent major must match Playwright 1.40.0 Chromium 120.
 * timezoneId / locale are NO LONGER fixed to Asia/Ho_Chi_Minh — ContentExtractor
 * resolves them via lib/geoip.js (public IP) so they match egress, not a hard-coded region.
 */

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Static baseline (overridden per context by GeoIP). */
const STEALTH = Object.freeze({
  userAgent: USER_AGENT,
  locale: 'en-US',
  acceptLanguage: 'en-US,en;q=0.9',
  timezoneId: 'UTC',
  launchArgs: Object.freeze(['--disable-blink-features=AutomationControlled']),
  initScript: `(() => {
  try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}
  try { Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] }); } catch (e) {}
  try { if (!window.chrome) window.chrome = { runtime: {} }; } catch (e) {}
})();`
});

function buildInitScript(languages) {
  const langs = JSON.stringify(Array.isArray(languages) && languages.length ? languages : ['en-US', 'en']);
  return `(() => {
  try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}
  try { Object.defineProperty(navigator, 'languages', { get: () => ${langs} }); } catch (e) {}
  try { if (!window.chrome) window.chrome = { runtime: {} }; } catch (e) {}
})();`;
}

module.exports = { STEALTH, USER_AGENT, buildInitScript };
