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
    history: []
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
  }


  /** Sites that block top-level iframe: map to official embed URL when possible. */
  function isDirectEmbed(url) {
    try {
      const h = new URL(url).hostname.replace(/^www\./, '');
      return /youtube\.com$|youtube-nocookie\.com$|youtu\.be$|tiktok\.com$|player\.vimeo\.com$/.test(h)
        && /\/embed|\/embed\//.test(url + '/');
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

  function showStart() {
    if (startScreen) startScreen.classList.remove('hidden');
  }

  function navigate(raw) {
    let url = normalizeUrl(raw);
    if (!url || !frame) return;
    url = toPlayableUrl(url);
    state.url = url;
    state.readerOn = false;
    // Omnibox shows the real site URL; iframe loads via same-origin proxy (or direct embed)
    if (input) input.value = url;
    if (btnOpen) btnOpen.href = url;
    hideStart();
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
      try {
        const href = frame.contentWindow && frame.contentWindow.location && frame.contentWindow.location.href;
        if (href && href !== 'about:blank' && !href.startsWith('about:')) {
          state.url = href;
          if (input) input.value = href;
          if (btnOpen) btnOpen.href = href;
          hideStart();
        }
      } catch (_) {
        // cross-origin — still hide start; page may be visible in frame
        if (state.url) hideStart();
      }
    });
  }

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
  showStart();

  try {
    const q = new URLSearchParams(location.search).get('url');
    if (q) navigate(q);
  } catch (_) {}

  window.SoloBrowser = { navigate, extractPage, aiProcess, state };
})();
