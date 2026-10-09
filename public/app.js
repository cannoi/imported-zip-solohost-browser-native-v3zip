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
    hls: null,
    abort: null
  };

  const i18n = {
    en: {
      placeholder: 'Search or enter website',
      go: 'Go',
      greeting: 'Read the web, calmly',
      lede: 'Enter a link for a clean article view. Private · Lightweight · Optional AI.',
      loading: 'Opening page…',
      error: 'Could not open page',
      retry: 'Retry',
      min: 'min read',
      empty: 'Page opened but no readable article was found. Try another URL.'
    },
    vi: {
      placeholder: 'Tìm kiếm hoặc nhập địa chỉ',
      go: 'Đi',
      greeting: 'Đọc web thật nhẹ nhàng',
      lede: 'Nhập liên kết để xem bài sạch. Riêng tư · Nhẹ · AI tùy chọn.',
      loading: 'Đang mở trang…',
      error: 'Không mở được trang',
      retry: 'Thử lại',
      min: 'phút đọc',
      empty: 'Đã mở trang nhưng không tìm thấy bài đọc được. Thử địa chỉ khác.'
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
    // Keep workspace (not "silent home"): show explicit error panel.
    if (els.home) els.home.hidden = true;
    if (els.reader) els.reader.hidden = true;
    if (els.errorPanel) els.errorPanel.hidden = false;
    if (els.errorDesc) els.errorDesc.textContent = message || T.error;
  }

  function normalizeUrl(raw) {
    let u = String(raw || '').trim();
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(u) || /^localhost(:\d+)?(\/.*)?$/i.test(u)) return 'https://' + u;
    return 'https://www.google.com/search?q=' + encodeURIComponent(u);
  }

  /** API base: same origin as the UI (SoloHost proxies the container). */
  function apiUrl(path) {
    return path;
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

  function loadHls() {
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
    if (els.mediaCaption) els.mediaCaption.textContent = preferred.type === 'hls' ? 'HLS stream' : 'Video';
    if (preferred.type === 'hls') {
      try {
        const Hls = await loadHls();
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
      } catch (_) {}
    }
    els.mediaVideo.src = preferred.src;
  }


  function renderArticle(data) {
    const mode = String(data.mode || 'READER').toUpperCase();
    const meta = data.metadata || {};
    const content = data.content || {};
    const d = data.data || {};

    if (els.metaSite) els.metaSite.textContent = meta.siteName || (data.url ? (() => { try { return new URL(data.url).hostname; } catch { return ''; } })() : '');
    if (els.metaTitle) els.metaTitle.textContent = meta.title || data.url || '';
    if (els.metaByline) els.metaByline.textContent = meta.byline || '';
    if (els.metaTime) {
      const mins = content.reading_time_minutes || d.reading_time_min || 0;
      els.metaTime.textContent = mins ? (' · ' + mins + ' ' + T.min) : '';
    }

    destroyMedia();

    if (mode === 'EMBED' && (d.embed_url || (data.media && data.media.videos && data.media.videos[0]))) {
      const embed = d.embed_url || '';
      if (els.view) {
        els.view.innerHTML =
          '<div class="embed-frame-wrap">' +
          '<iframe class="embed-frame" src="' + embed.replace(/"/g, '&quot;') + '" title="Media" ' +
          'allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" ' +
          'allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>';
      }
      if (els.mediaBox) els.mediaBox.hidden = true;
      showReader();
      document.title = (meta.title ? meta.title + ' · ' : '') + 'SoloHost';
      return;
    }

    
    if (mode === 'WEBVIEW') {
      const reason = (d.reason || (data.diagnostics && data.diagnostics.intent_reason) || 'LOGIN_OR_COMPLEX_APP');
      const targetUrl = data.url || '';
      const note = lang === 'vi'
        ? 'Trang cần đăng nhập hoặc tương tác phức tạp. Dùng khung bên dưới nếu site cho phép, hoặc mở full trên tab của bạn để giữ cookie an toàn.'
        : 'This site needs login or complex interaction. Use the frame below when allowed, or open full page in your tab so cookies stay on your device.';
      if (els.metaSite) els.metaSite.textContent = meta.siteName || '';
      if (els.metaTitle) els.metaTitle.textContent = meta.title || targetUrl || 'WebView';
      if (els.metaByline) els.metaByline.textContent = '';
      if (els.metaTime) els.metaTime.textContent = '';
      if (els.mediaBox) els.mediaBox.hidden = true;
      destroyMedia();
      if (els.view) {
        els.view.innerHTML =
          '<div class="webview-shell">' +
            '<div class="webview-toolbar">' +
              '<p class="webview-note">' + note + '</p>' +
              '<div class="webview-actions">' +
                '<a class="btn primary" id="wv-open" href="' + String(targetUrl).replace(/"/g, '&quot;') + '" target="_blank" rel="noopener noreferrer">Open page</a>' +
                '<button type="button" class="btn" id="wv-reload" title="Reload frame">↻</button>' +
                '<button type="button" class="btn" id="wv-copy" title="Copy URL">Copy URL</button>' +
              '</div>' +
              '<p class="webview-reason">Reason: ' + String(reason).replace(/</g, '') + '</p>' +
            '</div>' +
            '<div class="webview-frame-wrap">' +
              '<iframe class="webview-frame" id="wv-frame" title="WebView" ' +
                'src="' + String(targetUrl).replace(/"/g, '&quot;') + '" ' +
                'referrerpolicy="no-referrer-when-downgrade" ' +
                'allow="fullscreen; clipboard-read; clipboard-write" ' +
                'sandbox="allow-forms allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-top-navigation-by-user-activation">' +
              '</iframe>' +
              '<div class="webview-frame-fallback" id="wv-fallback" hidden>' +
                '<p>' + (lang === 'vi'
                  ? 'Site chặn nhúng iframe (X-Frame-Options). Hãy bấm <strong>Open page</strong> để mở full trên tab của bạn — đăng nhập và cookie giữ trên máy bạn.'
                  : 'This site blocks embedded frames (X-Frame-Options). Tap <strong>Open page</strong> for a full tab — login and cookies stay on your device.') +
                '</p>' +
              '</div>' +
            '</div>' +
          '</div>';
        const frame = document.getElementById('wv-frame');
        const fallback = document.getElementById('wv-fallback');
        // If iframe stays blank / blocked, reveal fallback after a short wait
        let settled = false;
        const revealFallback = () => {
          if (settled) return;
          settled = true;
          if (fallback) fallback.hidden = false;
        };
        if (frame) {
          frame.addEventListener('load', () => {
            // Cross-origin: cannot read contentDocument; treat load as ok and keep frame
            settled = true;
            if (fallback) fallback.hidden = true;
          });
          setTimeout(revealFallback, 3500);
        }
        const copyBtn = document.getElementById('wv-copy');
        if (copyBtn) copyBtn.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(targetUrl); copyBtn.textContent = 'Copied'; }
          catch (_) { copyBtn.textContent = 'Select URL bar'; }
        });
        const reloadBtn = document.getElementById('wv-reload');
        if (reloadBtn && frame) reloadBtn.addEventListener('click', () => {
          settled = false;
          if (fallback) fallback.hidden = true;
          try { frame.src = targetUrl; } catch (_) {}
          setTimeout(revealFallback, 3500);
        });
      }
      showReader();
      document.title = (meta.title ? meta.title + ' · ' : '') + 'SoloHost';
      return;
    }

    // READER (default)
    if (els.view) {
      const html = d.clean_html || content.clean_html || '';
      const text = d.raw_text || content.raw_text || '';
      if (html) {
        els.view.innerHTML = html;
      } else if (text) {
        els.view.innerHTML = '<p>' + String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/\n/g,'</p><p>') + '</p>';
      } else {
        els.view.innerHTML = '<p class="lede">' + T.empty + '</p><p><a href="' + (data.url || '#') + '" target="_blank" rel="noopener">' + (data.url || '') + '</a></p>';
      }
    }
    if (data.challenge || (data.diagnostics && data.diagnostics.challenge)) {
      const ch = data.challenge || data.diagnostics.challenge;
      const note = (lang === 'vi')
        ? ('Trang yêu cầu xác minh người dùng (CAPTCHA). Trình duyệt headless không vượt được kiểm tra này.')
        : (ch.message || 'This site requires a human CAPTCHA check.');
      if (els.view) {
        els.view.innerHTML = '<div class="challenge-banner"><strong>⚠</strong> ' + note + '</div>' + (els.view.innerHTML || '');
      }
    }
    document.title = (meta.title ? meta.title + ' · ' : '') + 'SoloHost';
    setupMedia((data.media && data.media.videos) || []);
    showReader();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function openUrl(raw) {
    const url = normalizeUrl(raw);
    if (!url) return;
    if (state.loading && state.url === url) return;

    if (state.abort) {
      try { state.abort.abort(); } catch (_) {}
    }
    state.abort = typeof AbortController !== 'undefined' ? new AbortController() : null;
    state.url = url;
    if (els.input) els.input.value = url;

    state.loading = true;
    if (els.go) els.go.disabled = true;
    setStatus(T.loading, true);
    if (els.errorPanel) els.errorPanel.hidden = true;
    // Keep previous reader visible while loading (less "jump to home").
    if (els.home) els.home.hidden = true;

    try {
      const res = await fetch(apiUrl('/api/browser/parse?url=' + encodeURIComponent(url)), {
        headers: {
          'Accept': 'application/json',
          'Accept-Language': navigator.language || 'en'
        },
        signal: state.abort ? state.abort.signal : undefined
      });
      let data = null;
      try { data = await res.json(); } catch (_) { data = null; }

      if (!res.ok || !data || data.success === false) {
        const msg = (data && (data.error || data.message)) || ('HTTP ' + res.status);
        showError(msg);
        return;
      }
      state.lastPayload = data;
      window.__soloArticle = {
        url: data.url || url,
        title: (data.metadata && data.metadata.title) || '',
        raw_text: (data.data && data.data.raw_text) || (data.content && data.content.raw_text) || '',
        clean_html: (data.data && data.data.clean_html) || (data.content && data.content.clean_html) || '',
        mode: data.mode || 'READER'
      };
      renderArticle(data);
      try {
        fetch(apiUrl('/api/history'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: data.url || url, title: (data.metadata && data.metadata.title) || url })
        }).catch(() => {});
      } catch (_) {}
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      showError(String((err && err.message) || err));
    } finally {
      state.loading = false;
      if (els.go) els.go.disabled = false;
      setStatus('', false);
    }
  }

  window.openUrl = openUrl;

  function onSubmit(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    openUrl(els.input && els.input.value);
    return false;
  }

  if (els.form) {
    els.form.setAttribute('action', 'javascript:void(0)');
    els.form.addEventListener('submit', onSubmit);
  }
  if (els.input) {
    // type=text avoids HTML5 URL validation rejecting bare domains
    els.input.setAttribute('type', 'text');
    els.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        onSubmit(e);
      }
    });
  }
  // Reader link navigation — relative/absolute links load next article in-app
  if (els.view) {
    els.view.addEventListener('click', (e) => {
      try {
        const a = e.target && e.target.closest ? e.target.closest('a') : null;
        if (!a || !els.view.contains(a)) return;
        const href = (a.getAttribute('href') || '').trim();
        if (!href || href === '#' || /^javascript:/i.test(href)) {
          e.preventDefault();
          return;
        }
        if (/^(mailto:|tel:)/i.test(href)) return; // let browser handle
        // Resolved absolute URL (browser expands relative against document base; we prefer href property)
        let target = '';
        try { target = a.href || href; } catch (_) { target = href; }
        if (!/^https?:/i.test(target)) return;
        e.preventDefault();
        e.stopPropagation();
        if (els.input) els.input.value = target;
        openUrl(target);
      } catch (_) { /* never break reader */ }
    });
  }

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

  try {
    const q = new URLSearchParams(location.search).get('url');
    if (q) openUrl(q);
  } catch (_) {}
})();
