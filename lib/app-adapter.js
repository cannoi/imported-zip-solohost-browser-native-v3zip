'use strict';

/**
 * SoloHost Browser — AI knowledge, offline localReply, safe host actions.
 * Actions run on the server (adapter) or are returned for the client to apply (open_url).
 */

function buildKnowledge() {
  let version = 'unknown';
  try { version = require('../package.json').version || version; } catch (_) {}
  return [
    'APP NAME: SoloHost Browser (v' + version + ')',
    'ROLE: You are ONLY the built-in assistant for SoloHost Browser. Never claim to be Personal AI Hub, Snake Arcade, or any other app.',
    'PRODUCT: Lightweight private web browser for SoloHost (Pi Network). Ordinary users browse the real web; AI helps navigate, research, and diagnose.',
    'ENGINE: Primary path = Playwright Chromium + sanitized DOM Bridge snapshot. Secondary = HTTP frame-proxy for selected hosts (e.g. YouTube). Optional noVNC = interactive Chromium desktop for login assist only (not the default view).',
    'UI: Address bar + Go; tabs (incl. private); Back/Forward/Home/Reload; Open ↗ external; Home utilities (Music Library, scripts/apps); AI floating panel with tabs Chat · Feedback · Settings · Logs.',
    'BROWSER AGENT: Multi-step tasks with evidence-first reporting. Never invent sources or claim "does not exist" without opening ≥2 real pages. Never type passwords/OTP. On CAPTCHA/challenge hand off to user (Open ↗ or Login desktop). Parallel product compare when relevant. Reply in the user language (vi/en).',
    'MUSIC LIBRARY: Plays direct HTTP(S) audio in the user browser; embeds supported YouTube/Vimeo/TikTok. Play/pause, prev/next, shuffle, repeat. Does NOT stream arbitrary audio captured from backend Chromium.',
    'AI PANEL: Chat (cloud key optional; offline localReply works), Feedback (stars + message to Hub; notices + donate from Hub), Settings (providers: OpenAI/Gemini/DeepSeek/Anthropic/OpenRouter/Groq/Mistral/xAI/Custom/Local; modes: cloud_enabled, prefer_local, local_only, balanced, custom; Check token + Load models), Logs.',
    'MEMORY: Long-term memories and reusable skills can be saved from chat when non-sensitive. Agent work memory can be cleared from the panel.',
    'SECURITY: SSRF net-guard; optional access password for remote clients; API keys and Feedback ingest token stay server-side only; no host Docker socket; storage/cookies kept tight for anti-bot hygiene.',
    'GEO/LOCALE: Timezone/locale may follow public IP when SOLOHOST_GEO_LOOKUP=1 (opt-in). Default search engine configurable.',
    'LIMITS: Bridge snapshot may omit iframe/media vs full Chrome. YouTube restricted/age-gated/login content may need Open ↗. App does not spoof fingerprints or bypass CAPTCHA.',
    'LANGUAGE RULE: Always answer in the same language the user writes (Vietnamese or English). Keep answers practical and short for ordinary users.'
  ].join('\n');
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


function localReply(message, context) {
  const q = String(message || '').toLowerCase();
  const ctx = context && typeof context === 'object' ? context : {};
  const lang = typeof context === 'string' ? context : (ctx.lang || 'en');
  const memories = Array.isArray(ctx.aiMemory && ctx.aiMemory.memories) ? ctx.aiMemory.memories : [];
  const skills = Array.isArray(ctx.aiMemory && ctx.aiMemory.skills) ? ctx.aiMemory.skills : [];
  const recent = Array.isArray(ctx.conversationSummary) ? ctx.conversationSummary : [];
  const vi = lang === 'vi' || /[àáạảãăằắặẳẵâầấậẩẫèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/.test(message || '');
  const L = vi ? 'vi' : 'en';

  // Hard product identity — never answer as Personal AI Hub / Snake / another app
  if (/(app này|app nay|đây là app|day la app|this app|what app|which app|app is this|bạn là ai|ban la ai|who are you|what are you|you are|giới thiệu app|gioi thieu app|solo.?host.?browser|personal\s*ai\s*hub)/i.test(q) ||
      /^(app này là|app nay la|đây là|day la|this is|what is this)\b/i.test(String(message || '').trim())) {
    return L === 'vi'
      ? 'Đây là SoloHost Browser (v' + (function(){try{return require('../package.json').version}catch(_){return '10.45.3'}}()) + ') — trình duyệt web nhẹ, riêng tư trên SoloHost (Pi Network). Không phải Personal AI Hub hay game. Bạn duyệt web qua Chromium/Playwright + DOM Bridge, có AI trợ lý (Chat/Feedback/Settings/Logs), Music Library, nhiệm vụ AI đa bước có bằng chứng, tab riêng tư, và tùy chọn màn hình Chromium (noVNC) khi bật. Hỏi về lỗi: xem tab Logs.'
      : 'This is SoloHost Browser (v' + (function(){try{return require('../package.json').version}catch(_){return '10.45.3'}}()) + ') — a lightweight private web browser on SoloHost (Pi Network). It is not Personal AI Hub or a game. You browse via Chromium/Playwright + DOM Bridge, with an AI assistant (Chat/Feedback/Settings/Logs), Music Library, evidence-based multi-step AI tasks, private tabs, and optional Chromium desktop (noVNC) when enabled. For errors, open the Logs tab.';
  }

  if (/(what do you remember|show.*memories|my saved memories|bạn nhớ gì|ban nho gi|xem bộ nhớ|xem bo nho|skill đã lưu|skill da luu)/i.test(q)) {
    const items = memories.map(x => typeof x === 'string' ? x : (x.content || '')).filter(Boolean);
    const skillItems = skills.map(x => (x.name ? x.name + ': ' : '') + (x.content || '')).filter(Boolean);
    const all = items.concat(skillItems).slice(0, 12);
    if (!all.length) return L === 'vi' ? 'Chưa có bộ nhớ hoặc skill nào được lưu. Hãy nói “Hãy nhớ rằng …” hoặc “Lưu skill: tên: hướng dẫn”.' : 'No memories or skills are saved yet. Say “Remember that …” or “Save skill: name: instructions”.';
    return (L === 'vi' ? 'Bộ nhớ và skill đã lưu:\n' : 'Saved memories and skills:\n') + all.map((x, i) => (i + 1) + '. ' + x).join('\n');
  }
  if (/(continue|tiếp tục|tiep tuc|where were we|lúc nãy|luc nay|last request|yêu cầu trước|yeu cau truoc)/i.test(q) && recent.length) {
    const last = recent.slice(-6).map(x => (x.role === 'user' ? (L === 'vi' ? 'Bạn' : 'You') : 'AI') + ': ' + String(x.content || '').slice(0, 350)).join('\n');
    return (L === 'vi' ? 'Ngữ cảnh gần đây đã lưu:\n' : 'Recent saved context:\n') + last;
  }

  if (/youtube|google|fontconfig|dconf|không hiển thị|không vào|blank|trắng/.test(q)) {
    if (L === 'vi') {
      return 'SoloHost Browser chạy trang thật bằng Playwright và hiển thị bản DOM Bridge đã làm sạch; snapshot có thể bỏ iframe/media nên không giống Chrome đầy đủ. YouTube watch/Shorts/live được chuyển sang trang phát bằng trình nhúng chính thức; kiểm tra log youtube.video_handoff và proxy.youtube_player. Nếu video không cho nhúng, bị giới hạn tuổi/khu vực, cần đăng nhập hoặc gặp challenge thì dùng Open ↗. App không giả mạo dấu vân tay hay vượt CAPTCHA.';
    }
    return 'SoloHost Browser runs sites in Playwright and displays a sanitized DOM Bridge snapshot; the snapshot may omit iframe/media and differ from full Chrome. YouTube watch/Shorts/live clicks are routed to the official embed player shell; check youtube.video_handoff and proxy.youtube_player. If embedding is disabled, age/region/login restrictions or a challenge applies, use Open ↗. The app does not spoof fingerprints or bypass CAPTCHA.';
  }
  if (/playlist|danh sách phát|music library|nhạc|nhiệm vụ|ai tasks|task|script|tập lệnh|solohost app|localhost/.test(q)) {
    return L === 'vi'
      ? 'Trang chủ: Thư viện nhạc phát tệp audio HTTP(S) trực tiếp trên trình duyệt người dùng và nhúng video YouTube/Vimeo/TikTok được hỗ trợ, có phát/tạm dừng, trước/sau, trộn bài và lặp bài; không truyền âm thanh bất kỳ từ Chromium backend sang UI; một ô chat tự phân luồng thao tác trang; bộ nhớ dài hạn và skill có thể lưu; Nhiệm vụ AI được tạo bằng cách yêu cầu trợ lý, không có biểu mẫu thêm thủ công. Lịch chạy cần trình duyệt đang mở và dùng múi giờ theo IP nếu dịch vụ khả dụng. App SoloHost local vẫn được hỗ trợ.'
      : 'Home: Music Library plays direct HTTP(S) audio files in the user browser and embeds supported YouTube/Vimeo/TikTok videos with play/pause, previous/next, shuffle and repeat modes. It does not stream arbitrary audio captured from backend Chromium. One AI chat automatically routes page-operation requests to the Browser Agent; persistent memory and reusable skills can be saved; ask the assistant to create AI Tasks; there is no manual task form. Scheduled tasks run while the browser UI is open and use IP-derived time zone when available. SoloHost local apps remain supported.';
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
