'use strict';

/**
 * Anti-bot "stealth" profile for the headless Chromium contexts.
 *
 * The User-Agent major version MUST match the Chromium build shipped with the pinned
 * Playwright version (1.40.0 → Chromium 120). A UA that claims a different major version than
 * the real engine is itself a bot fingerprint, so bump both together.
 */

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Playwright's `locale` option takes ONE BCP-47 tag ("vi-VN"). The weighted list
 * "vi-VN,vi;q=0.9,en-US;q=0.8" is an Accept-Language header value, so it is sent as that header.
 */
const STEALTH = Object.freeze({
  userAgent: USER_AGENT,
  locale: 'vi-VN',
  acceptLanguage: 'vi-VN,vi;q=0.9,en-US;q=0.8',
  timezoneId: 'Asia/Ho_Chi_Minh',
  launchArgs: Object.freeze(['--disable-blink-features=AutomationControlled']),
  // Runs in every frame before any page script.
  initScript: `(() => {
  try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}
  try { Object.defineProperty(navigator, 'languages', { get: () => ['vi-VN', 'vi', 'en-US', 'en'] }); } catch (e) {}
  try { if (!window.chrome) window.chrome = { runtime: {} }; } catch (e) {}
})();`
});

module.exports = { STEALTH, USER_AGENT };
