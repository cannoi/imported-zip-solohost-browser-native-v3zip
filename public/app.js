(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const frame = $('main-webview');
  const input = $('url-input');
  const btnOpen = $('btn-open-tab');
  const btnLang = $('btn-lang');
  const btnTheme = $('btn-theme');
  const THEMES = ['rainbow', 'dark', 'light'];
  const state = {
    url: '',
    lang: (typeof localStorage !== 'undefined' && localStorage.getItem('solo_lang')) || 'en',
    theme: (typeof localStorage !== 'undefined' && localStorage.getItem('solo_theme')) || 'rainbow',
    tabs: [],
    activeTabId: null,
    history: [],
    readerOn: false,
    lastNavAt: 0,
    libraryMode: 'bookmarks'
  };


  /** Per-tab navigation mode + bridge session isolation */
  const MODE = { ENGINE: 'ENGINE', PROXY: 'PROXY', DIRECT: 'DIRECT', EXTERNAL: 'EXTERNAL' };

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
  }

  /**
   * Site class — based on known policy, not HTTP 200.
   * ENGINE: try WebKit/DOM bridge first
   * PROXY: same-origin HTML proxy
   * DIRECT: iframe src=URL (rare; only when embeddable)
   * EXTERNAL: system browser (Open ↗)
   */
  function classifyUrl(url) {
    const h = hostOf(url);
    if (!h) return MODE.PROXY;
    // Known frame/proxy hostile or app-only surfaces
    if (/(^|\.)(facebook|fb|instagram|whatsapp|messenger)\.com$/.test(h) || h.endsWith('.facebook.com')) {
      return MODE.EXTERNAL;
    }
    if (/(^|\.)(netflix|disneyplus|hulu|primevideo)\.com$/.test(h)) return MODE.EXTERNAL;
    // Embeddable media
    if (/youtube\.com|youtu\.be/.test(h) && /\/embed\//.test(url)) return MODE.DIRECT;
    // Google/YouTube SPA: PROXY shell immediately (skip WebKit wait — was causing multi-second delay + white screens)
    if (/youtube\.com|youtu\.be/.test(h)) return MODE.PROXY;
    if (/google\./.test(h)) return MODE.PROXY;
    // Default PROXY (fast). Bridge/WebKit only when user enables or engine proven ready.
    // Log evidence: ENGINE path caused 20–40s js_timeout/ipc_timeout before proxy.
    return MODE.PROXY;
  }

  function modeLabel(mode, lang) {
    const vi = {
      ENGINE: 'Engine/Bridge',
      PROXY: 'Proxy HTML',
      DIRECT: 'Direct iframe',
      EXTERNAL: 'Mở ngoài (↗)'
    };
    const en = {
      ENGINE: 'Engine/Bridge',
      PROXY: 'HTML proxy',
      DIRECT: 'Direct iframe',
      EXTERNAL: 'Open externally (↗)'
    };
    return (lang === 'vi' ? vi : en)[mode] || mode;
  }

  function ensureTabNav(tab) {
    if (!tab) return null;
    if (!tab.nav) tab.nav = { stack: [], index: -1, mode: null, reason: '', bridge: null };
    return tab.nav;
  }

  function pushNav(tab, url) {
    const nav = ensureTabNav(tab);
    if (!nav) return;
    // truncate forward history
    if (nav.index < nav.stack.length - 1) nav.stack = nav.stack.slice(0, nav.index + 1);
    if (nav.stack[nav.stack.length - 1] !== url) {
      nav.stack.push(url);
      if (nav.stack.length > 50) nav.stack.shift();
      else nav.index = nav.stack.length - 1;
    } else {
      nav.index = nav.stack.length - 1;
    }
  }

  async function tabBridgeSession(tab) {
    const nav = ensureTabNav(tab);
    if (nav.bridge && nav.bridge.sessionId && nav.bridge.token) return nav.bridge;
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), 2500) : null;
    try {
      const r = await fetch('/api/browser/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: ac ? ac.signal : undefined
      });
      const j = await r.json();
      if (j && j.ok && j.sessionId && j.token) {
        nav.bridge = { sessionId: j.sessionId, token: j.token, backend: j.backend };
        return nav.bridge;
      }
    } catch (_) {}
    finally { if (timer) clearTimeout(timer); }
    return null;
  }

  function bridgeHeaders(b) {
    return { 'Content-Type': 'application/json', 'X-Session-Token': (b && b.token) || '' };
  }

  function bridgeViewUrl(b) {
    if (!b || !b.sessionId || !b.token) return null;
    return '/api/browser/sessions/' + encodeURIComponent(b.sessionId) + '/view?token=' + encodeURIComponent(b.token);
  }

  async function loadViaBridge(tab, url) {
    // Hard client timeout — never block UI for WebKit IPC (logs showed 35s+ ipc_timeout)
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), 4000) : null;
    try {
      const b = await tabBridgeSession(tab);
      if (!b) return { ok: false, reason: 'bridge_session_failed' };
      const r = await fetch('/api/browser/sessions/' + encodeURIComponent(b.sessionId) + '/navigate', {
        method: 'POST',
        headers: bridgeHeaders(b),
        body: JSON.stringify({ url, token: b.token }),
        signal: ac ? ac.signal : undefined
      });
      const j = await r.json().catch(() => null);
      if (!j || !j.ok) return { ok: false, reason: (j && j.error) || 'bridge_navigate_failed', detail: j };
      if (!j.hasContent && j.error) return { ok: false, reason: j.error, detail: j };
      // If backend fell back to proxy inside server, treat as proxy success without bridge view
      if (j.backend === 'proxy' && j.hasContent === false) {
        return { ok: false, reason: 'bridge_empty', detail: j };
      }
      const view = bridgeViewUrl(b);
      if (!frame || !view) return { ok: false, reason: 'no_viewport' };
      try {
        frame.setAttribute('sandbox', 'allow-same-origin allow-forms allow-popups');
        frame.src = view + (view.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
      } catch (_) {
        return { ok: false, reason: 'frame_error' };
      }
      return {
        ok: true,
        mode: MODE.ENGINE,
        backend: j.backend || b.backend,
        url: j.url || url,
        title: j.title || ''
      };
    } catch (e) {
      const reason = (e && e.name === 'AbortError') ? 'bridge_client_timeout' : String((e && e.message) || e);
      return { ok: false, reason };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function loadViaProxy(url) {
    if (!frame) return { ok: false, reason: 'no_frame' };
    const frameSrc = proxyFrameUrl(url);
    try {
      frame.removeAttribute('sandbox');
      frame.removeAttribute('srcdoc');
      frame.src = frameSrc;
      return { ok: true, mode: MODE.PROXY, url };
    } catch (e) {
      return { ok: false, reason: String(e.message || e) };
    }
  }

  function loadViaDirect(url) {
    if (!frame) return { ok: false, reason: 'no_frame' };
    try {
      frame.removeAttribute('sandbox');
      frame.src = url;
      return { ok: true, mode: MODE.DIRECT, url };
    } catch (e) {
      return { ok: false, reason: String(e.message || e) };
    }
  }

  function loadViaExternal(url, reason) {
    if (btnOpen) btnOpen.href = url;
    showProxyHint(
      (state.lang === 'vi'
        ? 'Trang này cần mở ngoài. Lý do: '
        : 'This page needs an external browser. Reason: ') + (reason || 'policy') +
      (state.lang === 'vi' ? ' — bấm ↗ Open.' : ' — tap ↗ Open.')
    );
    // Do not auto-window.open unless user clicks ↗
    return { ok: true, mode: MODE.EXTERNAL, url, reason: reason || 'policy' };
  }

  async function bridgeEvent(ev) {
    const tab = getActiveTab();
    const nav = ensureTabNav(tab);
    const b = nav && nav.bridge;
    if (!b) return null;
    try {
      const r = await fetch('/api/browser/sessions/' + encodeURIComponent(b.sessionId) + '/events', {
        method: 'POST', headers: bridgeHeaders(b), body: JSON.stringify(Object.assign({ token: b.token }, ev))
      });
      const j = await r.json();
      if (j && j.ok && frame) {
        const view = bridgeViewUrl(b);
        if (view) frame.src = view + '&t=' + Date.now();
        if (j.url) applyUrlToUi(j.url, j.title);
      }
      return j;
    } catch (_) { return null; }
  }

  function applyUrlToUi(url, title) {
    state.url = url;
    if (input) input.value = url;
    if (btnOpen) btnOpen.href = url || '#';
    const active = getActiveTab();
    if (active) {
      active.url = url;
      if (title) active.title = title;
      else try { active.title = new URL(url).hostname; } catch (_) {}
      renderTabs();
    }
  }

  // Same-origin bridge document interactions
  if (frame) {
    frame.addEventListener('load', () => {
      try {
        const doc = frame.contentDocument;
        if (!doc) return;
        const tab = getActiveTab();
        const nav = ensureTabNav(tab);
        if (!nav || !nav.bridge) return;
        doc.addEventListener('click', (e) => {
          const el = e.target && e.target.closest && e.target.closest('[data-sh-id]');
          if (!el) return;
          const tag = (el.tagName || '').toLowerCase();
          if (tag === 'a' && (e.ctrlKey || e.metaKey || el.target === '_blank')) {
            e.preventDefault();
            const href = el.getAttribute('href');
            try {
              const abs = new URL(href, state.url || 'https://example.com').href;
              newTab(abs);
            } catch (_) {}
            return;
          }
          if (tag === 'a' || tag === 'button' || el.getAttribute('role') === 'button') {
            e.preventDefault();
            e.stopPropagation();
            bridgeEvent({ type: 'click', targetId: el.getAttribute('data-sh-id') });
          }
        }, true);
        doc.addEventListener('submit', (e) => {
          const form = e.target;
          if (!form || !form.getAttribute) return;
          const id = form.getAttribute('data-sh-id');
          if (!id) return;
          e.preventDefault();
          bridgeEvent({ type: 'submit', targetId: id });
        }, true);
      } catch (_) { /* proxy frame may be opaque */ }
    });
  }

  function applyTheme() {
    if (!THEMES.includes(state.theme)) state.theme = 'rainbow';
    try {
      document.documentElement.setAttribute('data-theme', state.theme);
      localStorage.setItem('solo_theme', state.theme);
    } catch (_) {}
  }

  function applyLang() {
    if (btnLang) btnLang.textContent = state.lang === 'vi' ? 'VI' : 'EN';
    localStorage.setItem('solo_lang', state.lang);
    if (input) {
      input.placeholder = state.lang === 'vi' ? 'Tìm kiếm hoặc nhập địa chỉ' : 'Search or enter address';
    }
    const title = $('library-title'); if (title) title.textContent = state.lang === 'vi' ? 'Thư viện' : 'Library';
    const libraryButtons = document.querySelectorAll('[data-library]');
    libraryButtons.forEach(b => { b.textContent = state.lang === 'vi' ? (b.dataset.library === 'bookmarks' ? '☆ Dấu trang' : '◷ Lịch sử') : (b.dataset.library === 'bookmarks' ? '☆ Bookmarks' : '◷ History'); });
    const clear = $('history-clear'); if (clear) clear.textContent = state.lang === 'vi' ? 'Xóa lịch sử' : 'Clear history';
  }


  /** Sites that block top-level iframe: map to official embed URL when possible. */
  function isDirectEmbed(url) {
    try {
      const u = new URL(url);
      const h = u.hostname.replace(/^www\./, '');
      const p = u.pathname || '';
      if ((h.endsWith('youtube.com') || h === 'youtube-nocookie.com') && p.startsWith('/embed/')) return true;
      if (h.endsWith('tiktok.com') && p.includes('/embed')) return true;
      if (h === 'player.vimeo.com') return true;
      return false;
    } catch { return false; }
  }

  function proxyFrameUrl(url) {
    // Same-origin proxy — required because almost all sites send X-Frame-Options
    return '/api/proxy?url=' + encodeURIComponent(url);
  }

  function toPlayableUrl(url) {
    let u;
    try { u = new URL(url); } catch { return url; }
    const host = (u.hostname || '').replace(/^www\./, '').toLowerCase();
    const path = u.pathname || '';
    const href = u.href;

    // YouTube watch/shorts/youtu.be: left to the server proxy, which renders a native player page.
    // (Direct /embed/ URLs typed by the user still load as DIRECT.)

    // TikTok
    const tt = path.match(/\/@[\w.-]+\/video\/(\d+)/);
    if ((host.endsWith('tiktok.com')) && tt) {
      return 'https://www.tiktok.com/embed/v2/' + tt[1];
    }

    // Vimeo
    const vm = path.match(/\/(\d{6,})/);
    if (host.endsWith('vimeo.com') && vm && !path.includes('/video/')) {
      return 'https://player.vimeo.com/video/' + vm[1];
    }

    return url;
  }


  function clientLog(level, msg, extra) {
    try {
      fetch('/api/logs/client', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: level || 'info', msg: msg || '', url: (extra && extra.url) || state.url || '', error: extra && extra.error, detail: extra && extra.detail })
      }).catch(function () {});
    } catch (_) {}
  }

  function normalizeUrl(raw) {
    let s = String(raw || '').trim();
    if (!s) return '';
    if (/^about:/i.test(s) || /^javascript:/i.test(s)) return '';
    if (/^https?:\/\//i.test(s)) return s;
    if (/^\/\//.test(s)) return 'https:' + s;
    // IP or localhost
    if (/^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/.*)?$/.test(s) || /^localhost(:\d+)?(\/.*)?$/i.test(s)) {
      return 'http://' + s;
    }
    if (/^[\w.-]+\.[a-z]{2,}([/:].*)?$/i.test(s)) return 'https://' + s;
    return 'https://www.google.com/search?q=' + encodeURIComponent(s);
  }

  function hideStart() {
    const startScreen = $('start-screen');
    if (startScreen) startScreen.classList.add('hidden');
  }

  function showProxyHint(msg) {
    let el = document.getElementById('proxy-hint');
    if (!el) {
      el = document.createElement('div');
      el.id = 'proxy-hint';
      el.className = 'proxy-hint';
      const vp = document.getElementById('viewport');
      if (vp) vp.appendChild(el);
    }
    el.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = msg;
    const a = document.createElement('a');
    a.href = state.url || '#';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = state.lang === 'vi' ? 'Mở tab ↗' : 'Open tab ↗';
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '×';
    x.addEventListener('click', () => { el.hidden = true; });
    const aiBtn = document.createElement('button');
    aiBtn.type = 'button';
    aiBtn.textContent = state.lang === 'vi' ? 'AI gợi ý' : 'Ask AI';
    aiBtn.style.marginLeft = '8px';
    aiBtn.addEventListener('click', async () => {
      aiBtn.disabled = true;
      aiBtn.textContent = '…';
      try {
        const tab = getActiveTab();
        const nav = ensureTabNav(tab);
        const r = await fetch('/api/browser/ai-compat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: state.url || '',
            mode: (nav && nav.mode) || '',
            reason: (nav && nav.reason) || msg,
            lang: state.lang,
            textSnippet: msg,
            structureHtml: ''
          })
        });
        const j = await r.json();
        const lines = [j.summary || ''].concat(j.suggestions || []).filter(Boolean);
        span.textContent = lines.join(' · ').slice(0, 400);
        if (j.recommendedMode === 'EXTERNAL' && btnOpen && state.url) btnOpen.href = state.url;
      } catch (_) {
        span.textContent = (state.lang === 'vi' ? 'AI không khả dụng — dùng ↗ hoặc Reload.' : 'AI unavailable — use ↗ or Reload.');
      }
      aiBtn.disabled = false;
      aiBtn.textContent = state.lang === 'vi' ? 'AI gợi ý' : 'Ask AI';
    });
    el.append(span, a, aiBtn, x);
    el.hidden = false;
    clientLog('error', 'proxy_hint', { url: state.url, detail: msg });
  }

  function hideProxyHint() {
    const el = document.getElementById('proxy-hint');
    if (el) el.hidden = true;
  }


  function showStart() {
    const startScreen = $('start-screen');
    if (startScreen) startScreen.classList.remove('hidden');
  }

  function getActiveTab() { return state.tabs.find(t => t.id === state.activeTabId) || null; }
  function updateTabCount() {
    const el = document.getElementById('tab-count');
    if (el) el.textContent = String(Math.max(1, (state.tabs && state.tabs.length) || 1));
  }
  function renderTabs() {
    updateTabCount();
    const strip = $('tab-strip'); if (!strip) return;
    strip.textContent = '';
    state.tabs.forEach(tab => {
      const item = document.createElement('div'); item.className = 'browser-tab' + (tab.id === state.activeTabId ? ' active' : '');
      const select = document.createElement('button'); select.type = 'button'; select.className = 'browser-tab-select';
      let hostLabel = ''; try { hostLabel = tab.url ? new URL(tab.url).hostname : ''; } catch (_) {}
      select.textContent = tab.title || hostLabel || (state.lang === 'vi' ? 'Tab mới' : 'New tab');
      select.title = tab.url || select.textContent; select.addEventListener('click', () => switchTab(tab.id));
      const close = document.createElement('button'); close.type = 'button'; close.className = 'browser-tab-close'; close.textContent = '×'; close.title = state.lang === 'vi' ? 'Đóng tab' : 'Close tab';
      close.addEventListener('click', e => { e.stopPropagation(); closeTab(tab.id); });
      item.append(select, close); strip.appendChild(item);
    });
    try { sessionStorage.setItem('solo_tabs_v1', JSON.stringify({ tabs: state.tabs, activeTabId: state.activeTabId })); } catch (_) {}
  }
  function newTab(url) {
    const tab = { id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: state.lang === 'vi' ? 'Tab mới' : 'New tab', url: '' };
    state.tabs.push(tab); state.activeTabId = tab.id; renderTabs();
    if (url) navigate(url); else { state.url = ''; if (input) input.value = ''; if (frame) frame.src = 'about:blank'; showStart(); }
  }
  function switchTab(id) {
    const tab = state.tabs.find(t => t.id === id); if (!tab) return;
    state.activeTabId = id; state.url = tab.url || ''; renderTabs();
    if (input) input.value = state.url; if (btnOpen) btnOpen.href = state.url || '#';
    // Re-navigate with this tab's own bridge session (isolation)
    if (state.url) navigate(state.url, { force: true, skipHistory: true });
    else { if (frame) frame.src = 'about:blank'; showStart(); }
  }
  function closeTab(id) {
    const index = state.tabs.findIndex(t => t.id === id); if (index < 0) return;
    const wasActive = state.activeTabId === id; state.tabs.splice(index, 1);
    if (!state.tabs.length) { newTab(); return; }
    if (wasActive) switchTab(state.tabs[Math.min(index, state.tabs.length - 1)].id); else renderTabs();
  }
  async function saveVisit(url) {
    if (!url || !/^https?:/i.test(url)) return;
    const tab = getActiveTab(); if (tab) { tab.url = url; try { tab.title = new URL(url).hostname; } catch (_) {} renderTabs(); }
    try { await fetch('/api/browser/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, title: (tab && tab.title) || url }) }); } catch (_) {}
  }
  async function addCurrentBookmark() {
    if (!state.url || !/^https?:/i.test(state.url)) return;
    try {
      const tab = getActiveTab(); const r = await fetch('/api/browser/bookmarks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: state.url, title: (tab && tab.title) || state.url }) });
      if (r.ok) { const b = $('btn-bookmark'); if (b) { b.textContent = '★'; setTimeout(() => { b.textContent = '☆'; }, 1000); } }
    } catch (_) {}
  }
  async function openLibrary(mode) {
    state.libraryMode = mode || state.libraryMode;
    const overlay = $('library-overlay'); if (overlay) overlay.hidden = false;
    document.querySelectorAll('[data-library]').forEach(b => b.classList.toggle('active', b.dataset.library === state.libraryMode));
    const list = $('library-list'); if (!list) return; list.textContent = state.lang === 'vi' ? 'Đang tải…' : 'Loading…';
    try {
      const res = await fetch('/api/browser/' + state.libraryMode); const data = await res.json(); list.textContent = '';
      if (!data.items || !data.items.length) { list.textContent = state.lang === 'vi' ? 'Chưa có mục nào.' : 'Nothing here yet.'; return; }
      data.items.forEach(item => {
        const row = document.createElement('div'); row.className = 'library-item';
        const go = document.createElement('button'); go.type = 'button'; go.className = 'library-open'; go.textContent = item.title || item.url; go.title = item.url; go.addEventListener('click', () => { const overlay = $('library-overlay'); if (overlay) overlay.hidden = true; navigate(item.url); });
        const sub = document.createElement('span'); sub.className = 'library-url'; sub.textContent = item.url;
        row.append(go, sub);
        if (state.libraryMode === 'bookmarks') { const del = document.createElement('button'); del.type = 'button'; del.className = 'library-delete'; del.textContent = '×'; del.title = state.lang === 'vi' ? 'Xóa dấu trang' : 'Remove bookmark'; del.addEventListener('click', async () => { await fetch('/api/browser/bookmarks/' + encodeURIComponent(item.id), { method: 'DELETE' }); openLibrary('bookmarks'); }); row.appendChild(del); }
        list.appendChild(row);
      });
    } catch (_) { list.textContent = state.lang === 'vi' ? 'Không tải được dữ liệu.' : 'Could not load library.'; }
  }

  async function navigate(raw, opts) {
    opts = opts || {};
    let url = normalizeUrl(raw);
    if (!url || !frame) return;
    // Do NOT rewrite Google queries to gbv=1 or DuckDuckGo here.
    url = toPlayableUrl(url);

    const now = Date.now();
    if (!opts.force && state.url === url && now - (state.lastNavAt || 0) < 1200) {
      clientLog('warn', 'navigate_deduped', { url: url });
      return;
    }
    state.lastNavAt = now;

    const tab = getActiveTab();
    const nav = ensureTabNav(tab);
    const preferred = opts.mode || classifyUrl(url);
    hideProxyHint();
    hideStart();
    applyUrlToUi(url);
    if (!opts.skipHistory) {
      pushNav(tab, url);
      saveVisit(url);
    }
    state.readerOn = false;
    clientLog('info', 'navigate', { url: url, mode: preferred });

    let result = { ok: false, reason: 'untried' };

    async function tryEngine() {
      try {
        return await loadViaBridge(tab, url);
      } catch (e) {
        return { ok: false, reason: String(e.message || e) };
      }
    }

    if (preferred === MODE.EXTERNAL) {
      result = loadViaExternal(url, 'site_policy_external');
    } else if (preferred === MODE.DIRECT) {
      result = loadViaDirect(url);
      if (!result.ok) result = loadViaProxy(url);
    } else if (preferred === MODE.ENGINE) {
      // Fast fail: if WebKit known down, skip bridge entirely
      result = await tryEngine();
      if (!result.ok) {
        const reason = result.reason || 'engine_failed';
        clientLog('warn', 'navigate_engine_fallback', { url, reason });
        result = loadViaProxy(url);
        if (result.ok) {
          result.mode = MODE.PROXY;
          result.reason = 'fallback_from_engine:' + reason;
        }
      }
    } else if (preferred === MODE.PROXY) {
      result = loadViaProxy(url);
    } else {
      result = loadViaProxy(url);
    }

    if (!result.ok && preferred !== MODE.EXTERNAL) {
      result = loadViaExternal(url, result.reason || 'all_modes_failed');
    }

    if (nav) {
      nav.mode = result.mode || preferred;
      nav.reason = result.reason || '';
    }
    if (result.url && result.url !== url) applyUrlToUi(result.url, result.title);
    else if (result.title) applyUrlToUi(url, result.title);

    clientLog('info', 'navigate_result', {
      url: state.url,
      mode: result.mode,
      reason: result.reason || '',
      ok: !!result.ok
    });
  }

  function navigateProxyFallback(raw) {
    // retained for any legacy callers
    navigate(raw, { mode: MODE.PROXY });
  }

  // Links inside proxied pages postMessage to navigate without leaving the shell
  window.addEventListener('message', (ev) => {
    try {
      const d = ev.data;
      if (d && d.type === 'solohost-navigate' && d.url) navigate(d.url);
    } catch (_) {}
  });

  function extractPage() {
    if (!window.SoloReader) return { ok: false, error: 'NO_INJECTOR' };
    const out = window.SoloReader.extractCurrentPageDOM(frame);
    if (!out.ok || !out.raw_text || out.raw_text.length < 20) {
      const doc = window.SoloReader.getFrameDocument(frame);
      if (!doc) return { ok: false, error: 'CROSS_ORIGIN' };
      return { ok: false, error: 'EMPTY' };
    }
    return out;
  }

  function appendAiNote(text) {
    const box = $('aiChat');
    if (!box) return;
    const div = document.createElement('div');
    div.className = 'ai-msg';
    div.style.whiteSpace = 'pre-wrap';
    div.textContent = String(text || '');
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  function openAiPanel() {
    const ov = $('aiOverlay');
    if (ov) ov.hidden = false;
  }

  async function aiProcess(action, extra) {
    const extracted = extractPage();
    if (!extracted.ok) {
      appendAiNote(state.lang === 'vi'
        ? 'Không đọc được nội dung khung (cross-origin). Mở ↗ rồi thử lại, hoặc dùng trang same-origin.'
        : 'Cannot read frame content (cross-origin). Use ↗ Open, or a same-origin page.');
      openAiPanel();
      return;
    }
    appendAiNote(state.lang === 'vi' ? 'Đang xử lý…' : 'Working…');
    openAiPanel();
    try {
      const res = await fetch('/api/ai/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          text: extracted.raw_text,
          raw_text: extracted.raw_text,
          lang: state.lang,
          targetLang: state.lang === 'vi' ? 'vi' : 'en',
          url: state.url,
          query: (extra && extra.query) || ''
        })
      });
      const data = await res.json();
      const reply = (data.result && (data.result.reply || data.result.text || data.result.message))
        || data.error || JSON.stringify(data);
      appendAiNote(reply);
    } catch (err) {
      appendAiNote(String(err.message || err));
    }
  }

  // Keep omnibox in sync when iframe navigates (same-origin only)
  if (frame) {
    frame.addEventListener('load', () => {
      hideProxyHint();
      try {
        const doc = frame.contentDocument;
        if (doc && doc.body) {
          const text = (doc.body.innerText || '').slice(0, 200).toLowerCase();
          if (text.includes('page unavailable') || text.includes('host not allowed') || text.includes('private address')) {
            showProxyHint(state.lang === 'vi'
              ? 'Không tải được trang qua proxy.'
              : 'Page could not load through the proxy.');
          }
        }
      } catch (_) { /* cross-origin direct embed */ }
      try {
        const href = frame.contentWindow && frame.contentWindow.location && frame.contentWindow.location.href;
        if (href && href !== 'about:blank' && !href.startsWith('about:')) {
          let realHref = href;
          try {
            const current = new URL(href);
            if (current.pathname === '/api/proxy') realHref = current.searchParams.get('url') || href;
          } catch (_) {}
          state.url = realHref;
          const active = getActiveTab(); if (active) { active.url = realHref; try { active.title = new URL(realHref).hostname; } catch (_) {} renderTabs(); }
          if (input) input.value = realHref;
          if (btnOpen) btnOpen.href = realHref;
          hideStart();
          saveVisit(realHref);
        }
      } catch (_) {
        // cross-origin — still hide start; page may be visible in frame
        if (state.url) hideStart();
      }
    });
  }

  if ($('btn-new-tab')) $('btn-new-tab').addEventListener('click', () => newTab());
  if ($('btn-bookmark')) $('btn-bookmark').addEventListener('click', addCurrentBookmark);
  if ($('btn-library')) $('btn-library').addEventListener('click', () => openLibrary('bookmarks'));
  if ($('library-close')) $('library-close').addEventListener('click', () => { $('library-overlay').hidden = true; });
  document.querySelectorAll('[data-library]').forEach(b => b.addEventListener('click', () => openLibrary(b.dataset.library)));
  if ($('history-clear')) $('history-clear').addEventListener('click', async () => {
    if (state.libraryMode !== 'history') return;
    try { await fetch('/api/browser/history', { method: 'DELETE' }); openLibrary('history'); } catch (_) {}
  });
  if ($('library-overlay')) $('library-overlay').addEventListener('click', e => { if (e.target === $('library-overlay')) $('library-overlay').hidden = true; });

  const form = $('nav-form');
  if (form) form.addEventListener('submit', (e) => {
    e.preventDefault();
    navigate(input && input.value);
  });
  if ($('btn-back')) $('btn-back').addEventListener('click', () => {
    const tab = getActiveTab();
    const nav = ensureTabNav(tab);
    if (nav && nav.index > 0) {
      nav.index -= 1;
      navigate(nav.stack[nav.index], { skipHistory: true, force: true });
      return;
    }
    try { frame.contentWindow.history.back(); } catch (_) {}
  });
  if ($('btn-fwd')) $('btn-fwd').addEventListener('click', () => {
    const tab = getActiveTab();
    const nav = ensureTabNav(tab);
    if (nav && nav.index >= 0 && nav.index < nav.stack.length - 1) {
      nav.index += 1;
      navigate(nav.stack[nav.index], { skipHistory: true, force: true });
      return;
    }
    try { frame.contentWindow.history.forward(); } catch (_) {}
  });
  if ($('btn-reload')) $('btn-reload').addEventListener('click', () => {
    if (!state.url) return;
    try { frame.contentWindow.location.reload(); }
    catch (_) { frame.src = state.url; }
  });
  if ($('btn-reader')) $('btn-reader').addEventListener('click', () => {
    state.readerOn = !state.readerOn;
    const r = window.SoloReader && window.SoloReader.toggleReaderView(frame, state.readerOn);
    if (r && !r.ok) state.readerOn = false;
  });
  if ($('btn-summary')) $('btn-summary').addEventListener('click', () => aiProcess('summarize'));
  if ($('btn-translate')) $('btn-translate').addEventListener('click', () => aiProcess('translate'));
  if (btnLang) btnLang.addEventListener('click', () => {
    state.lang = state.lang === 'vi' ? 'en' : 'vi';
    applyLang();
  });
  if (btnTheme) btnTheme.addEventListener('click', () => {
    const i = THEMES.indexOf(state.theme);
    state.theme = THEMES[(i + 1) % THEMES.length];
    applyTheme();
  });

  // Home
  if ($('btn-home')) $('btn-home').addEventListener('click', () => {
    state.url = '';
    if (input) input.value = '';
    if (frame) frame.src = 'about:blank';
    if (btnOpen) btnOpen.href = '#';
    showStart();
    const active = getActiveTab();
    if (active) { active.url = ''; active.title = 'New Tab'; renderTabs(); }
  });

  // Settings menu (☰)
  function closeSettings() {
    const m = $('settings-menu'); const b = $('settings-backdrop');
    if (m) m.hidden = true; if (b) b.hidden = true;
    const btn = $('btn-menu'); if (btn) btn.setAttribute('aria-expanded', 'false');
  }
  function openSettings() {
    const m = $('settings-menu'); const b = $('settings-backdrop');
    if (m) m.hidden = false; if (b) b.hidden = false;
    const btn = $('btn-menu'); if (btn) btn.setAttribute('aria-expanded', 'true');
  }
  if ($('btn-menu')) $('btn-menu').addEventListener('click', () => {
    const m = $('settings-menu');
    if (m && m.hidden) openSettings(); else closeSettings();
  });
  if ($('settings-backdrop')) $('settings-backdrop').addEventListener('click', closeSettings);
  ['btn-theme','btn-library','btn-reader','btn-summary','btn-translate','btn-lang'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('click', () => setTimeout(closeSettings, 0));
  });

  applyTheme();
  applyLang();
  try {
    const saved = JSON.parse(sessionStorage.getItem('solo_tabs_v1') || 'null');
    if (saved && Array.isArray(saved.tabs) && saved.tabs.length) { state.tabs = saved.tabs.slice(0, 12); state.activeTabId = saved.activeTabId; if (!getActiveTab()) state.activeTabId = state.tabs[0].id; }
  } catch (_) {}
  if (!state.tabs.length) { state.tabs = [{ id: 't' + Date.now().toString(36), title: state.lang === 'vi' ? 'Tab mới' : 'New tab', url: '' }]; state.activeTabId = state.tabs[0].id; }
  renderTabs();
  showStart();

  try {
    const q = new URLSearchParams(location.search).get('url');
    if (q) navigate(q);
    else { const active = getActiveTab(); if (active && active.url) navigate(active.url); }
  } catch (_) {}

  window.SoloBrowser = { navigate, extractPage, aiProcess, state, newTab, openLibrary };
})();
