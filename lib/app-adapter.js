'use strict';

/**
 * SoloHost Browser — AI knowledge, offline localReply, safe host actions.
 * Actions run on the server (adapter) or are returned for the client to apply (open_url).
 */

const knowledge = `
APP NAME: SoloHost Browser
VERSION: 10.0.0
PLATFORM: Pi Network SoloHost (Docker web app).
ENGINE V10: hybrid-proxy (iframe + HTML proxy). Native WebKitGTK display is NOT available for remote SoloHost HTTP clients without a display transport (documented in docs/V10_ARCHITECTURE.md). Never claim full Chrome parity.

PURPOSE: Lightweight private browser. English + Vietnamese. Simple · Private · Lightweight · Secure · AI-assisted.

UI:
- Top: URL bar, New tab, Bookmark, ☰ Settings, Open ↗
- Bottom: Back, Next, Home, Reload
- Theme rainbow default (dark/light available)
- AI FAB: Chat | Feedback | Settings | Logs

BROWSING:
- Pages load via GET /api/proxy?url=… (same-origin HTML proxy).
- Navigation links stay in proxy; CSS/images from original CDN.
- YouTube watch?v= → embed when possible. Google home → HTML shell (gbv=1).
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
  const list = Array.isArray(logs) ? logs.slice(-80) : [];
  const fails = list.filter(l => l && (l.level === 'error' || l.msg === 'proxy.fail'));
  const blocked = list.filter(l => l && (l.msg === 'proxy.blocked' || l.blocked));
  const shells = list.filter(l => l && l.msg === 'proxy.shell');
  const oks = list.filter(l => l && l.msg === 'proxy.ok');
  const navs = list.filter(l => l && l.msg === 'client.navigate');
  const lastNav = navs.length ? navs[navs.length - 1] : null;
  const lastFail = fails.length ? fails[fails.length - 1] : null;
  const lastBlock = blocked.length ? blocked[blocked.length - 1] : null;

  const tips = [];
  if (lastBlock) {
    tips.push('Site blocked proxy view (' + (lastBlock.blocked || 'blocked') + '): ' + String(lastBlock.url || '').slice(0, 80) + ' — use Open ↗.');
  }
  if (lastFail) {
    tips.push('Proxy fail: ' + (lastFail.code || '') + ' ' + (lastFail.error || lastFail.msg || '') + ' @ ' + String(lastFail.url || '').slice(0, 80));
  }
  const shellHosts = shells.map(s => {
    try { return new URL(s.url).hostname; } catch { return s.url; }
  }).filter(Boolean);
  if (shellHosts.some(h => /youtube|google|vieon|iq\.com|motchill|facebook/i.test(String(h)))) {
    tips.push('Helper shell used for SPA/home (Google/YouTube/streaming) — full app needs ↗ or a watch URL.');
  }
  if (!tips.length && oks.length) {
    tips.push('Recent proxy.ok looks healthy for news/static pages. redirect_asset lines are normal (images).');
  }
  if (!list.length) tips.push('No logs yet — open a page first.');

  return {
    ok: true,
    counts: { total: list.length, ok: oks.length, fail: fails.length, blocked: blocked.length, shell: shells.length, nav: navs.length },
    lastNavigate: lastNav ? { url: lastNav.url, ts: lastNav.ts } : null,
    lastError: lastFail || lastBlock || null,
    tips,
    summary: tips.join(' ')
  };
}

async function localReply(message, live) {
  const msg = String(message || '').trim();
  const lower = msg.toLowerCase();
  const lang = /[àáạảãâăèéẹẻẽêìíịỉĩòóọỏõôơùúụủũưỳýỵỷỹđ]/i.test(msg) || (live && live.lang === 'vi') ? 'vi' : 'en';
  const logs = (live && live.logs) || [];
  const diag = analyzeLogs(logs);
  const url = (live && (live.url || live.currentUrl)) || '';

  const wantsDiag = /log|lỗi|loi|error|fail|blocked|không|khong|treo|chặn|chan|diagnose|phân tích|phan tich|sửa|sua|fix|trắng|trang|white\s*screen|blank|400|duckduckgo|ddg/i.test(msg);
  const wantsHow = /làm sao|lam sao|how|hướng dẫn|huong dan|dùng|dung|help|giúp/i.test(msg);

  if (wantsDiag || /facebook|youtube|google|vieon|phim/i.test(lower)) {
    if (lang === 'vi') {
      let reply = 'Chẩn đoán nhanh từ log gần đây:\n';
      reply += '- ' + diag.tips.join('\n- ');
      if (url) reply += '\n\nTrang hiện tại: ' + url;
      if (/facebook/i.test(lower) || (diag.lastError && /META|facebook/i.test(JSON.stringify(diag.lastError)))) {
        reply += '\n\nFacebook thường chặn proxy (proxy.blocked). Hãy bấm ↗ Open để mở tab hệ thống.';
      }
      if (/youtube/i.test(lower)) {
        reply += '\n\nYouTube trang chủ dùng shell; dán link watch?v=… để xem embed, hoặc ↗ Open.';
      }
      if (/google/i.test(lower) || /trắng|white|blank/i.test(lower)) {
        reply += '\n\nMàn hình trắng khi search Google: Google trả trang trung gian cần JS; proxy không chạy được JS đó. Bản mới hiện trang dự phòng + tìm DuckDuckGo HTML, hoặc bấm ↗ Open Google.';
      }
      if (/400|duckduckgo|ddg|\/l\//i.test(lower)) {
        reply += '\n\nLỗi 400 khi bấm kết quả DuckDuckGo: link dạng /l/?uddg= đã được giải mã thành URL đích thật ở bản 9.0.19. Hãy tải lại app / Refresh trang tìm kiếm rồi bấm lại.';
      }
      return reply;
    }
    let reply = 'Quick diagnosis from recent logs:\n';
    reply += '- ' + diag.tips.join('\n- ');
    if (url) reply += '\n\nCurrent page: ' + url;
    return reply;
  }

  if (wantsHow || /theme|tab|bookmark|proxy/i.test(lower)) {
    if (lang === 'vi') {
      return 'Cách dùng nhanh: gõ địa chỉ ở ô trên → Go. Thanh dưới: Back / Next / Home / Reload. ☰ Settings (theme, lịch sử). Robot AI: Chat, Feedback, Settings AI, Logs. Site phim/Facebook: bấm ↗. Báo/Wikipedia thường mở tốt qua proxy.';
    }
    return 'Quick guide: type URL in the top bar → Go. Bottom: Back / Next / Home / Reload. ☰ Settings for theme & library. AI robot: Chat, Feedback, AI Settings, Logs. Use ↗ for streaming/Facebook. News/Wikipedia usually work via proxy.';
  }

  if (lang === 'vi') {
    return 'SoloHost Browser — duyệt web nhẹ trong SoloHost. Hỏi về lỗi, log, YouTube, Google, theme… hoặc gõ "chẩn đoán" để phân tích log gần đây.';
  }
  return 'SoloHost Browser — lightweight browsing on SoloHost. Ask about errors, logs, YouTube, Google, theme… or say "diagnose" to analyze recent logs.';
}

async function executeAction(action) {
  const name = action && action.name;
  const args = (action && action.args) || {};
  if (name === 'diagnose_logs') {
    try {
      const appLog = require('./app-log');
      const logs = typeof appLog.readLogs === 'function' ? appLog.readLogs(80) : [];
      const diag = analyzeLogs(logs);
      return { ok: true, name: 'diagnose_logs', diagnosis: diag, summary: diag.summary };
    } catch (e) {
      return { ok: false, name: 'diagnose_logs', error: e.message };
    }
  }
  if (name === 'open_url') {
    const url = String(args.url || args.href || '').trim();
    if (!url) return { ok: false, error: 'url required' };
    return { ok: true, name: 'open_url', client: true, args: { url } };
  }
  if (name === 'open_security') {
    return { ok: true, name: 'open_url', client: true, args: { url: '/security.html' } };
  }
  if (name === 'toggle_theme') {
    return { ok: true, name: 'toggle_theme', client: true, args: {} };
  }
  return { ok: false, error: 'Unknown action: ' + name };
}

module.exports = {
  knowledge,
  actions,
  localReply,
  executeAction,
  analyzeLogs
};
