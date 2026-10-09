'use strict';

/**
 * SoloHost Browser adapter for Universal AI module.
 * Knowledge must stay accurate so Assist guides users correctly.
 */

const knowledge = `
APP NAME: SoloHost Browser
PRODUCT: Lightweight private web browser running inside Pi Network SoloHost.
PRINCIPLES: Simple, Private, Lightweight, Secure, International (EN + VI), optional AI.

ARCHITECTURE:
- Web engine: native WebKitGTK (solohost-webkit-engine), NOT Chromium, NOT iframe-proxy.
- Display transport: Xvfb → x11vnc → websockify → noVNC (pixel stream into the SoloHost web UI).
- Node.js shell: tabs UI, bookmarks, history, downloads, security policy, SoloHost app catalog.
- AI Assist is optional and does not power page rendering.

HOW TO BROWSE:
1. Open SoloHost Browser from SoloHost.
2. Type a URL or search words in the address bar and press Enter.
3. Use Back / Forward / Reload in the chrome bar.
4. Tabs: open multiple sites; close with ×.
5. Home shows floating SoloHost apps (constellation), not a card grid.

FEATURES:
- HTTP/HTTPS navigation, WebSocket/WebRTC page APIs subject to security policy.
- HTML5 media (GStreamer stack). Remote audio over noVNC is limited.
- Downloads stored under the browser profile downloads folder.
- Security page /security for permission and privacy preferences.
- AI panel (bottom-right robot): Chat, Feedback, Settings, Logs.
- Feedback Hub is preconfigured server-side; users do not enter Hub ID or ingest token.

AI SETTINGS:
- Open robot button → Settings → choose provider (OpenAI, Gemini, DeepSeek, Anthropic, OpenRouter, Groq, Mistral, xAI, Custom, Local) and save API key.
- Without a key, Chat still answers from the offline local guide (localReply).

TROUBLESHOOTING:
- Black view after open: wait for engine start; check Logs tab; ensure container has network; try Reload.
- Page unavailable: DNS/HTTPS inside container; open /api/network/status if available.
- AI offline: Browser still works. Configure provider in Settings.

SECURITY:
- No docker.sock. No host Docker control from the browser.
- Ingest token and API keys stay on the server; never asked in Feedback form.
`;

module.exports = {
  knowledge,
  actions: [
    { name: 'open_url', description: 'Open or navigate to a website URL in SoloHost Browser', requiresConfirmation: false },
    { name: 'go_home', description: 'Return to the SoloHost Browser home constellation', requiresConfirmation: false },
    { name: 'reload_page', description: 'Reload the active tab', requiresConfirmation: false },
    { name: 'open_security', description: 'Open the security settings page', requiresConfirmation: false }
  ],
  async getContext(ctx = {}) {
    let page = {};
    try {
      const gateway = require('../browser-gateway');
      page = gateway.pageSnapshot ? gateway.pageSnapshot() : {};
    } catch { /* engine optional */ }
    return {
      screen: ctx.screen || (page.url ? 'browser' : 'home'),
      url: page.url || ctx.url || '',
      title: page.title || ctx.title || '',
      active: page.active || '',
      tabCount: Array.isArray(page.tabs) ? page.tabs.length : undefined,
      engine: 'webkit',
      aiOptional: true
    };
  },
  async executeAction({ name, args = {} }) {
    const allowed = new Set(['open_url', 'go_home', 'reload_page', 'open_security']);
    if (!allowed.has(name)) return { ok: false, error: 'Action not allowed' };
    try {
      const gateway = require('../browser-gateway');
      if (name === 'open_url') {
        const url = String(args.url || args.value || '').trim();
        if (!url) return { ok: false, error: 'url required' };
        await gateway.navigate(url);
        return { ok: true, action: name, url };
      }
      if (name === 'reload_page') {
        await gateway.handle({ type: 'reload' });
        return { ok: true, action: name };
      }
      if (name === 'go_home') return { ok: true, action: name, value: 'home' };
      if (name === 'open_security') return { ok: true, action: name, value: '/security' };
    } catch (e) {
      return { ok: false, action: name, error: String(e.message || e) };
    }
    return { ok: false, error: 'unhandled' };
  },
  async localReply(message, live) {
    const q = String(message || '').toLowerCase();
    const vi = /[àáạảãăâèéêìíòóôơùúưỳýđ]/.test(message || '');
    if (/url|http|mở|open|truy cập|navigate/.test(q)) {
      return vi
        ? 'Gõ địa chỉ hoặc từ khóa vào thanh địa chỉ rồi Enter. AI không bắt buộc để duyệt web.'
        : 'Type a URL or search words in the address bar and press Enter. AI is optional for browsing.';
    }
    if (/ai|key|provider|cài|settings/.test(q)) {
      return vi
        ? 'Mở nút robot góc phải → Settings → chọn Provider và dán API key. Không có key vẫn hỏi được hướng dẫn offline.'
        : 'Open the robot button → Settings → pick a Provider and paste an API key. Offline guide works without a key.';
    }
    if (/đen|black|tối|blank|không vào|fail/.test(q)) {
      return vi
        ? 'Nếu khung duyệt tối: đợi engine WebKit sẵn sàng, bấm Reload, xem tab Logs. Trình duyệt không cần AI để mở trang.'
        : 'If the view is black: wait for WebKit, press Reload, check Logs. Browsing does not require AI.';
    }
    if (live && live.url) {
      return vi
        ? `Trang đang mở: ${live.title || live.url}. Bạn có thể hỏi tóm tắt, dịch, hoặc cách dùng SoloHost Browser.`
        : `Open page: ${live.title || live.url}. Ask to summarize, translate, or how to use SoloHost Browser.`;
    }
    return vi
      ? 'SoloHost Browser: duyệt web riêng tư trên SoloHost (WebKit). Hỏi cách mở trang, tab, tải xuống, bảo mật hoặc AI Settings.'
      : 'SoloHost Browser: private web browsing on SoloHost (WebKit). Ask about tabs, downloads, security, or AI Settings.';
  }
};
