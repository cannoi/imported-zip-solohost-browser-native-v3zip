(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const frame = $('main-webview');
  const input = $('url-input');
  const hint = $('wv-hint');
  const btnLang = $('btn-lang');
  const btnOpen = $('btn-open-tab');

  const state = {
    lang: localStorage.getItem('solo_lang') || (navigator.language || 'en').toLowerCase().startsWith('vi') ? 'vi' : 'en',
    readerOn: false,
    url: ''
  };

  const T = {
    en: {
      hint: 'Client WebView — pages open in the frame. Cross-origin sites may require ↗ for login & AI extract.',
      cross: 'Cross-origin page: browser blocks DOM access. Use ↗ Open tab, or AI on same-origin pages only.',
      noText: 'No text extracted from this page.',
      loading: 'Working…',
      sum: 'Summary',
      tr: 'Translation'
    },
    vi: {
      hint: 'WebView phía client — trang mở trong khung. Site cross-origin có thể cần ↗ để đăng nhập & trích AI.',
      cross: 'Trang cross-origin: trình duyệt chặn đọc DOM. Dùng ↗ mở tab, hoặc AI trên trang same-origin.',
      noText: 'Không trích được nội dung trang này.',
      loading: 'Đang xử lý…',
      sum: 'Tóm tắt',
      tr: 'Bản dịch'
    }
  };

  function t(k) { return (T[state.lang] || T.en)[k] || T.en[k] || k; }

  function applyLang() {
    if (btnLang) btnLang.textContent = state.lang === 'vi' ? 'VI' : 'EN';
    if (hint) hint.textContent = t('hint');
    localStorage.setItem('solo_lang', state.lang);
  }

  function normalizeUrl(raw) {
    let s = String(raw || '').trim();
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    if (/^[\w.-]+\.[a-z]{2,}([/:].*)?$/i.test(s)) return 'https://' + s;
    return 'https://www.google.com/search?q=' + encodeURIComponent(s);
  }

  function navigate(raw) {
    const url = normalizeUrl(raw);
    if (!url || !frame) return;
    state.url = url;
    state.readerOn = false;
    if (input) input.value = url;
    if (btnOpen) btnOpen.href = url;
    try {
      frame.src = url;
    } catch (e) {
      if (hint) hint.textContent = String(e.message || e);
    }
  }

  function extractPage() {
    if (!window.SoloReader) return { ok: false, error: 'NO_INJECTOR' };
    const out = window.SoloReader.extractCurrentPageDOM(frame);
    if (!out.ok && out.error === 'NO_DOCUMENT') {
      return { ok: false, error: 'CROSS_ORIGIN', message: t('cross') };
    }
    if (!out.raw_text || out.raw_text.length < 20) {
      // Likely cross-origin blank access
      const doc = window.SoloReader.getFrameDocument(frame);
      if (!doc) return { ok: false, error: 'CROSS_ORIGIN', message: t('cross') };
      return { ok: false, error: 'EMPTY', message: t('noText') };
    }
    return out;
  }

  async function aiProcess(action, extra) {
    const extracted = extractPage();
    if (!extracted.ok) {
      appendAiNote(extracted.message || extracted.error || t('cross'));
      return;
    }
    appendAiNote(t('loading'));
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
          query: (extra && extra.query) || '',
          ...(extra || {})
        })
      });
      const data = await res.json();
      const reply = (data.result && (data.result.reply || data.result.text || data.result.message))
        || data.error || JSON.stringify(data);
      appendAiNote((action === 'summarize' ? t('sum') : action === 'translate' ? t('tr') : 'AI') + ':\n' + reply);
      openAiPanel();
    } catch (err) {
      appendAiNote(String(err.message || err));
    }
  }

  function appendAiNote(text) {
    const box = $('aiChat');
    if (!box) {
      if (hint) hint.textContent = String(text).slice(0, 200);
      return;
    }
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

  // Events
  const form = $('nav-form');
  if (form) form.addEventListener('submit', (e) => {
    e.preventDefault();
    navigate(input && input.value);
  });
  if ($('btn-back')) $('btn-back').addEventListener('click', () => {
    try { frame.contentWindow.history.back(); } catch (_) { history.back(); }
  });
  if ($('btn-fwd')) $('btn-fwd').addEventListener('click', () => {
    try { frame.contentWindow.history.forward(); } catch (_) { history.forward(); }
  });
  if ($('btn-reload')) $('btn-reload').addEventListener('click', () => {
    try { frame.contentWindow.location.reload(); } catch (_) { if (state.url) frame.src = state.url; }
  });
  if ($('btn-reader')) $('btn-reader').addEventListener('click', () => {
    state.readerOn = !state.readerOn;
    const r = window.SoloReader && window.SoloReader.toggleReaderView(frame, state.readerOn);
    if (r && !r.ok) {
      if (hint) hint.textContent = r.message || r.error || t('cross');
      state.readerOn = false;
    }
  });
  if ($('btn-summary')) $('btn-summary').addEventListener('click', () => aiProcess('summarize'));
  if ($('btn-translate')) $('btn-translate').addEventListener('click', () => aiProcess('translate'));
  if (btnLang) btnLang.addEventListener('click', () => {
    state.lang = state.lang === 'vi' ? 'en' : 'vi';
    applyLang();
  });

  applyLang();
  try {
    const q = new URLSearchParams(location.search).get('url');
    if (q) navigate(q);
  } catch (_) {}

  window.SoloBrowser = { navigate, extractPage, aiProcess, state };
})();
