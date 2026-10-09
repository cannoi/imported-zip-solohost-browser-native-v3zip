(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    form: $('url-form'),
    input: $('url-input'),
    go: $('btn-go'),
    reload: $('btn-reload'),
    fontDown: $('btn-font-down'),
    fontUp: $('btn-font-up'),
    theme: $('btn-theme'),
    statusLine: $('status-line'),
    statusText: $('status-text'),
    home: $('home-panel'),
    reader: $('reader'),
    metaSite: $('meta-site'),
    metaTitle: $('meta-title'),
    metaByline: $('meta-byline'),
    metaTime: $('meta-time'),
    mediaBox: $('media-player-container'),
    mediaVideo: $('media-video'),
    mediaCaption: $('media-caption'),
    view: $('reader-view'),
    errorPanel: $('error-panel'),
    errorTitle: $('error-title'),
    errorDesc: $('error-desc'),
    errorRetry: $('error-retry'),
    greeting: $('greeting'),
    lede: $('lede'),
    quick: $('quick-links')
  };

  const state = {
    url: '',
    fontScale: Number(localStorage.getItem('shb-font') || 1),
    theme: localStorage.getItem('shb-theme') || 'dark',
    loading: false,
    lastPayload: null,
    hls: null
  };

  const i18n = {
    en: {
      placeholder: 'Search or enter website',
      go: 'Go',
      greeting: 'Read the web, calmly',
      lede: 'Enter a link for a clean article view. Private · Lightweight · Optional AI.',
      loading: 'Extracting page…',
      error: 'Could not open page',
      retry: 'Retry',
      min: 'min read'
    },
    vi: {
      placeholder: 'Tìm kiếm hoặc nhập địa chỉ',
      go: 'Đi',
      greeting: 'Đọc web thật nhẹ nhàng',
      lede: 'Nhập liên kết để xem bài sạch. Riêng tư · Nhẹ · AI tùy chọn.',
      loading: 'Đang trích trang…',
      error: 'Không mở được trang',
      retry: 'Thử lại',
      min: 'phút đọc'
    }
  };

  const lang = (navigator.language || 'en').toLowerCase().startsWith('vi') ? 'vi' : 'en';
  const T = i18n[lang];

  function applyI18n() {
    if (els.input) els.input.placeholder = T.placeholder;
    if (els.go) els.go.textContent = T.go;
    if (els.greeting) els.greeting.textContent = T.greeting;
    if (els.lede) els.lede.textContent = T.lede;
    if (els.errorTitle) els.errorTitle.textContent = T.error;
    if (els.errorRetry) els.errorRetry.textContent = T.retry;
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.theme);
    localStorage.setItem('shb-theme', state.theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = state.theme === 'light' ? '#f6f4ef' : '#0c0d10';
  }

  function applyFont() {
    document.documentElement.style.setProperty('--reader-scale', String(state.fontScale));
    localStorage.setItem('shb-font', String(state.fontScale));
  }

  function setStatus(text, show) {
    if (!els.statusLine) return;
    els.statusLine.hidden = !show;
    if (els.statusText) els.statusText.textContent = text || '';
  }

  function showHome() {
    if (els.home) els.home.hidden = false;
    if (els.reader) els.reader.hidden = true;
    if (els.errorPanel) els.errorPanel.hidden = true;
  }

  function showReader() {
    if (els.home) els.home.hidden = true;
    if (els.reader) els.reader.hidden = false;
    if (els.errorPanel) els.errorPanel.hidden = true;
  }

  function showError(message) {
    if (els.home) els.home.hidden = true;
    if (els.reader) els.reader.hidden = true;
    if (els.errorPanel) els.errorPanel.hidden = false;
    if (els.errorDesc) els.errorDesc.textContent = message || T.error;
  }

  function normalizeUrl(raw) {
    let u = String(raw || '').trim();
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(u) || /^localhost(:\d+)?/i.test(u)) return 'https://' + u;
    return 'https://www.google.com/search?q=' + encodeURIComponent(u);
  }

  function destroyMedia() {
    if (state.hls) {
      try { state.hls.destroy(); } catch (_) {}
      state.hls = null;
    }
    if (els.mediaVideo) {
      try {
        els.mediaVideo.pause();
        els.mediaVideo.removeAttribute('src');
        els.mediaVideo.load();
      } catch (_) {}
    }
    if (els.mediaBox) els.mediaBox.hidden = true;
    if (els.mediaCaption) els.mediaCaption.textContent = '';
  }

  function loadHls(src) {
    return new Promise((resolve, reject) => {
      if (window.Hls) return resolve(window.Hls);
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.7/dist/hls.min.js';
      s.async = true;
      s.onload = () => resolve(window.Hls);
      s.onerror = () => reject(new Error('hls.js failed to load'));
      document.head.appendChild(s);
    });
  }

  async function setupMedia(videos) {
    destroyMedia();
    if (!videos || !videos.length || !els.mediaVideo || !els.mediaBox) return;
    const preferred = videos.find(v => v.type === 'hls') || videos.find(v => v.type === 'mp4') || videos[0];
    if (!preferred || !preferred.src) return;
    els.mediaBox.hidden = false;
    if (els.mediaCaption) {
      els.mediaCaption.textContent = preferred.type === 'hls' ? 'HLS stream' : 'Video';
    }
    if (preferred.type === 'hls') {
      try {
        const Hls = await loadHls(preferred.src);
        if (Hls && Hls.isSupported()) {
          state.hls = new Hls({ enableWorker: true });
          state.hls.loadSource(preferred.src);
          state.hls.attachMedia(els.mediaVideo);
          return;
        }
        if (els.mediaVideo.canPlayType('application/vnd.apple.mpegurl')) {
          els.mediaVideo.src = preferred.src;
          return;
        }
      } catch (_) {
        /* fall through to direct src */
      }
    }
    els.mediaVideo.src = preferred.src;
  }

  function renderArticle(data) {
    const meta = data.metadata || {};
    const content = data.content || {};
    if (els.metaSite) els.metaSite.textContent = meta.siteName || (data.url ? new URL(data.url).hostname : '');
    if (els.metaTitle) els.metaTitle.textContent = meta.title || data.url || '';
    if (els.metaByline) els.metaByline.textContent = meta.byline || '';
    if (els.metaTime) {
      const mins = content.reading_time_minutes || 0;
      els.metaTime.textContent = mins ? ` · ${mins} ${T.min}` : '';
    }
    if (els.view) {
      els.view.innerHTML = content.clean_html || `<p>${content.raw_text || ''}</p>`;
    }
    document.title = (meta.title ? meta.title + ' · ' : '') + 'SoloHost';
    setupMedia((data.media && data.media.videos) || []);
    showReader();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function openUrl(raw) {
    const url = normalizeUrl(raw);
    if (!url || state.loading) return;
    state.url = url;
    if (els.input) els.input.value = url;
    state.loading = true;
    if (els.go) els.go.disabled = true;
    setStatus(T.loading, true);
    if (els.errorPanel) els.errorPanel.hidden = true;
    try {
      const res = await fetch('/api/browser/parse?url=' + encodeURIComponent(url), {
        headers: { 'Accept': 'application/json', 'Accept-Language': navigator.language || 'en' }
      });
      let data = null;
      try { data = await res.json(); } catch (_) { data = null; }
      if (!data || data.success === false) {
        showError((data && data.error) || ('HTTP ' + res.status));
        return;
      }
      state.lastPayload = data;
      window.__soloArticle = {
        url: data.url || url,
        title: (data.metadata && data.metadata.title) || '',
        raw_text: (data.content && data.content.raw_text) || '',
        clean_html: (data.content && data.content.clean_html) || ''
      };
      renderArticle(data);
      try {
        fetch('/api/history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: data.url || url, title: (data.metadata && data.metadata.title) || url })
        }).catch(() => {});
      } catch (_) {}
    } catch (err) {
      showError(String(err.message || err));
    } finally {
      state.loading = false;
      if (els.go) els.go.disabled = false;
      setStatus('', false);
    }
  }

  // Expose for AI panel actions
  window.openUrl = openUrl;

  function onSubmit(e) {
    e.preventDefault();
    openUrl(els.input && els.input.value);
  }

  if (els.form) els.form.addEventListener('submit', onSubmit);
  if (els.reload) els.reload.addEventListener('click', () => openUrl(state.url || (els.input && els.input.value)));
  if (els.fontDown) els.fontDown.addEventListener('click', () => {
    state.fontScale = Math.max(0.85, Math.round((state.fontScale - 0.05) * 100) / 100);
    applyFont();
  });
  if (els.fontUp) els.fontUp.addEventListener('click', () => {
    state.fontScale = Math.min(1.45, Math.round((state.fontScale + 0.05) * 100) / 100);
    applyFont();
  });
  if (els.theme) els.theme.addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
  });
  if (els.errorRetry) els.errorRetry.addEventListener('click', () => openUrl(state.url || (els.input && els.input.value)));
  if (els.quick) {
    els.quick.querySelectorAll('[data-url]').forEach((btn) => {
      btn.addEventListener('click', () => openUrl(btn.getAttribute('data-url')));
    });
  }

  applyI18n();
  applyTheme();
  applyFont();
  showHome();

  // Deep link ?url=
  try {
    const q = new URLSearchParams(location.search).get('url');
    if (q) openUrl(q);
  } catch (_) {}
})();
