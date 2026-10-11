'use strict';

/**
 * SoloHost Browser — AI knowledge, offline localReply, safe host actions.
 * Actions run on the server (adapter) or are returned for the client to apply (open_url).
 */

function buildKnowledge() {
  let version = 'unknown';
  let caps = {};
  try { version = require('../package.json').version || version; } catch (_) {}
  try { caps = require('./engine/capabilities').detect(); } catch (_) {}
  const enabled = Object.entries(caps.features || {}).filter(([, value]) => value === true).map(([key]) => key);
  return `
APP NAME: SoloHost Browser
RUNTIME VERSION: ${version} (read from the installed package at runtime; do not assume a version from old chat history).
PLATFORM: Pi Network SoloHost, usually a Docker web app. Product goal: compact, international, privacy-first browser for ordinary users. UI is English/Vietnamese; answer in the user's language.

CURRENT ARCHITECTURE:
- Playwright Chromium runs the real website JavaScript and maintains its page/session; the UI presents a sanitized, interactive DOM Bridge snapshot. This is not a pixel-perfect full Chromium viewport.
- Adaptive Layout is the default: preserve website styles and structure while sanitizing scripts and unsafe embeds in the display copy. Bridge events route clicks, form input, selection and navigation to the live engine DOM where supported.
- Per-tab sessions, persistent sessions for normal tabs, private sessions without persistent browser storage, long-press/right-click context menu, and a multi-tab UI (up to 12 visible tabs) are supported. Do not claim private mode hides IP or site-side identity.
- Settings menu includes Theme, History/Bookmarks, Reader, Summarize, Translate, language, and Default Search Engine. Search engines: Bing (default), Google, DuckDuckGo, Brave Search, and Custom URL using {query} or %s. Explicit URLs are navigated directly; plain text uses the selected search engine. Settings are stored in the current browser profile's localStorage.

MEDIA SUPPORT:
- Native HTML5 audio/video and common image/document links are preserved where source markup, browser codec support, and website policy allow. Audio/video may be playable in the page; direct file links may open in a new tab or system browser depending on response headers.
- Official allowlisted embed hosts include YouTube, TikTok, Vimeo, Spotify, Twitch and Dailymotion. YouTube watch pages may be rendered through an official embed fallback; standard TikTok video URLs may be mapped to TikTok's official embed endpoint.
- Do not promise every YouTube/TikTok video plays in an embedded view. Geo restrictions, age restrictions, login, DRM/Widevine, autoplay policy, browser codecs, ad blockers, and anti-bot checks can prevent playback. Use Open ↗ for full-site UI or protected media. Cross-origin player controls cannot reliably be automated through the Bridge.
- Google/Bing verification challenges are not bypassed. If a site requires user verification or system-browser authentication, explain this and offer Open ↗; do not solve CAPTCHA or ask the user to send passwords/OTP to AI.

SECURITY & LIMITS:
- The Bridge strips scripts from the displayed HTML snapshot, but scripts already execute in the isolated Playwright engine to obtain the real DOM. Unsafe iframe sources and inline event handlers are removed. CSP allows only a limited media frame list.
- SSRF protections block loopback/private/unsafe destinations for server-side fetches. Never recommend disabling SSRF, exposing Docker sockets, or removing URL validation.
- Ads/tracker filtering is conservative and may occasionally affect site resources; first-party ads can remain. DRM, native app handoff, CAPTCHA and site anti-bot policies are not bypassed.
- Login routes for Google/Facebook/TikTok may be handed off to the system browser due to site policy. Cookies between the system browser and embedded engine are not guaranteed to sync.

AI PANEL / DIAGNOSIS:
- This knowledge is generated at runtime from the installed package version and engine capability flags, so the installed app version is authoritative.
- Useful logs: client.navigate, client.navigate_result, bridge.playwright_nav_fail, bridge.playwright_hybrid, client.bridge_render_audit, client.bridge_ai_compat_finding, playwright.request_filtered, bridge.google_search_fallback, proxy.fail/proxy.blocked when proxy paths are involved.
- A repeated render audit can indicate the sanitized snapshot differs from source DOM; it is not by itself proof that navigation failed. request_filtered indicates a matched filter rule, not necessarily a failure. Correlate with navigation result and page behavior.
- When users report media problems, ask which site/URL, media type, whether the player appears, and relevant recent warning/error logs. Diagnose policy/codec/embed limitations before suggesting a code change.

CAPABILITIES ENABLED IN THIS INSTALL:
${enabled.length ? enabled.join(', ') : 'Capability report unavailable'}

SUPPORT STYLE:
- Give accurate, concise guidance in Vietnamese or English matching the user. Never claim full Chrome parity or guaranteed playback. Explain the smallest useful next step and distinguish confirmed evidence from hypotheses.
`;
}

const actions = [
  { name: 'open_url', description: 'Navigate SoloHost Browser to a URL (client applies)', requiresConfirmation: false },
  { name: 'diagnose_logs', description: 'Summarize recent browser/proxy errors from logs', requiresConfirmation: false },
  { name: 'open_security', description: 'Open security info page', requiresConfirmation: false },
  { name: 'toggle_theme', description: 'Cycle theme rainbow/dark/light (client)', requiresConfirmation: false }
];

function analyzeLogs(logs) {
  const list = Array.isArray(logs) ? logs.slice(-100) : [];
  // Ignore container noise that is NOT the root cause of empty Google/YouTube UI
  const noiseRe = /fontconfig|dconf|dbus|gsettings|unable to get session/i;
  const fails = list.filter(l => l && (l.level === 'error' || l.msg === 'proxy.fail') && !noiseRe.test(String(l.error || l.msg || '')));
  const blocked = list.filter(l => l && (l.msg === 'proxy.blocked' || l.blocked));
  const shells = list.filter(l => l && l.msg === 'proxy.shell');
  const oks = list.filter(l => l && l.msg === 'proxy.ok');
  const navs = list.filter(l => l && (l.msg === 'client.navigate' || l.msg === 'navigate' || l.msg === 'navigate_result'));
  const wk = list.filter(l => l && /webkit|bridge\.webkit/i.test(String(l.msg || '')));
  const lastNav = navs.length ? navs[navs.length - 1] : null;
  const lastFail = fails.length ? fails[fails.length - 1] : null;
  const lastBlock = blocked.length ? blocked[blocked.length - 1] : null;
  const lastShell = shells.length ? shells[shells.length - 1] : null;
  const lastOk = oks.length ? oks[oks.length - 1] : null;

  const tips = [];
  if (lastBlock) {
    tips.push('Site blocked proxy (' + (lastBlock.blocked || 'blocked') + '): use Open ↗. URL ' + String(lastBlock.url || '').slice(0, 80));
  }
  if (lastFail) {
    tips.push('Proxy fail: ' + (lastFail.code || '') + ' ' + (lastFail.error || '') + ' @ ' + String(lastFail.url || '').slice(0, 80));
  }
  if (lastShell) {
    tips.push('proxy.shell for ' + String(lastShell.url || '').slice(0, 80) + ' — lightweight helper page (expected for Google/YouTube home), not a Fontconfig crash.');
  }
  if (lastOk && !lastFail) {
    tips.push('Recent proxy.ok — network path works; blank SPA UI is usually script-stripped proxy limits, not missing /tmp write.');
  }
  if (wk.length) {
    const lastW = wk[wk.length - 1];
    tips.push('WebKit/bridge note: ' + String(lastW.msg || '') + ' ' + String(lastW.error || '').slice(0, 80) + ' — UI falls back to PROXY.');
  }
  if (!tips.length) {
    tips.push('No hard proxy.fail in recent logs. For full Google/YouTube app use ↗ Open; search forms work in proxy shell.');
  }

  return {
    recentNav: lastNav ? (lastNav.url || lastNav.msg) : null,
    lastOk: lastOk ? lastOk.url : null,
    lastShell: lastShell ? lastShell.url : null,
    failCount: fails.length,
    blockCount: blocked.length,
    shellCount: shells.length,
    okCount: oks.length,
    tips,
    note: 'Fontconfig/dconf lines are usually Docker noise when XDG dirs exist; they are not proof that Google/YouTube failed due to permissions.'
  };
}


function localReply(message, lang) {
  const q = String(message || '').toLowerCase();
  const vi = lang === 'vi' || /[àáạảãăằắặẳẵâầấậẩẫèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/.test(message || '');
  const L = vi ? 'vi' : 'en';

  if (/youtube|google|fontconfig|dconf|không hiển thị|không vào|blank|trắng/.test(q)) {
    if (L === 'vi') {
      return 'SoloHost Browser chạy trang thật bằng Playwright và hiển thị bản DOM Bridge đã làm sạch, nên giao diện có thể khác Chrome đầy đủ. Thử cập nhật app, tải lại trang và kiểm tra client.navigate_result cùng bridge.playwright_nav_fail / bridge.playwright_hybrid / client.bridge_render_audit. Video YouTube/TikTok dùng trình phát/nhúng chính thức khi website cho phép; DRM, đăng nhập, codec hoặc anti-bot có thể yêu cầu Open ↗. Xác minh của Google/Bing không bị vượt qua tự động.';
    }
    return 'SoloHost Browser runs the real site in Playwright and displays a sanitized DOM Bridge snapshot, so it may differ from full Chrome. Reload and inspect client.navigate_result plus bridge.playwright_nav_fail / bridge.playwright_hybrid / client.bridge_render_audit. YouTube/TikTok use official player/embed paths when permitted; DRM, login, codecs or anti-bot policies may require Open ↗. Google/Bing challenges are not bypassed.';
  }
  if (/cách dùng|how to|help|hướng dẫn/.test(q)) {
    return L === 'vi'
      ? 'Nhập địa chỉ hoặc từ khóa → Go. Tab trên; Back/Forward/Home/Reload dưới. ↗ mở ngoài. AI panel: Chat/Feedback/Settings/Logs.'
      : 'Enter address or search → Go. Tabs on top; Back/Forward/Home/Reload below. ↗ opens externally. AI panel: Chat/Feedback/Settings/Logs.';
  }
  return L === 'vi'
    ? 'SoloHost Browser — duyệt nhẹ qua Bridge/Proxy. Hỏi về lỗi: mô tả trang + xem tab Logs (proxy.fail / proxy.shell).'
    : 'SoloHost Browser — light Bridge/Proxy browsing. For errors: describe the page and check Logs (proxy.fail / proxy.shell).';
}

async function executeAction(name, args, ctx) {
  const a = args || {};
  if (name === 'diagnose_logs') {
    const logs = (ctx && ctx.logs) || [];
    return { ok: true, analysis: analyzeLogs(logs) };
  }
  if (name === 'open_url') {
    return { ok: true, client: { type: 'open_url', url: String(a.url || '') } };
  }
  if (name === 'open_security') {
    return { ok: true, client: { type: 'open_url', url: '/security.html' } };
  }
  if (name === 'toggle_theme') {
    return { ok: true, client: { type: 'toggle_theme' } };
  }
  return { ok: false, error: 'unknown_action' };
}


module.exports = {
  get knowledge() { return buildKnowledge(); },
  buildKnowledge,
  actions,
  localReply,
  executeAction,
  analyzeLogs
};
