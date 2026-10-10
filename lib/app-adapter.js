'use strict';

/**
 * SoloHost Browser — AI knowledge + offline localReply + safe actions.
 */
const knowledge = `
APP NAME: SoloHost Browser
VERSION: 9.0.14
PLATFORM: Pi Network SoloHost (Docker web app). Not a Windows desktop browser.

PURPOSE:
Lightweight private browser for everyday users. International (English + Vietnamese).
Simple · Private · Lightweight · Secure · AI-assisted.

UI (v9.0.14 — Opera-like mobile chrome):
- Top bar: address/search omnibox, Go, Open ↗, More ⋯
- Bottom bar: Back ←, Forward →, Home ⌂, Tabs (count), Reload ↻
- Theme rainbow is default (also dark / light via More → Theme)
- Language EN/VI in More menu; AI answers in the user’s language

HOW BROWSING WORKS:
1. Type URL or search words in the omnibox → Go.
2. Public pages load in an iframe via GET /api/proxy?url=…
3. Only navigation links stay on the proxy; CSS/images/fonts load from the original CDN (avoids nested proxy).
4. YouTube watch?v= / youtu.be → embed player when possible.
5. Google home → HTML search shell (gbv=1). YouTube home → search helper (not the full For You feed).
6. Streaming sites (VieON, iQIYI, Motchill, Netflix…) show a clear message: video needs a full browser — use ↗ Open.
7. Button ↗ always opens the real URL in the system browser (best for login, banking, DRM video, full SPA).

AI PANEL (robot FAB bottom-right):
Chat | Feedback | Settings | Logs
Providers: OpenAI, Gemini, DeepSeek, Anthropic, OpenRouter, Groq, Mistral, xAI, Custom, Local.
No API key → offline localReply still helps with how-to questions.
Logs show proxy.request / proxy.ok / proxy.fail / proxy.shell / proxy.cache / proxy.unwrap.

PRIVACY:
No docker.sock. API keys only on server. Feedback token only on server.

HONEST LIMITS:
- HTML proxy, not a full Chrome engine.
- DRM / SPA video players will not play inside the frame — use ↗.
- CAPTCHA and some logins may fail in proxy mode.
- Google results are HTML-lite (readable, not the full Google app).

USER TIPS:
- News sites: enter domain → Go → tap links inside the article.
- YouTube video: paste full watch URL for embed, or ↗ for the app.
- Phim VieON/Motchill: use ↗ Open.
- If a page looks cut off: rotate phone or use ↗; mobile layout CSS is injected automatically.
- Theme stuck: More → Theme cycles rainbow → dark → light.
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
    if (/mất nội dung|thiếu nội dung|không hiển thị|trắng|blank|render|css|hình ảnh|ảnh không|proxy|iframe|từ chối|refused|không mở/.test(q)) {
      return vi
        ? 'Bản mới chuyển nhiều tài nguyên (CSS, ảnh, font, script và srcset) qua proxy, xử lý CSS url()/@import và kiểm tra lại từng redirect để giảm lỗi hiển thị. Một số SPA, đăng nhập, CAPTCHA, WebSocket hoặc nội dung DRM vẫn có thể không tương thích; hãy tải lại, thử trang khác hoặc bấm ↗ để mở bằng trình duyệt thật.'
        : 'The updated proxy routes common CSS, images, fonts, scripts and srcset resources through the proxy, rewrites CSS url()/@import, and revalidates redirects. Some SPAs, login flows, CAPTCHA, WebSockets or DRM may still be incompatible; reload, try another page, or use ↗ to open it in the full browser.';
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
