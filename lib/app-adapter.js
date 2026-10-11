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
VERSION FEATURES (v10.17+ / v10.18):
- Auto Bridge soft-refresh on focus/visibility/scroll is DISABLED (caused flicker and scroll jumps). Viewport content is captured once per navigation; images are nudged eager at snapshot + frame load. User must Reload (↻) to fetch a fresh page snapshot. Scroll position is never rewritten by background updates.

- Bridge live refresh on focus/visibility/scroll with scroll restore for full content at viewport.

- Splash screen 5s with official logo on launch; home shows only 3 utility panels (Playlist, Scripts, SoloHost Apps).
- Scripts: sample (◎) run without AI; user scripts (✦) prefer AI Action then local navigate steps.
- User scripts support schedule (waitUntil HH:MM), one-shot navigate, and repeatEveryMs (interval minutes) for timed/repeating AI Action tasks.
- Localhost http://127.0.0.1:ANY_PORT fully allowed for SoloHost Pi apps.
- VERSION FEATURES (v10.17+):
- Home screen utilities: Video playlists (YouTube/TikTok/Facebook/web URLs), Scripts (scheduled navigate without AI), SoloHost Apps (http://127.0.0.1:PORT allowed for local apps).
- Playlist: create/delete lists, add URL, play, next, music mode (YouTube embed autoplay when possible).
- Scripts: sample templates (morning YouTube 05:00–10:20, news, DDG, Wikipedia, lofi, evening YT, sequences). Run/Stop client-side with waitUntil/waitMs/navigate/stopAt — no API key required.
- SoloHost Apps: user saves name + URL including localhost/127.0.0.1; SSRF still blocks LAN/metadata and dangerous ports.
- Long-press context on remote iframe video is limited by browser isolation; use playlist URL form or “add current URL”.
- AI remains optional assist; browsing works offline from AI keys.

RUNTIME VERSION: ${version} (read from the installed package at runtime; do not assume a version from old chat history).
PLATFORM: Pi Network SoloHost, usually a Docker web app. Product goal: compact, international, privacy-first browser for ordinary users. UI is English/Vietnamese; answer in the user's language.

CURRENT ARCHITECTURE:
- Playwright Chromium runs the real website JavaScript and maintains its page/session; the UI presents a sanitized, interactive DOM Bridge snapshot. This is not a pixel-perfect full Chromium viewport.
- Adaptive Layout is the default: preserve website styles and structure while sanitizing scripts and unsafe embeds in the display copy. Bridge events route clicks, form input, selection and navigation to the live engine DOM where supported.
- Per-tab sessions, persistent sessions for normal tabs, private sessions without persistent browser storage, long-press/right-click context menu, and a multi-tab UI (up to 12 visible tabs) are supported. Do not claim private mode hides IP or site-side identity.
- Settings menu includes Theme, History/Bookmarks, Reader, Summarize, Translate, language, and Default Search Engine. Search engines: Bing (default), Google, DuckDuckGo, Brave Search, and Custom URL using {query} or %s. Explicit URLs are navigated directly; plain text uses the selected search engine. Settings are stored in the current browser profile's localStorage.

MEDIA SUPPORT:
- Native HTML5 audio/video and common image/document links are preserved where source markup, browser codec support, and website policy allow. Audio/video may be playable in the page; direct file links may open in a new tab or system browser depending on response headers.
- Official allowlisted embed hosts include YouTube, TikTok, Vimeo, Spotify, Twitch and Dailymotion. YouTube watch/Shorts/live clicks are handed to the local player shell, which embeds YouTube's official player; standard TikTok video URLs may be mapped to TikTok's official embed endpoint.
- Do not promise every YouTube/TikTok video plays in an embedded view. Geo restrictions, age restrictions, login, DRM/Widevine, autoplay policy, browser codecs, ad blockers, and anti-bot checks can prevent playback. Use Open ↗ for full-site UI or protected media. Cross-origin player controls cannot reliably be automated through the Bridge.
- Google/Bing verification challenges are not bypassed. Site anti-bot checks are also not bypassed. Playwright automation, a sanitized DOM snapshot, request filtering, unusual request patterns or shared-host IP reputation may cause a site to show a challenge; logs alone cannot prove which signal caused it. Do not spoof fingerprints, hide automation, rotate identities, or solve CAPTCHA. Respect the site's policy and offer a user-initiated Open ↗ in the system browser when needed.

SECURITY & LIMITS:
- The Bridge strips scripts from the displayed HTML snapshot, but scripts already execute in the isolated Playwright engine to obtain the real DOM. Unsafe iframe sources and inline event handlers are removed. CSP allows only a limited media frame list.
- SSRF protections block loopback/private/unsafe destinations for server-side fetches. Never recommend disabling SSRF, exposing Docker sockets, or removing URL validation.
- Ads/tracker filtering is conservative and may occasionally affect site resources; first-party ads can remain. DRM, native app handoff, CAPTCHA and site anti-bot policies are not bypassed.
- Login routes for Google/Facebook/TikTok may be handed off to the system browser due to site policy. Cookies between the system browser and embedded engine are not guaranteed to sync.

AI PANEL / DIAGNOSIS:
- This knowledge is generated at runtime from the installed package version and engine capability flags, so the installed app version is authoritative.
- Useful logs: client.navigate, client.navigate_result, youtube.video_handoff, proxy.youtube_player, bridge.playwright_nav_fail, bridge.playwright_hybrid, client.bridge_render_audit, client.bridge_ai_compat_finding, playwright.request_filtered, bridge.google_search_fallback, proxy.fail/proxy.blocked when proxy paths are involved. A Bridge render audit warning means the snapshot may omit iframe/media/controls; it is not a YouTube playback error code.
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
      return 'SoloHost Browser chạy trang thật bằng Playwright và hiển thị bản DOM Bridge đã làm sạch; snapshot có thể bỏ iframe/media nên không giống Chrome đầy đủ. YouTube watch/Shorts/live được chuyển sang trang phát bằng trình nhúng chính thức; kiểm tra log youtube.video_handoff và proxy.youtube_player. Nếu video không cho nhúng, bị giới hạn tuổi/khu vực, cần đăng nhập hoặc gặp challenge thì dùng Open ↗. App không giả mạo dấu vân tay hay vượt CAPTCHA.';
    }
    return 'SoloHost Browser runs sites in Playwright and displays a sanitized DOM Bridge snapshot; the snapshot may omit iframe/media and differ from full Chrome. YouTube watch/Shorts/live clicks are routed to the official embed player shell; check youtube.video_handoff and proxy.youtube_player. If embedding is disabled, age/region/login restrictions or a challenge applies, use Open ↗. The app does not spoof fingerprints or bypass CAPTCHA.';
  }
  if (/playlist|danh sách phát|script|tập lệnh|solohost app|localhost/.test(q)) {
    return L === 'vi'
      ? 'Trang chủ: Playlist (thêm URL video, ▶/♪/⏭), Scripts (mẫu chạy không cần AI — Run/Stop), App SoloHost (http://127.0.0.1:PORT). Localhost đã được mở cho app local; cổng nguy hiểm vẫn chặn.'
      : 'Home: Playlist (add video URL, ▶/♪/⏭), Scripts (samples run without AI — Run/Stop), SoloHost Apps (http://127.0.0.1:PORT). Loopback is allowed for local apps; dangerous ports stay blocked.';
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
