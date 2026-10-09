'use strict';

/**
 * SoloHost Browser — AI knowledge + offline localReply + safe actions.
 */
const knowledge = `
APP NAME: SoloHost Browser
VERSION: 9.0.7 (client WebView + tab manager + persistent history/bookmarks + same-origin HTML frame proxy + Universal AI)
PLATFORM: Pi Network SoloHost (Docker web app). Not a Windows desktop browser.

PURPOSE:
Lightweight private browser for everyday users. International (English + Vietnamese).
Simple · Private · Lightweight · Secure · AI-assisted.

BROWSER FEATURES (v9.0.7):
- Tab strip: ＋ creates a tab; tap a tab to switch; × closes it. A lightweight tab session is retained in sessionStorage for the current browser session.
- Bookmark: ☆ saves the current page to the persistent server-side browser library; ☷ opens Bookmarks and History. Bookmark removal and Clear history are supported.
- History and bookmarks are stored in the app data directory using JSON files by default; optional SQLite storage is used if sqlite3 is installed. History is bounded to 200 visits and the UI shows recent entries.
- Cookie note: this build uses a same-origin HTTP proxy, not a dedicated browser engine/profile. It cannot promise Chrome-equivalent per-site cookie isolation, cookie controls, extension support, or reliable login sessions. Login-heavy and sensitive sites should be opened with ↗ in the user's real browser.

HOW BROWSING WORKS:
1. User types a URL or search in the omnibox and presses Go.
2. Most sites load inside the iframe via same-origin proxy: GET /api/proxy?url=…
   Why: modern sites send X-Frame-Options / CSP frame-ancestors and block direct iframes.
3. YouTube watch/shorts URLs are converted to youtube.com/embed/{id} when possible.
4. Google homepage uses a lightweight search shell; search results use Google HTML mode (gbv=1).
5. YouTube home / TikTok For You are SPA apps — the proxy shows a helper shell; use ↗ Open for the full site.
6. Button ↗ opens the real URL in a new browser tab (best for login, banking, full SPA apps).

THEMES:
- Rainbow (default), Dark, Light — cycle with ◐ in the toolbar.
- Language EN/VI toggle with the language button (UI strings + AI should answer in the user's language).

AI ASSISTANT (this panel):
- Chat: ask how to use the browser, privacy, themes, proxy limits.
- Settings: choose provider (OpenAI, Gemini, DeepSeek, Anthropic, OpenRouter, Groq, Mistral, xAI, Custom, Local), API key, base URL, model.
- Without API key: offline localReply still answers common questions.
- Feedback: send improvement/bug/question to Feedback Hub; donate info comes from Hub sync only.
- Logs: server-side AI activity logs (no secrets).

PRIVACY:
- No docker.sock. No host Docker control.
- API keys stored only on server in data/ai-settings.json (masked in GET settings).
- Feedback ingest token stays on the server only — never sent to the browser.
- Frame proxy does not steal login cookies across sites.

LIMITATIONS TO TELL USERS HONESTLY:
- Full YouTube/TikTok feeds need ↗ Open (they are native SPA apps).
- Login walls (Gmail, Facebook app) work best in a full tab (↗).
- Proxy is for reading public pages, not a replacement for Chrome/Edge.

USER WORKFLOWS:
- Open news site → type thanhnien.vn → Go → read in frame.
- Search Google → type google.com → Go → type query in Google shell → results (HTML mode).
- Watch a specific YouTube video → paste full watch URL → embed player when available.
- Change theme → ◐. Change language → EN/VI button.
- Ask AI to explain a feature → open robot FAB → Chat.
`;

module.exports = {
  knowledge,
  actions: [
    { name: 'open_url', description: 'Navigate the browser to a URL', requiresConfirmation: false },
    { name: 'open_security', description: 'Open the security information page', requiresConfirmation: false },
    { name: 'toggle_theme', description: 'Cycle theme rainbow/dark/light', requiresConfirmation: false }
  ],
  async getContext() {
    let url = '';
    let theme = 'rainbow';
    let lang = 'en';
    try {
      if (typeof global !== 'undefined' && global.__soloBrowserState) {
        url = global.__soloBrowserState.url || '';
        theme = global.__soloBrowserState.theme || theme;
        lang = global.__soloBrowserState.lang || lang;
      }
    } catch { /* ignore */ }
    return {
      screen: url ? 'webview' : 'home',
      url: url || null,
      theme,
      lang,
      mode: 'webview-proxy'
    };
  },
  async executeAction({ name, args }) {
    const allowed = ['open_url', 'open_security', 'toggle_theme'];
    if (!allowed.includes(name)) return { ok: false, error: 'Action not allowed' };
    return { ok: true, action: name, args: args || {} };
  },
  async localReply(message, live) {
    const q = String(message || '').toLowerCase();
    const vi = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/.test(q)
      || /\b(là gì|làm sao|hướng dẫn|trình duyệt|tiếng việt)\b/.test(q);
    const url = (live && live.url) || '';

    if (/theme|giao diện|màu|dark|light|rainbow|sáng|tối/.test(q)) {
      return vi
        ? 'Bấm nút ◐ trên thanh công cụ để đổi theme: Cầu vồng (mặc định) → Tối → Sáng.'
        : 'Tap ◐ in the toolbar to cycle themes: Rainbow (default) → Dark → Light.';
    }
    if (/youtube|tiktok/.test(q)) {
      return vi
        ? 'YouTube/TikTok dạng ứng dụng (SPA). Dán link video cụ thể để xem embed, hoặc bấm ↗ để mở trang đầy đủ. Trang chủ For You không chạy trọn trong khung proxy.'
        : 'YouTube/TikTok are full apps (SPA). Paste a specific video link for embed, or tap ↗ for the full site. Home feeds cannot fully run inside the proxy frame.';
    }
    if (/google|tìm kiếm|search/.test(q)) {
      return vi
        ? 'Mở google.com → nhập từ khóa trong ô tìm kiếm. Kết quả dùng chế độ HTML (gbv=1) qua proxy để hiển thị trong khung.'
        : 'Open google.com → type your query. Results use Google HTML mode (gbv=1) through the proxy so they show in the frame.';
    }
    if (/proxy|iframe|từ chối|refused|không mở|blank/.test(q)) {
      return vi
        ? 'Nhiều website chặn iframe. SoloHost Browser tải trang qua /api/proxy (same-origin) để hiển thị. Nếu vẫn lỗi, bấm ↗ mở tab mới.'
        : 'Many sites block iframes. SoloHost Browser loads pages via /api/proxy (same-origin). If a page still fails, use ↗ to open a full tab.';
    }
    if (/ai|api key|provider|cài đặt|settings|local/.test(q)) {
      return vi
        ? 'Mở FAB robot → Settings: chọn provider (OpenAI, Gemini, Local…), nhập API key, Save. Không có key vẫn chat được bằng hướng dẫn offline.'
        : 'Open the robot FAB → Settings: pick a provider (OpenAI, Gemini, Local…), enter API key, Save. Without a key, offline guide answers still work.';
    }
    if (/feedback|góp ý|donate|ủng hộ/.test(q)) {
      return vi
        ? 'Tab Feedback: gửi góp ý/bug. Thông tin ủng hộ chỉ hiện sau khi đồng bộ Feedback Hub (không hard-code trong app).'
        : 'Feedback tab: send ideas or bugs. Donate details appear only after Feedback Hub sync (never hard-coded in the app).';
    }
    if (/privacy|bảo mật|riêng tư|cookie|token/.test(q)) {
      return vi
        ? 'API key lưu trên server (data/). Dấu trang và lịch sử được lưu trong dữ liệu ứng dụng. Bản này dùng proxy/iframe nên không bảo đảm cookie và đăng nhập tương đương Chrome; trang nhạy cảm nên mở bằng ↗.'
        : 'API keys stay on the server (data/). Bookmarks and history persist in app data. This proxy/iframe build cannot guarantee Chrome-equivalent cookies or login sessions; open sensitive sites with ↗.';
    }
    if (/bookmark|dấu trang|history|lịch sử|tab mới|new tab|cookie/.test(q)) {
      return vi
        ? '＋ tạo tab mới; chạm tên tab để chuyển và × để đóng. ☆ lưu dấu trang. ☷ mở Dấu trang/Lịch sử; lịch sử có thể xóa tại đây. Cookie/đăng nhập vẫn phụ thuộc giới hạn proxy/iframe; dùng ↗ cho website cần đăng nhập.'
        : '＋ creates a tab; tap a tab to switch and × to close. ☆ saves a bookmark. ☷ opens Bookmarks/History, where history can be cleared. Cookies and login still depend on proxy/iframe limits; use ↗ for sites requiring sign-in.';
    }
    if (url) {
      return vi
        ? `Bạn đang xem: ${url}. Hỏi tôi về cách dùng trình duyệt, theme, proxy, hoặc cấu hình AI.`
        : `Current page: ${url}. Ask me about browsing, themes, proxy, or AI setup.`;
    }
    return vi
      ? 'SoloHost Browser — nhập địa chỉ rồi Go. Dùng ↗ nếu trang cần đăng nhập. Mở FAB robot để chat AI / Feedback / Settings.'
      : 'SoloHost Browser — type an address and press Go. Use ↗ for login-heavy sites. Open the robot FAB for AI chat, Feedback, and Settings.';
  }
};
