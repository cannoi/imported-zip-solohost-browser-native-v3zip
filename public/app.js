(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const frame = $('main-webview');
  const input = $('url-input');
  const startScreen = $('start-screen');
  const btnLang = $('btn-lang');
  const btnOpen = $('btn-open-tab');
  const btnTheme = $('btn-theme');
  const root = document.documentElement;

  const THEMES = ['rainbow', 'dark', 'light'];

  const state = {
    lang: localStorage.getItem('solo_lang') || ((navigator.language || '').toLowerCase().startsWith('vi') ? 'vi' : 'en'),
    theme: localStorage.getItem('solo_theme') || 'rainbow',
    readerOn: false,
    url: '',
    history: [],
    tabs: [],
    activeTabId: null,
    libraryMode: 'bookmarks'
  };

  function applyTheme() {
    if (!THEMES.includes(state.theme)) state.theme = 'rainbow';
    root.setAttribute('data-theme', state.theme);
    localStorage.setItem('solo_theme', state.theme);
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

    // YouTube (youtube.com, m.youtube.com, youtu.be, shorts)
    let vid = null;
    if (host === 'youtu.be') {
      vid = path.split('/').filter(Boolean)[0] || null;
    } else if (host.endsWith('youtube.com') || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
      if (path.startsWith('/embed/')) return href; // already embed
      const mWatch = href.match(/[?&]v=([\w-]{6,})/);
      const mShort = path.match(/\/shorts\/([\w-]{6,})/);
      const mLive = path.match(/\/live\/([\w-]{6,})/);
      vid = (mWatch && mWatch[1]) || (mShort && mShort[1]) || (mLive && mLive[1]) || null;
      if (!vid && path.startsWith('/watch')) {
        vid = u.searchParams.get('v');
      }
    }
    if (vid) {
      return 'https://www.youtube.com/embed/' + encodeURIComponent(vid) + '?rel=0&modestbranding=1';
    }

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
    el.append(span, a, x);
    el.hidden = false;
    clientLog('error', 'proxy_hint', { url: state.url, detail: msg });
  }

  function hideProxyHint() {
    const el = document.getElementById('proxy-hint');
    if (el) el.hidden = true;
  }


  function showStart() {
    if (startScreen) startScreen.classList.remove('hidden');
  }

  function getActiveTab() { return state.tabs.find(t => t.id === state.activeTabId) || null; }
  function renderTabs() {
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
    if (state.url && frame) { frame.src = isDirectEmbed(state.url) ? state.url : proxyFrameUrl(state.url); hideStart(); }
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

  function navigate(raw) {
    let url = normalizeUrl(raw);
    if (!url || !frame) return;
    url = toPlayableUrl(url);
    state.url = url;
    const active = getActiveTab(); if (active) { active.url = url; try { active.title = new URL(url).hostname; } catch (_) {} renderTabs(); }
    saveVisit(url);
    state.readerOn = false;
    // Omnibox shows the real site URL; iframe loads via same-origin proxy (or direct embed)
    if (input) input.value = url;
    if (btnOpen) btnOpen.href = url;
    hideStart();
    hideProxyHint();
    clientLog('info', 'navigate', { url: url });
    const frameSrc = isDirectEmbed(url) ? url : proxyFrameUrl(url);
    try {
      frame.removeAttribute('srcdoc');
      frame.src = frameSrc;
    } catch (e) {
      try { frame.src = frameSrc; } catch (_) {}
    }
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
    try { frame.contentWindow.history.back(); } catch (_) { if (state.history.length) navigate(state.history.pop()); }
  });
  if ($('btn-fwd')) $('btn-fwd').addEventListener('click', () => {
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
