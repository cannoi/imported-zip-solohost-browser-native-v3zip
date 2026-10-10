'use strict';

/**
 * SoloHost Browser — AI knowledge, offline localReply, safe host actions.
 * Actions run on the server (adapter) or are returned for the client to apply (open_url).
 */

const knowledge = `
APP NAME: SoloHost Browser
VERSION: 10.0.0
PLATFORM: Pi Network SoloHost (Docker web app).

BRIDGE POLICY V10.3.3 (PROXY-first):
- Default navigation uses HTML PROXY only. WebKit DOM Bridge is OFF unless SOLOHOST_WEBKIT_BRIDGE=1.
- Logs with bridge.session_create + js_timeout/ipc_timeout mean the old ENGINE path — should no longer run by default.
- Google search interstitial → fast DuckDuckGo HTML fallback (not a network outage).
- YouTube /results is rendered as a native result list; /watch pages show the official embed player (v10.3.5).

LOGIN: TikTok/Facebook/Google sign-in cannot complete inside the HTML proxy (JS+cookies+CAPTCHA). App shows login_external page + ↗ Open. META_ERROR is Facebook-only; TikTok login is not META_ERROR. Never tell users to type passwords into AI.

ACCURATE DIAGNOSIS (V10.3.1 — do NOT blame Fontconfig/dconf as the primary reason Google/YouTube look empty):
1) Interactive UI is hybrid: DOM Bridge (optional WebKit) → HTML proxy fallback → ↗ EXTERNAL.
2) Google/YouTube are SPA/JS-heavy. Proxy strips scripts for safety → homepage often shows a lightweight search shell (by design), not a full Chrome feed.
3) Fontconfig/dconf warnings in Docker logs are noise when HOME/XDG dirs are fixed; they do NOT mean "no internet". Prefer checking proxy.ok / proxy.fail / bridge.webkit_* / navigate_result in logs.
4) bridge.webkit_unavailable / max_sessions → WebKit worker unavailable; app must use PROXY automatically (cooldown 5 min after streak).
5) For full Google/YouTube app (login, feed, player SPA): use ↗ Open. For search: use omnibox or in-shell search forms.
6) Never tell the user that fixing only /tmp permissions will make YouTube feed work inside the proxy iframe.

ENGINE V10.2: UI modes ENGINE (DOM bridge/WebKit) → PROXY fallback → EXTERNAL ↗. No forced Google gbv=1 or DuckDuckGo. Per-tab bridge sessions. ENGINE V10: hybrid-proxy (iframe + HTML proxy). Native WebKitGTK display is NOT available for remote SoloHost HTTP clients without a display transport (documented in docs/V10_ARCHITECTURE.md). Never claim full Chrome parity.

AGENT MODE (v10.4.0): In the AI panel Chat tab the 🤖 button switches to Agent mode. In that mode the user gives a TASK and the AI
operates the open page step by step: it reads the page text and a numbered list of links/buttons/fields, then opens URLs, runs searches
(youtube/google/ddg), clicks, types into fields, selects options, scrolls and goes back — up to 15 steps, with a Stop button.
Rules you must tell users truthfully: it needs a configured AI provider (offline it only understands simple commands such as
"mở example.com" or "tìm phim hay trên youtube"); sensitive clicks (buy/pay/delete/send/log out...) always ask the user to Allow/Deny;
it never types into password/card/OTP fields (it asks the user instead); it cannot see or control cross-origin embeds (e.g. press Play
inside the YouTube player), CAPTCHA, DRM video, file uploads, or sites shown only via ↗ Open; POST forms may not work through the proxy.
If the user asks you (in normal chat) to do something on the page, suggest turning on Agent mode with the 🤖 button.

PURPOSE: Lightweight private browser. English + Vietnamese. Simple · Private · Lightweight · Secure · AI-assisted.

UI:
- Top: URL bar, New tab, Bookmark, ☰ Settings, Open ↗
- Bottom: Back, Next, Home, Reload
- Theme rainbow default (dark/light available)
- AI FAB: Chat | Feedback | Settings | Logs

BROWSING:
- Pages load via GET /api/proxy?url=… (same-origin HTML proxy).
- Navigation links stay in proxy; CSS/images from original CDN.
- YouTube watch?v= → native player page (embed). Google home → HTML shell (gbv=1). Google search blocked → DuckDuckGo results automatically.
- Streaming (VieON, iQIYI, Motchill, Netflix) → use ↗ Open (DRM cannot play in proxy).
- Facebook/Meta often returns proxy.blocked META_ERROR — use ↗ Open.

LOG EVENTS (for diagnosis):
- client.navigate — user opened a URL
- proxy.request / proxy.ok — HTML fetched OK (status, ms, title snippet)
- proxy.fail — fetch error (code, error message)
- proxy.blocked — site anti-bot / sorry page (blocked=META_ERROR|GOOGLE_CAPTCHA|…)
- proxy.shell — helper page (Google/YouTube home, video sites)
- proxy.cache — repeated URL served from short cache
- proxy.redirect_asset — image/font redirected to origin (normal, not an error)
- client.navigate_deduped — same URL ignored within 1.2s (loop protection)
- server.listen — app started

HOW TO HELP USERS:
- Answer in the user's language (Vietnamese or English).
- When diagnosing, use recent logs: prefer proxy.fail / proxy.blocked / proxy.shell over redirect_asset noise.
- News sites (thanhnien, tuoitre, wikipedia) usually proxy.ok — browsing works.
- Google search proxy.ok with gbv=1 is expected HTML mode, not a failure.
- YouTube home proxy.shell is expected; paste watch URL or use ↗.
- Suggest ↗ Open for login, banking, DRM video, Facebook app.
- Actions: open_url to navigate; diagnose_logs to summarize errors.
`;

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
      return 'Google/YouTube trong SoloHost Browser thường hiện trang shell tìm kiếm (proxy), không phải feed đầy đủ như Chrome. Nguyên nhân chính: trang SPA cần JavaScript phức tạp — proxy cố ý gỡ script để an toàn. Cảnh báo Fontconfig/dconf trong Docker thường chỉ là nhiễu nếu thư mục XDG đã ghi được; không có nghĩa là mất Internet. Cách dùng: gõ từ khóa trên trang shell hoặc thanh địa chỉ; xem video bằng link youtube.com/watch?v=… hoặc bấm ↗ Open. Log cần xem: proxy.ok / proxy.shell / proxy.fail / bridge.webkit_* — không kết luận chỉ từ Fontconfig.';
    }
    return 'Google/YouTube inside SoloHost Browser usually show a lightweight search shell (proxy), not the full Chrome feed. Root cause: SPA needs complex JS; the proxy strips scripts on purpose. Fontconfig/dconf lines in Docker are often noise once XDG dirs are writable — not proof of no Internet. Use the shell/omnibox to search; open watch?v= links or tap ↗ Open for the full app. Prefer logs proxy.ok / proxy.shell / proxy.fail / bridge.webkit_* over Fontconfig.';
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
  knowledge,
  actions,
  localReply,
  executeAction,
  analyzeLogs
};
