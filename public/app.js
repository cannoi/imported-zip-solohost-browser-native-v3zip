(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const frame = $('main-webview');
  const input = $('url-input');
  const btnOpen = $('btn-open-tab'); // legacy (removed from chrome)
  const btnPrivate = $('btn-private-tab');
  const btnLang = $('btn-lang');
  const btnTheme = $('btn-theme');
  const THEMES = ['rainbow', 'dark', 'light'];
  const bridgeAuditSeen = new Set();
  const state = {
    url: '',
    lang: (typeof localStorage !== 'undefined' && localStorage.getItem('solo_lang')) || 'en',
    theme: (typeof localStorage !== 'undefined' && localStorage.getItem('solo_theme')) || 'rainbow',
    searchEngine: (typeof localStorage !== 'undefined' && localStorage.getItem('solo_search_engine')) || 'bing',
    customSearchUrl: (typeof localStorage !== 'undefined' && localStorage.getItem('solo_search_custom_url')) || '',
    timeZone: (typeof localStorage !== 'undefined' && localStorage.getItem('solo_timezone')) || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    localeReady: false,
    tabs: [],
    activeTabId: null,
    history: [],
    readerOn: false,
    lastNavAt: 0,
    libraryMode: 'bookmarks'
  };
  let localeSyncPromise = null;

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
  function isExternalAuthPath(url) {
    try {
      const u = new URL(url);
      const h = u.hostname.toLowerCase().replace(/^www\./, '');
      const p = u.pathname || '/';
      if (h === 'accounts.google.com') return true;
      if ((h === 'youtube.com' || h.endsWith('.youtube.com')) && /\/(signin|sign_in)(?:\/|$)/i.test(p)) return true;
      if ((h === 'facebook.com' || h.endsWith('.facebook.com')) && /\/(login|checkpoint|recover)(?:\/|$)/i.test(p)) return true;
      if ((h === 'tiktok.com' || h.endsWith('.tiktok.com') || h === 'login.tiktok.com') && /\/(login|signup|passport)(?:\/|$)/i.test(p)) return true;
      return false;
    } catch { return false; }
  }

  function isLoginPath(url) {
    try {
      const u = new URL(url);
      const p = (u.pathname || '') + (u.search || '');
      return /\/(login|signin|sign-in|signup|sign-up|register|oauth|authorize)/i.test(p) || isExternalAuthPath(url);
    } catch { return false; }
  }

  
  function resolveSoloHref(hrefRaw, base) {
    let abs = String(hrefRaw || '').trim();
    if (!abs) return '';
    try {
      const u = new URL(abs, base || (typeof location !== 'undefined' ? location.href : 'https://example.com'));
      if (u.pathname === '/api/proxy' && u.searchParams.get('url')) abs = u.searchParams.get('url');
      else abs = u.href;
    } catch (_) {}
    // Bing tracking /ck/a?u=a1+base64
    try {
      const u = new URL(abs);
      const host = u.hostname.replace(/^www\./, '').toLowerCase();
      if ((host === 'bing.com' || host.endsWith('.bing.com')) && (u.pathname === '/ck/a' || u.pathname.indexOf('/ck/') === 0)) {
        let packed = u.searchParams.get('u') || u.searchParams.get('url') || '';
        if (/^a1/i.test(packed)) packed = packed.slice(2);
        if (packed) {
          try {
            const b64 = packed.replace(/-/g, '+').replace(/_/g, '/');
            const pad = b64.length % 4 === 0 ? b64 : b64 + '='.repeat(4 - (b64.length % 4));
            const bin = atob(pad);
            if (/^https?:\/\//i.test(bin)) abs = bin;
          } catch (_) {}
        }
      }
    } catch (_) {}
    // DuckDuckGo /l/?uddg=
    try {
      const u = new URL(abs);
      if (/duckduckgo\.com$/i.test(u.hostname) && (u.pathname === '/l/' || u.pathname === '/l')) {
        const uddg = u.searchParams.get('uddg') || u.searchParams.get('u');
        if (uddg && /^https?:/i.test(uddg)) abs = uddg;
      }
    } catch (_) {}
    if (!/^https?:/i.test(abs) && !/^http:\/\/127\.0\.0\.1/i.test(abs)) {
      try { abs = new URL(hrefRaw, base || 'https://example.com').href; } catch (_) { return ''; }
    }
    return abs;
  }

  function isYouTubeVideoUrl(url) {
    try {
      const u = new URL(url);
      const h = u.hostname.toLowerCase().replace(/^www\./, '');
      if (h === 'youtu.be') return /^\/[\w-]{6,15}\/?$/.test(u.pathname);
      if (!(h === 'youtube.com' || h.endsWith('.youtube.com') || h === 'youtube-nocookie.com')) return false;
      if (/^\/watch\/?$/i.test(u.pathname)) return /^[\w-]{6,15}$/.test(u.searchParams.get('v') || '');
      return /^\/(?:shorts|live|v)\/[\w-]{6,15}(?:\/|$)/i.test(u.pathname);
    } catch (_) { return false; }
  }

  function isNativeMediaOrDocumentUrl(url) {
    try {
      const u = new URL(url); const p = (u.pathname || '').toLowerCase();
      return /\.(?:mp4|webm|ogv|mov|m4v|mp3|m4a|aac|wav|flac|opus|oga|pdf|png|jpe?g|webp|avif|gif)(?:$)/i.test(p);
    } catch (_) { return false; }
  }

  // Direct audio files can play in the user's own browser without capturing backend audio.
  function isDirectAudioUrl(raw) {
    try {
      const u = new URL(String(raw || '').trim());
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return false;
      return /\.(?:mp3|m4a|aac|wav|flac|opus|oga|ogg)(?:$)/i.test(u.pathname || '');
    } catch (_) { return false; }
  }

  function classifyUrl(url) {
    const h = hostOf(url);
    if (isNativeMediaOrDocumentUrl(url)) return MODE.DIRECT;
    if (!h) return MODE.PROXY;
    try { const bu = new URL(url); if (/(^|\.)bing\.com$/.test(bu.hostname) && /captcha|challenge|verify|pow/i.test(bu.pathname + bu.search)) return MODE.DIRECT; } catch (_) {}
    if (isExternalAuthPath(url)) return MODE.EXTERNAL;
    // YouTube → official player shell (PROXY) — unchanged from pre-noVNC
    if (isYouTubeVideoUrl(url)) return MODE.PROXY;
    try {
      const yu = new URL(url);
      const yh = yu.hostname.replace(/^www\./, '').toLowerCase();
      let yp = yu.pathname || '/';
      if (yp.length > 1 && yp.endsWith('/')) yp = yp.slice(0, -1);
      if ((yh === 'youtube.com' || yh === 'm.youtube.com' || yh === 'youtu.be') &&
          (yp === '/' || yp === '/feed' || yp.indexOf('/feed/') === 0)) {
        return MODE.PROXY;
      }
    } catch (_) {}
    if (/(^|\.)(netflix|disneyplus|hulu|primevideo)\.com$/.test(h)) return MODE.EXTERNAL;
    if (isDirectEmbed(url)) return MODE.DIRECT;
    if (/google\./.test(h)) return MODE.ENGINE;
    if (/youtube\.com|youtu\.be/.test(h)) return MODE.PROXY;
    if (/(^|\.)(facebook|fb|instagram|whatsapp|messenger|tiktok|x|twitter|reddit)\.com$/.test(h)) return MODE.ENGINE;
    if (isLoginPath(url)) return MODE.ENGINE;
    return MODE.ENGINE;
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

  function normalizeNavUrl(url) {
    try {
      const u = new URL(String(url || '').trim());
      u.hash = '';
      // stable form for history compare
      return u.href;
    } catch (_) {
      return String(url || '').trim();
    }
  }

  function pushNav(tab, url) {
    const nav = ensureTabNav(tab);
    if (!nav) return;
    url = normalizeNavUrl(url);
    if (!url || isInternalBridgeViewUrl(url)) return;
    // truncate any forward entries when branching from middle / from home (index -1)
    if (nav.index < nav.stack.length - 1) {
      nav.stack = nav.stack.slice(0, Math.max(0, nav.index + 1));
    }
    const last = nav.stack.length ? nav.stack[nav.stack.length - 1] : null;
    if (last !== url) {
      nav.stack.push(url);
      while (nav.stack.length > 50) nav.stack.shift();
    }
    nav.index = nav.stack.length - 1;
  }

  function syncNavButtons() {
    const tab = getActiveTab(); const nav = ensureTabNav(tab);
    const back = $('btn-back'); const fwd = $('btn-fwd');
    if (back) { back.disabled = !nav || (nav.index <= 0 && !state.url); back.setAttribute('aria-disabled', String(back.disabled)); }
    if (fwd) { fwd.disabled = !nav || nav.index >= nav.stack.length - 1; fwd.setAttribute('aria-disabled', String(fwd.disabled)); }
  }

  function goBack() {
    const tab = getActiveTab();
    const nav = ensureTabNav(tab);
    if (!nav || !nav.stack.length) {
      showStart();
      state.url = '';
      if (input) input.value = '';
      if (frame) { try { frame.removeAttribute('srcdoc'); frame.src = 'about:blank'; } catch (_) {} }
      syncNavButtons();
      return;
    }
    if (nav.index > 0) {
      nav.index -= 1;
      const target = nav.stack[nav.index];
      clientLog('info', 'nav.back', { index: nav.index, url: target, stack: nav.stack.length });
      navigate(target, { skipHistory: true, force: true });
      syncNavButtons();
      return;
    }
    // First entry in stack → return to Home without wiping history (Forward can restore)
    if (nav.index === 0) {
      nav.index = -1;
      clientLog('info', 'nav.back_home', { stack: nav.stack.length });
      showStart();
      state.url = '';
      if (input) input.value = '';
      if (frame) { try { frame.removeAttribute('srcdoc'); frame.src = 'about:blank'; } catch (_) {} }
      syncNavButtons();
      return;
    }
    // index already -1
    showStart();
    syncNavButtons();
  }

  function goForward() {
    const tab = getActiveTab();
    const nav = ensureTabNav(tab);
    if (!nav || !nav.stack.length) return;
    if (nav.index < nav.stack.length - 1) {
      nav.index += 1;
      const target = nav.stack[nav.index];
      clientLog('info', 'nav.forward', { index: nav.index, url: target });
      navigate(target, { skipHistory: true, force: true });
    }
    syncNavButtons();
  }

  function browserProfileId() {
    try { let id = localStorage.getItem('solo_browser_profile_id'); if (/^[a-f0-9]{32}$/i.test(id || '')) return id.toLowerCase(); const b = new Uint8Array(16); if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(b); else for (let i=0;i<b.length;i++) b[i]=Math.floor(Math.random()*256); id = Array.from(b, x => x.toString(16).padStart(2,'0')).join(''); localStorage.setItem('solo_browser_profile_id', id); return id; } catch (_) { return ''; }
  }

  async function tabBridgeSession(tab) {
    if (!state.localeReady && localeSyncPromise) {
      try { await Promise.race([localeSyncPromise, new Promise(resolve => setTimeout(resolve, 1600))]); } catch (_) {}
    }
    const nav = ensureTabNav(tab);
    if (nav.bridge && nav.bridge.sessionId && nav.bridge.token) return nav.bridge;
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), 2500) : null;
    try {
      const r = await fetch('/api/browser/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ privateMode: !!tab.private, profileId: browserProfileId(), locale: state.lang === 'vi' ? 'vi-VN' : 'en-US', timezoneId: state.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }),
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

  async function loadViaBridge(tab, url, retryStale) {
    if (retryStale === undefined) retryStale = true;
    // Hard client timeout — never block UI for WebKit IPC (logs showed 35s+ ipc_timeout)
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), 28000) : null;
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
      if (r.status === 401 || (j && /session_not_found|unauthorized/i.test(String(j.error || '')))) {
        if (ensureTabNav(tab)) ensureTabNav(tab).bridge = null;
        clientLog('warn', 'bridge.session_recover', { reason: j && j.error || 'unauthorized' });
        if (retryStale) return loadViaBridge(tab, url, false);
        return { ok: false, reason: 'bridge_session_stale', detail: j };
      }
      if (!j || !j.ok) return { ok: false, reason: (j && j.error) || 'bridge_navigate_failed', detail: j };
      if (j.externalRequired && j.externalReason !== 'bing_verification_required') return loadViaExternal(googleExternalTarget(j.url || url), j.externalReason || 'site_auth_policy');
      const activeNav = ensureTabNav(tab);
      if (activeNav) activeNav.bridgeAudit = j.audit || {};
      // Prefer showing whatever the Bridge has; only fail hard when empty AND explicit error
      if (!j.hasContent && j.error && !j.title) return { ok: false, reason: j.error, detail: j };
      if (!j.hasContent && j.backend === 'proxy' && j.error === 'empty_content') {
        return { ok: false, reason: 'bridge_empty', detail: j };
      }
      const view = bridgeViewUrl(b);
      if (!frame || !view) return { ok: false, reason: 'no_viewport' };
      try {
        frame.setAttribute('sandbox', 'allow-same-origin allow-forms allow-scripts');
        // Always reload the Bridge viewport after navigate — same session URL path would
        // otherwise keep showing the previous page (data-sh-view equal → no load).
        const bust = view + (view.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now();
        frame.src = bust;
        frame.setAttribute('data-sh-view', view);
      } catch (_) {
        return { ok: false, reason: 'frame_error' };
      }
      const be = String(j.backend || b.backend || '');
      return {
        ok: true,
        mode: (be === 'webkit' || be === 'playwright') ? MODE.ENGINE : MODE.PROXY,
        backend: be,
        url: j.url || url,
        title: j.title || '',
        hasContent: !!j.hasContent
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

  function googleExternalTarget(url) {
    try { const u = new URL(url); if (u.hostname.toLowerCase() === 'accounts.google.com' && /\/signin\/rejected/i.test(u.pathname)) { const next = u.searchParams.get('continue'); if (next && /^https:\/\//i.test(next)) return next; } } catch (_) {}
    return url;
  }

  function loadViaExternal(url, reason) {
    const tab = getActiveTab(); const nav = ensureTabNav(tab);
    if (nav) nav.bridge = null;
    // Stop stale embedded pages from continuing to emit events after an auth/policy handoff.
    if (frame) { try { frame.removeAttribute('srcdoc'); frame.src = 'about:blank'; } catch (_) {} }
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

  
  /* —— Bridge viewport: no auto soft-refresh (avoids flicker & scroll jump) ——
     Missing images: one-shot nudge on frame load only; engine keeps scroll. */

  function nudgeLazyMediaInFrame() {
    try {
      if (!frame || !frame.contentDocument) return;
      const doc = frame.contentDocument;
      doc.querySelectorAll('img').forEach((img) => {
        try {
          if (img.dataset && img.dataset.src && (!img.getAttribute('src') || img.getAttribute('src') === '')) {
            img.setAttribute('src', img.dataset.src);
          }
          if (img.loading === 'lazy') img.loading = 'eager';
          if (typeof img.decode === 'function') img.decode().catch(function () {});
        } catch (_) {}
      });
    } catch (_) {}
  }

  function onBridgeFrameLoad() {
    try {
      nudgeLazyMediaInFrame();
      // Scroll position is owned by the user — do not rewrite document or force refresh
    } catch (_) {}
  }

  function bindBridgeViewportHelpers() {
    if (frame && !frame._soloViewportBound) {
      frame._soloViewportBound = true;
      frame.addEventListener('load', onBridgeFrameLoad);
    }
  }

  async function softRefreshActiveBridge() {
    // UI-only: repair missing images in the viewport. Never re-goto the backend page.
    try {
      const doc = frame && frame.contentDocument;
      if (!doc) return false;
      doc.querySelectorAll('img').forEach((img) => {
        try {
          if (!img.getAttribute('src') && img.dataset && img.dataset.src) img.src = img.dataset.src;
          if (img.complete && img.naturalWidth === 0 && img.src) {
            const u = img.src;
            img.src = '';
            img.src = u;
          }
        } catch (_) {}
      });
      return true;
    } catch (_) {
      return false;
    }
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
      if (j && j.ok && j.externalRequired) {
        if (j.url) applyUrlToUi(j.url, j.title);
        loadViaExternal(j.url || (tab && tab.url) || state.url, j.externalReason || 'site_auth_policy');
        return j;
      }
      if (j && j.ok && frame) {
        // Typing must not reload the snapshot: doing so loses focus and breaks login forms.
        // The real page receives every input event in WebKit; refresh only after actions that may navigate/update UI.
        if (ev.type !== 'input' && ev.type !== 'change') {
          const view = bridgeViewUrl(b);
          if (view) frame.src = view + '&t=' + Date.now();
        }
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

  // Opera-style long-press / right-click menu for the same-origin Bridge snapshot.
  const contextMenu = $('page-context-menu');
  let contextTarget = null;
  function hideContextMenu() { if (contextMenu) { contextMenu.hidden = true; contextMenu.textContent = ''; } contextTarget = null; }
  function showContextMenu(payload, x, y) {
    if (!contextMenu) return;
    contextTarget = payload || {};
    const vi = state.lang === 'vi';
    const items = [];
    if (contextTarget.href) {
      items.push([vi ? 'Mở liên kết trong tab mới' : 'Open link in new tab', 'new-tab']);
      items.push([vi ? 'Mở liên kết trong tab riêng tư' : 'Open link in private tab', 'private-tab']);
      items.push([vi ? 'Sao chép địa chỉ liên kết' : 'Copy link address', 'copy-link']);
      items.push([vi ? 'Chia sẻ liên kết' : 'Share link', 'share-link']);
      items.push([vi ? 'Tải xuống liên kết…' : 'Download link…', 'download-link']);
    }
    if (contextTarget.mediaSrc) {
      items.push([vi ? 'Mở media trong tab mới' : 'Open media in new tab', 'media-tab']);
      items.push([vi ? 'Sao chép địa chỉ media' : 'Copy media address', 'copy-media']);
      if (contextTarget.mediaType === 'image') items.push([vi ? 'Mở ảnh' : 'Open image', 'open-image']);
    }
    if (contextTarget.selectedText) {
      items.push([vi ? 'Tìm trên Google' : 'Search Google', 'search-text']);
      items.push([vi ? 'Sao chép văn bản' : 'Copy text', 'copy-text']);
    }
    if (!items.length && state.url) items.push([vi ? 'Sao chép địa chỉ trang' : 'Copy page address', 'copy-page']);
    contextMenu.textContent = '';
    items.forEach(([label, action]) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'page-context-action'; b.setAttribute('role', 'menuitem'); b.textContent = label;
      b.addEventListener('click', () => runContextAction(action)); contextMenu.appendChild(b);
    });
    contextMenu.hidden = false;
    const width = Math.min(300, window.innerWidth - 16), height = contextMenu.offsetHeight || 260;
    contextMenu.style.left = Math.max(8, Math.min(Number(x) || 8, window.innerWidth - width - 8)) + 'px';
    contextMenu.style.top = Math.max(8, Math.min(Number(y) || 8, window.innerHeight - height - 8)) + 'px';
  }
  async function copyTextSafe(text) {
    if (!text) return;
    try { await navigator.clipboard.writeText(text); }
    catch (_) { const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (_) {} ta.remove(); }
  }
  function runContextAction(action) {
    const t = contextTarget || {}; const href = t.href || ''; const media = t.mediaSrc || '';
    hideContextMenu();
    if (action === 'new-tab' && href) return newTab(href);
    if (action === 'private-tab' && href) return newTab(href, { private: true });
    if (action === 'media-tab' && media) return newTab(media);
    if (action === 'open-image' && media) return newTab(media);
    if (action === 'copy-link') return copyTextSafe(href);
    if (action === 'copy-media') return copyTextSafe(media);
    if (action === 'copy-text') return copyTextSafe(t.selectedText || '');
    if (action === 'copy-page') return copyTextSafe(state.url || '');
    if (action === 'search-text' && t.selectedText) return navigate(buildSearchUrl(t.selectedText));
    if (action === 'share-link') {
      const shareUrl = href || state.url;
      if (navigator.share) navigator.share({ title: t.linkText || document.title || 'Link', url: shareUrl }).catch(() => {});
      else copyTextSafe(shareUrl);
      return;
    }
    if (action === 'download-link' && href) {
      const a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.download = ''; document.body.appendChild(a); a.click(); a.remove();
    }
  }
  document.addEventListener('click', e => { if (contextMenu && !contextMenu.contains(e.target)) hideContextMenu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hideContextMenu(); });
  window.addEventListener('resize', hideContextMenu);

  // Same-origin bridge document interactions
  if (frame) {
    frame.addEventListener('load', () => {
      try {
        const doc = frame.contentDocument;
        if (!doc) return;
        const tab = getActiveTab();
        const nav = ensureTabNav(tab);
        if (!nav || !nav.bridge) return;
        const body = doc.body;
        if (body) {
          const describeContextTarget = (target) => {
            const el = target && target.closest ? target.closest('a[href],img,video,audio,source,[role="link"]') || target : target;
            let href = '', mediaSrc = '', mediaType = '', linkText = '';
            if (!el) return {};
            const tag = (el.tagName || '').toLowerCase();
            if (tag === 'a' || el.getAttribute('role') === 'link') {
              try { href = new URL(el.getAttribute('href') || '', state.url).href; } catch (_) {}
              linkText = (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 180);
            }
            if (tag === 'img') { mediaSrc = el.currentSrc || el.src || ''; mediaType = 'image'; }
            else if (tag === 'video' || tag === 'audio' || tag === 'source') { mediaSrc = el.currentSrc || el.src || el.getAttribute('src') || ''; mediaType = tag; }
            if (!href && el.closest) {
              const a = el.closest('a[href]'); if (a) { try { href = new URL(a.getAttribute('href') || '', state.url).href; } catch (_) {} linkText = (a.innerText || '').trim().slice(0, 180); }
            }
            const selectedText = String((doc.getSelection && doc.getSelection().toString()) || '').trim().slice(0, 500);
            return { href, mediaSrc, mediaType, selectedText, linkText };
          };
          let longPressTimer = null, longPressStart = null, longPressTriggered = false;
          const cancelLongPress = () => { if (longPressTimer) clearTimeout(longPressTimer); longPressTimer = null; longPressStart = null; };
          doc.addEventListener('contextmenu', e => {
            const payload = describeContextTarget(e.target);
            if (!payload.href && !payload.mediaSrc && !payload.selectedText) return;
            e.preventDefault();
            showContextMenu(payload, e.clientX, e.clientY);
          }, true);
          doc.addEventListener('pointerdown', e => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            cancelLongPress(); longPressTriggered = false;
            longPressStart = { x: e.clientX, y: e.clientY, target: e.target };
            longPressTimer = setTimeout(() => {
              if (!longPressStart) return;
              const payload = describeContextTarget(longPressStart.target);
              if (!payload.href && !payload.mediaSrc && !payload.selectedText) return;
              longPressTriggered = true;
              showContextMenu(payload, longPressStart.x, longPressStart.y);
            }, 520);
          }, { capture: true, passive: true });
          doc.addEventListener('pointermove', e => {
            if (longPressStart && (Math.abs(e.clientX - longPressStart.x) > 12 || Math.abs(e.clientY - longPressStart.y) > 12)) cancelLongPress();
          }, { capture: true, passive: true });
          ['pointerup','pointercancel','scroll'].forEach(type => doc.addEventListener(type, cancelLongPress, { capture: true, passive: true }));
          doc.addEventListener('click', e => { if (longPressTriggered) { e.preventDefault(); e.stopPropagation(); longPressTriggered = false; } }, true);

          const audit = {
            textLength: (body.innerText || '').length,
            links: doc.querySelectorAll('a[href]').length,
            forms: doc.querySelectorAll('form').length,
            controls: doc.querySelectorAll('input,select,textarea,button').length,
            media: doc.querySelectorAll('video,audio').length,
            iframes: doc.querySelectorAll('iframe').length,
            scriptTagsInSnapshot: doc.querySelectorAll('script').length
          };
          const sourceAudit = nav.bridgeAudit || {};
          const lost = {
            textLength: Math.max(0, (sourceAudit.textLength || 0) - audit.textLength),
            controls: Math.max(0, (sourceAudit.controls || 0) - audit.controls),
            media: Math.max(0, (sourceAudit.media || 0) - audit.media),
            iframes: Math.max(0, (sourceAudit.iframes || 0) - audit.iframes),
            links: Math.max(0, (sourceAudit.links || 0) - audit.links)
          };
          const dataLoss = lost.iframes > 0 || lost.media > 0 || lost.controls > 0 || lost.links > 5 ||
            (sourceAudit.textLength > 300 && audit.textLength < sourceAudit.textLength * 0.35);
          const auditSignature = [state.url, sourceAudit.textLength || 0, sourceAudit.controls || 0, sourceAudit.media || 0,
            sourceAudit.iframes || 0, sourceAudit.links || 0, audit.textLength, audit.controls, audit.media, audit.iframes, audit.links].join('|');
          const firstAudit = !bridgeAuditSeen.has(auditSignature);
          if (firstAudit) {
            bridgeAuditSeen.add(auditSignature);
            if (bridgeAuditSeen.size > 500) bridgeAuditSeen.clear();
            clientLog((audit.textLength < 120 || dataLoss) ? 'warn' : 'info', 'bridge_render_audit', {
              url: state.url,
              detail: JSON.stringify({ source: sourceAudit, rendered: audit, suspectedLoss: lost })
            });
          }
          // Ask AI only once for each weak snapshot signature. Send metrics only, never page
          // text, form values, cookies, credentials, or tokens; avoid duplicate AI work on re-renders.
          if (firstAudit && (audit.textLength < 120 || dataLoss || (audit.forms > 0 && audit.controls === 0))) {
            fetch('/api/browser/ai-compat', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                url: state.url, mode: nav.mode || 'ENGINE', reason: 'empty_content', lang: state.lang,
                textSnippet: 'Bridge source/render metrics only: ' + JSON.stringify({ source: sourceAudit, rendered: audit, suspectedLoss: lost }), structureHtml: ''
              })
            }).then(r => r.json()).then(j => {
              clientLog('warn', 'bridge_ai_compat_finding', {
                url: state.url,
                detail: JSON.stringify({ category: j.category, confidence: j.confidence, recommendedMode: j.recommendedMode, summary: j.summary, suggestions: j.suggestions, source: j.source, suspectedLoss: lost })
              });
            }).catch(() => {});
          }
        }
        doc.addEventListener('click', (e) => {
          // Universal link handler: keep navigation inside SoloHost only (never host Opera/Chrome tab).
          const aEl = e.target && e.target.closest && e.target.closest('a[href]');
          if (aEl) {
            const hrefRaw = aEl.getAttribute('href') || '';
            if (hrefRaw && hrefRaw.charAt(0) !== '#' && !/^(javascript|mailto|tel):/i.test(hrefRaw)) {
              e.preventDefault();
              e.stopPropagation();
              try { e.stopImmediatePropagation(); } catch (_) {}
              try {
                let abs = resolveSoloHref(hrefRaw, state.url);
                if (!abs) return;
                if (isYouTubeVideoUrl(abs)) {
                  clientLog('info', 'youtube.video_handoff', { url: abs });
                  navigate(abs, { force: true, mode: MODE.PROXY });
                  return;
                }
                if (isNativeMediaOrDocumentUrl(abs)) {
                  navigate(abs, { force: true });
                  return;
                }
                // Ctrl/Meta → new SoloHost tab (not host browser)
                if (e.ctrlKey || e.metaKey) newTab(abs);
                else navigate(abs, { force: true });
              } catch (err) {
                clientLog('warn', 'link.navigate_fail', { detail: String(err && err.message || err) });
              }
              return;
            }
          }
          const el = e.target && e.target.closest && e.target.closest('[data-sh-id]');
          if (!el) return;
          const tag = (el.tagName || '').toLowerCase();
          const inputType = (el.getAttribute('type') || '').toLowerCase();
          if (tag === 'button' || tag === 'label' || ['button','link','tab','checkbox','switch','option','menuitem'].includes(el.getAttribute('role')) ||
              (tag === 'input' && ['checkbox','radio','submit','button','reset'].includes(inputType)) ) {
            e.preventDefault();
            e.stopPropagation();
            bridgeEvent({ type: 'click', targetId: el.getAttribute('data-sh-id'), checked: !!el.checked, selectedIndex: el.selectedIndex });
          }
        }, true);
        const inputTimers = new WeakMap();
        doc.addEventListener('input', (e) => {
          const el = e.target && e.target.closest && e.target.closest('[data-sh-id]');
          if (!el) return;
          const id = el.getAttribute('data-sh-id');
          const old = inputTimers.get(el); if (old) clearTimeout(old);
          inputTimers.set(el, setTimeout(() => {
            bridgeEvent({ type: 'input', targetId: id, value: (el.isContentEditable || el.getAttribute('role') === 'textbox') ? el.innerText : el.value, checked: !!el.checked, selectedIndex: el.selectedIndex });
          }, 90));
        }, true);
        doc.addEventListener('change', (e) => {
          const el = e.target && e.target.closest && e.target.closest('[data-sh-id]');
          if (!el) return;
          bridgeEvent({ type: 'change', targetId: el.getAttribute('data-sh-id'), value: (el.isContentEditable || el.getAttribute('role') === 'textbox') ? el.innerText : el.value, checked: !!el.checked, selectedIndex: el.selectedIndex });
        }, true);
        doc.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          const el = e.target;
          if (!el || !/^(INPUT|TEXTAREA)$/.test(el.tagName)) return;
          const form = el.closest('form');
          if (!form) return;
          e.preventDefault();
          const id = form.getAttribute('data-sh-id');
          if (id) bridgeEvent({ type: 'submit', targetId: id });
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
    try {
      const vi = state.lang === 'vi';
      document.documentElement.lang = vi ? 'vi' : 'en';
      if ($('home-pl-title')) $('home-pl-title').textContent = vi ? 'Nhạc' : 'Playlist';
      if ($('home-sc-title')) $('home-sc-title').textContent = vi ? 'Nhiệm vụ AI' : 'AI Tasks';
      if ($('home-app-title')) $('home-app-title').textContent = vi ? 'Apps' : 'Apps';
      if ($('panel-pl-h')) $('panel-pl-h').textContent = vi ? '♪ Thư viện nhạc' : '♪ Music library';
      if ($('playlist-now-label')) $('playlist-now-label').textContent = vi ? 'Đang phát' : 'Now playing';
      if ($('playlist-now-title') && !$('playlist-now-title').dataset.userTitle) $('playlist-now-title').textContent = vi ? 'Chọn video để phát' : 'Choose a video';
      if ($('playlist-player-hint')) $('playlist-player-hint').textContent = vi ? 'Video phát ngay trong Playlist, không rời thư viện nhạc.' : 'Videos play here without leaving your music library.';
      if ($('panel-sc-h')) $('panel-sc-h').textContent = vi ? '⚡ Nhiệm vụ AI' : '⚡ AI Tasks';
      if ($('panel-app-h')) $('panel-app-h').textContent = vi ? '⊞ App SoloHost' : '⊞ SoloHost Apps';
      if ($('sc-hint')) $('sc-hint').textContent = vi
        ? '◎ Mẫu sẵn có · ✦ Yêu cầu mới được xử lý qua trợ lý hội thoại'
        : '◎ Starter tasks · ✦ New requests use the unified assistant';
      if ($('sc-name-input')) $('sc-name-input').placeholder = vi ? 'Tên nhiệm vụ' : 'Task name';
      if ($('sc-url-input')) $('sc-url-input').placeholder = vi ? 'URL điều hướng…' : 'Navigate URL…';
      if ($('pl-url-input')) $('pl-url-input').placeholder = vi ? 'Dán URL audio / video…' : 'Paste audio / video URL…';
      if ($('app-url-input')) $('app-url-input').placeholder = 'http://127.0.0.1:8090';
    } catch (_) {}

    if (btnLang) btnLang.textContent = state.lang === 'vi' ? 'VI' : 'EN';
    localStorage.setItem('solo_lang', state.lang);
    if (input) {
      input.placeholder = state.lang === 'vi' ? 'Tìm kiếm hoặc nhập địa chỉ' : 'Search or enter address';
    }
    const title = $('library-title'); if (title) title.textContent = state.lang === 'vi' ? 'Thư viện' : 'Library';
    const libraryButtons = document.querySelectorAll('[data-library]');
    libraryButtons.forEach(b => { b.textContent = state.lang === 'vi' ? (b.dataset.library === 'bookmarks' ? '☆ Dấu trang' : '◷ Lịch sử') : (b.dataset.library === 'bookmarks' ? '☆ Bookmarks' : '◷ History'); });
    const clear = $('history-clear'); if (clear) clear.textContent = state.lang === 'vi' ? 'Xóa lịch sử' : 'Clear history';
    const st = state.lang === 'vi';
    if ($('search-settings-title')) $('search-settings-title').textContent = st ? 'Công cụ tìm kiếm mặc định' : 'Default search engine';
    if ($('search-engine-label')) $('search-engine-label').textContent = st ? 'Công cụ tìm kiếm' : 'Search engine';
    if ($('search-custom-label')) $('search-custom-label').textContent = st ? 'URL tìm kiếm tùy chỉnh (dùng {query} hoặc %s)' : 'Custom search URL (use {query} or %s)';
    if ($('search-engine-help')) $('search-engine-help').textContent = st ? 'URL tùy chỉnh phải dùng HTTP(S). {query} hoặc %s sẽ được thay bằng từ khóa đã mã hóa.' : 'Custom URL must use HTTP(S). {query} or %s is replaced with encoded search terms.';
    if ($('search-settings-cancel')) $('search-settings-cancel').textContent = st ? 'Hủy' : 'Cancel';
    if ($('search-settings-save')) $('search-settings-save').textContent = st ? 'Lưu' : 'Save';
    if ($('btn-search-settings')) $('btn-search-settings').textContent = st ? '⌕ Công cụ tìm kiếm' : '⌕ Search engine';
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

  // The bridge iframe URL is an internal HTML viewport, not the website being visited.
  // Treating it as the active URL creates a recursive navigate -> /view -> blank loop.
  function isInternalBridgeViewUrl(raw) {
    try {
      const u = new URL(String(raw || ''), window.location.href);
      return u.origin === window.location.origin && /^\/api\/browser\/sessions\/[^/]+\/view\/?$/i.test(u.pathname);
    } catch (_) { return false; }
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

  function buildSearchUrl(query) {
    const encoded = encodeURIComponent(String(query || '').trim());
    const engine = String(state.searchEngine || 'bing').toLowerCase();
    if (engine === 'google') return 'https://www.google.com/search?q=' + encoded;
    if (engine === 'duckduckgo') return 'https://html.duckduckgo.com/html/?q=' + encoded;
    if (engine === 'brave') return 'https://search.brave.com/search?q=' + encoded;
    if (engine === 'custom') {
      const template = String(state.customSearchUrl || '').trim();
      if (/^https?:\/\//i.test(template) && /(?:\{query\}|%s)/i.test(template))
        return template.replace(/\{query\}/gi, encoded).replace(/%s/gi, encoded);
    }
    return 'https://www.bing.com/search?q=' + encoded;
  }

  function normalizeUrl(raw) {
    let s = String(raw || '').trim();
    if (!s) return '';
    if (/^about:/i.test(s) || /^javascript:/i.test(s) || /^data:/i.test(s)) return '';
    if (/^https?:\/\//i.test(s)) return s;
    if (/^\/\//.test(s)) return 'https:' + s;
    if (/^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/.*)?$/.test(s) || /^localhost(:\d+)?$/i.test(s)) return 'http://' + s;
    if (/^[\w.-]+\.[a-z]{2,}([/:].*)?$/i.test(s)) return 'https://' + s;
    return buildSearchUrl(s);
  }

  function showToast(message) {
    let el = document.getElementById('browser-toast');
    if (!el) { el = document.createElement('div'); el.id = 'browser-toast'; el.className = 'browser-toast'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); document.body.appendChild(el); }
    el.textContent = String(message || ''); el.hidden = false;
    clearTimeout(el._hideTimer); el._hideTimer = setTimeout(() => { el.hidden = true; }, 2600);
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


  

  async function checkAccessGate() {
    const gate = $('access-gate');
    if (!gate) return true;
    try {
      const r = await fetch('/api/access/status', { cache: 'no-store', credentials: 'same-origin' });
      const j = await r.json();
      if (!j || !j.required) {
        try { sessionStorage.removeItem('solo_access_required'); } catch (_) {}
        gate.hidden = true;
        gate.setAttribute('hidden', '');
        return true;
      }
      try { sessionStorage.setItem('solo_access_required', '1'); } catch (_) {}
      gate.hidden = false;
      gate.removeAttribute('hidden');
      const title = $('access-gate-title');
      const hint = $('access-gate-hint');
      const vi = state.lang === 'vi';
      if (title) title.textContent = vi ? 'Mật khẩu truy cập' : 'Access password';
      if (hint) hint.textContent = vi
        ? 'Nhập mật khẩu đã đặt khi khởi chạy app trên SoloHost.'
        : 'Enter the password you set when starting the app in SoloHost.';
      const input = $('access-gate-input');
      if (input) setTimeout(() => input.focus(), 50);
      return false;
    } catch (_) {
      // Network/status failure: keep gate visible if a password field was previously required
      try {
        if (sessionStorage.getItem('solo_access_required') === '1') {
          gate.hidden = false;
          gate.removeAttribute('hidden');
          return false;
        }
      } catch (__) {}
      gate.hidden = true;
      return true;
    }
  }

  function bindAccessGate() {
    const form = $('access-gate-form');
    if (!form || form._bound) return;
    form._bound = true;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('access-gate-input');
      const err = $('access-gate-error');
      const pwd = (input && input.value) || '';
      try {
        const r = await fetch('/api/access/login', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ password: String(pwd || '').trim() })
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.ok) {
          if (err) err.hidden = true;
          const gate = $('access-gate');
          if (gate) { gate.hidden = true; gate.setAttribute('hidden', ''); }
          return;
        }
        if (err) {
          err.hidden = false;
          err.textContent = (state.lang === 'vi') ? 'Mật khẩu không đúng.' : 'Incorrect password.';
        }
      } catch (ex) {
        if (err) {
          err.hidden = false;
          err.textContent = String(ex.message || ex);
        }
      }
    });
  }

  function hideSplash() {
    try {
      const el = document.getElementById('splash-screen');
      if (!el) return;
      el.classList.add('is-done');
      el.setAttribute('aria-hidden', 'true');
      el.style.opacity = '0';
      el.style.visibility = 'hidden';
      el.style.pointerEvents = 'none';
      el.style.display = 'none';
      setTimeout(function () { try { el.remove(); } catch (_) {} }, 400);
    } catch (_) {}
  }
  function startSplash() {
    try {
      const el = document.getElementById('splash-screen');
      if (!el) return;
      // Tap/click skips wait
      el.addEventListener('click', function(){ hideSplash(); checkAccessGate(); }, { once: true });
      // Hard timeout 5s — always dismiss
      setTimeout(function () { hideSplash(); checkAccessGate(); }, 5000);
      setTimeout(function () { hideSplash(); checkAccessGate(); }, 6500);
      setTimeout(function () { checkAccessGate(); }, 8000);
    } catch (_) {
      try { hideSplash(); } catch (__) {}
    }
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
      select.textContent = (tab.private ? '◉ ' : '') + (tab.title || hostLabel || (state.lang === 'vi' ? 'Tab mới' : 'New tab'));
      select.title = (tab.private ? (state.lang === 'vi' ? 'Tab riêng tư · ' : 'Private tab · ') : '') + (tab.url || select.textContent); select.addEventListener('click', () => switchTab(tab.id));
      const close = document.createElement('button'); close.type = 'button'; close.className = 'browser-tab-close'; close.textContent = '×'; close.title = state.lang === 'vi' ? 'Đóng tab' : 'Close tab';
      close.addEventListener('click', e => { e.stopPropagation(); closeTab(tab.id); });
      item.append(select, close); strip.appendChild(item);
    });
    try {
      // Persist only UI metadata, never Bridge session IDs or authentication tokens.
      const regularTabs = state.tabs.filter(t => !t.private).slice(-12).map(t => ({ id: t.id, title: t.title, url: t.url || '' }));
      const activeStored = regularTabs.some(t => t.id === state.activeTabId) ? state.activeTabId : (regularTabs[0] && regularTabs[0].id) || null;
      sessionStorage.setItem('solo_tabs_v1', JSON.stringify({ tabs: regularTabs, activeTabId: activeStored }));
    } catch (_) {}
    syncNavButtons();
  }
  function newTab(url, options) {
    options = options || {};
    if (state.tabs.length >= 12) {
      const disposable = state.tabs.find(t => t.id !== state.activeTabId && (t.private || !t.url));
      if (disposable) closeTab(disposable.id);
      else { showToast(state.lang === 'vi' ? 'Đã đạt giới hạn 12 tab. Hãy đóng một tab trước.' : '12-tab limit reached. Close a tab first.'); return null; }
    }
    const tab = { id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), title: options.private ? (state.lang === 'vi' ? 'Tab riêng tư' : 'Private tab') : (state.lang === 'vi' ? 'Tab mới' : 'New tab'), url: '', private: !!options.private, nav: null };
    state.tabs.push(tab); state.activeTabId = tab.id; renderTabs();
    if (url) navigate(url); else { state.url = ''; if (input) input.value = ''; if (btnOpen) btnOpen.href = '#'; if (frame) frame.src = 'about:blank'; showStart(); }
    return tab;
  }
  function switchTab(id) {
    const tab = state.tabs.find(t => t.id === id); if (!tab) return;
    state.activeTabId = id; state.url = tab.url || ''; renderTabs();
    if (input) input.value = state.url; if (btnOpen) btnOpen.href = state.url || '#';
    // Restore cached Bridge view only — never re-navigate Chromium for a tab switch.
    const nav = ensureTabNav(tab);
    const view = nav && nav.bridge && bridgeViewUrl(nav.bridge);
    if (state.url && view) {
      if (frame) {
        frame.setAttribute('sandbox', 'allow-same-origin allow-forms allow-scripts');
        if (frame.getAttribute('data-sh-view') !== view) {
          frame.src = view;
          frame.setAttribute('data-sh-view', view);
        }
      }
      hideStart();
    } else if (state.url) {
      // Session missing: one deliberate load, not a continuous loop
      navigate(state.url, { force: true, skipHistory: true });
    } else {
      if (frame) { frame.src = 'about:blank'; frame.removeAttribute('data-sh-view'); }
      showStart();
    }
  }
  function destroyTabSession(tab) {
    const b = tab && tab.nav && tab.nav.bridge;
    if (!b || !b.sessionId || !b.token) return;
    fetch('/api/browser/sessions/' + encodeURIComponent(b.sessionId) + '?token=' + encodeURIComponent(b.token), { method: 'DELETE' }).catch(() => {});
  }
  function closeTab(id) {
    const index = state.tabs.findIndex(t => t.id === id); if (index < 0) return;
    const tab = state.tabs[index]; destroyTabSession(tab);
    const wasActive = state.activeTabId === id; state.tabs.splice(index, 1);
    if (!state.tabs.length) { newTab(); return; }
    if (wasActive) switchTab(state.tabs[Math.min(index, state.tabs.length - 1)].id); else renderTabs();
  }
  async function saveVisit(url) {
    if (!url || !/^https?:/i.test(url)) return;
    const tab = getActiveTab(); if (tab) { tab.url = url; try { tab.title = new URL(url).hostname; } catch (_) {} renderTabs(); }
    if (tab && tab.private) return; // private tabs do not write browsing history
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


  function isLocalSoloHostUrl(url) {
    try {
      const u = new URL(url);
      const h = u.hostname.toLowerCase();
      return h === '127.0.0.1' || h === 'localhost' || h === '::1';
    } catch { return false; }
  }

  async function navigate(raw, opts) {
    // mark: loopback SoloHost apps use same-origin proxy (runs on Pi host)

    opts = opts || {};
    let url = normalizeUrl(raw);
    if (!url || !frame) return;
    if (isInternalBridgeViewUrl(url)) {
      clientLog('warn', 'navigate_internal_view_blocked', { url: url });
      const active = getActiveTab();
      const safeUrl = (active && active.url && !isInternalBridgeViewUrl(active.url)) ? active.url : state.url;
      if (safeUrl && !isInternalBridgeViewUrl(safeUrl)) applyUrlToUi(safeUrl);
      return;
    }
    // Keep explicit URLs untouched; bare search text uses Bing as the default engine.
    url = toPlayableUrl(url);

    const now = Date.now();
    if (!opts.force && state.url === url && now - (state.lastNavAt || 0) < 4000) {
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
      const externalTarget = googleExternalTarget(url);
      result = loadViaExternal(externalTarget, /accounts\.google\.com/i.test(url) ? 'google_auth_policy_external_session' : 'site_policy_external');
    } else if (preferred === MODE.DIRECT) {
      result = loadViaDirect(url);
      if (!result.ok) result = loadViaProxy(url);
    } else if (preferred === MODE.ENGINE) {
      // Fast fail: if WebKit known down, skip bridge entirely
      result = await tryEngine();
      if (!result.ok) {
        const reason = result.reason || 'engine_failed';
        clientLog('warn', 'navigate_engine_fallback', { url, reason });
        if (isLoginPath(url)) {
          result = loadViaExternal(url, 'login_requires_full_browser_context:' + reason);
        } else {
          result = loadViaProxy(url);
          if (result.ok) {
            result.mode = MODE.PROXY;
            result.reason = 'fallback_from_engine:' + reason;
          }
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

    syncNavButtons();
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

  // Proxy/Bridge frames postMessage so clicks never open the host browser (Opera/Chrome).
  window.addEventListener('message', (ev) => {
    try {
      const d = ev && ev.data;
      if (!d || !d.url) return;
      if (d.type !== 'solohost-navigate' && d.type !== 'solohost-nav') return;
      const abs = typeof resolveSoloHref === 'function' ? resolveSoloHref(d.url, state.url) : d.url;
      if (!abs || !/^https?:/i.test(abs)) return;
      clientLog('info', 'nav.postmessage', { url: abs, newTab: !!d.newTab });
      if (d.newTab) newTab(abs);
      else navigate(abs, { force: true });
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
        if (href && isInternalBridgeViewUrl(href)) {
          // This is only the same-origin sanitized viewport; state.url must remain the real target URL.
          return;
        }
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

  if ($('btn-novnc')) $('btn-novnc').addEventListener('click', async () => {
    const vi = state.lang === 'vi';
    try {
      // Lazy-start desktop only when user needs login/CAPTCHA (Bridge stays primary)
      try {
        await fetch('/api/novnc/start', { method: 'POST', credentials: 'same-origin' });
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 800));
      const response = await fetch('/api/novnc/status', { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json();
      if (!data || !data.enabled) {
        const reason = data && data.reason;
        if (reason === 'packages_missing') {
          alert(vi
            ? 'Desktop đăng nhập chưa có trong image (build CI). Duyệt web vẫn dùng Bridge. Build WITH_NOVNC=1 nếu cần đăng nhập tay.'
            : 'Login desktop is not in this image (CI build). Browsing still uses Bridge. Rebuild WITH_NOVNC=1 for manual login.');
        } else {
          alert(vi
            ? 'Desktop đăng nhập chưa bật. Duyệt thường vẫn qua Bridge.'
            : 'Login desktop is off. Normal browsing still uses Bridge.');
        }
        return;
      }
      const url = data.url || '/novnc/vnc.html?autoconnect=1&resize=remote&path=websockify';
      window.open(url, 'solohost-novnc', 'noopener,noreferrer');
    } catch (e) {
      alert(vi ? 'Không mở được desktop đăng nhập. Tiếp tục dùng Bridge hoặc Open ↗.' : 'Cannot open login desktop. Continue with Bridge or Open ↗.');
    }
  });

  if ($('btn-new-tab')) $('btn-new-tab').addEventListener('click', () => newTab());
  if ($('btn-bookmark')) $('btn-bookmark').addEventListener('click', addCurrentBookmark);
  if ($('btn-library')) $('btn-library').addEventListener('click', () => openLibrary('bookmarks'));
  if ($('btn-add-pl')) $('btn-add-pl').addEventListener('click', () => { try { closeSettings && closeSettings(); } catch(_){} addCurrentUrlToPlaylist(); });
  if ($('library-close')) $('library-close').addEventListener('click', () => { $('library-overlay').hidden = true; });
  document.querySelectorAll('[data-library]').forEach(b => b.addEventListener('click', () => openLibrary(b.dataset.library)));
  if ($('history-clear')) $('history-clear').addEventListener('click', async () => {
    if (state.libraryMode !== 'history') return;
    try { await fetch('/api/browser/history', { method: 'DELETE' }); openLibrary('history'); } catch (_) {}
  });
    function openPrivateTab(startUrl) {
    try {
      const tab = newTab(startUrl || '', { private: true });
      if (!tab) {
        clientLog('warn', 'tab.private_new_failed', { reason: 'newTab_null' });
        return null;
      }
      state.activeTabId = tab.id;
      state.url = startUrl || '';
      if (input) input.value = startUrl || '';
      if (frame) {
        try { frame.removeAttribute('srcdoc'); frame.src = 'about:blank'; } catch (_) {}
      }
      renderTabs();
      if (startUrl) navigate(startUrl, { force: true });
      else showStart();
      clientLog('info', 'tab.private_new', { id: tab.id });
      return tab;
    } catch (e) {
      clientLog('error', 'tab.private_new_error', { error: String(e && e.message || e).slice(0, 160) });
      return null;
    }
  }
  const privBtn = $('btn-private-tab') || document.getElementById('btn-private-tab');
  if (privBtn && !privBtn.dataset.privateBound) {
    privBtn.dataset.privateBound = '1';
    privBtn.addEventListener('click', function (ev) {
      try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {}
      openPrivateTab('');
    }, true);
  }
  // Re-bind after short delay (mobile WebView late paint)
  setTimeout(function () {
    const b = document.getElementById('btn-private-tab');
    if (b && !b.dataset.privateBound) {
      b.dataset.privateBound = '1';
      b.addEventListener('click', function (ev) {
        try { ev.preventDefault(); ev.stopPropagation(); } catch (_) {}
        openPrivateTab('');
      }, true);
    }
  }, 400);

  if ($('library-overlay')) $('library-overlay').addEventListener('click', e => { if (e.target === $('library-overlay')) $('library-overlay').hidden = true; });

  const form = $('nav-form');
  if (form) form.addEventListener('submit', (e) => {
    e.preventDefault();
    navigate(input && input.value);
  });
  if ($('btn-back')) $('btn-back').addEventListener('click', (e) => {
    e.preventDefault();
    goBack();
  });
  document.addEventListener('keydown', (e) => {
    const target = e.target; const typing = target && (target.matches('input,textarea,select') || target.isContentEditable);
    if ((e.altKey && e.key === 'ArrowLeft') || (e.key === 'Backspace' && !typing) || e.key === 'BrowserBack') { e.preventDefault(); goBack(); }
    else if ((e.altKey && e.key === 'ArrowRight') || e.key === 'BrowserForward') { e.preventDefault(); goForward(); }
  });
  if ($('btn-fwd')) $('btn-fwd').addEventListener('click', (e) => {
    e.preventDefault();
    goForward();
  });
  if ($('btn-reload')) $('btn-reload').addEventListener('click', (e) => {
    e.preventDefault();
    if (!state.url) return;
    navigate(state.url, { skipHistory: true, force: true });
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
    try { localStorage.setItem('solo_lang_manual', '1'); } catch (_) {}
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
    if (frame) { try { frame.removeAttribute('srcdoc'); frame.src = 'about:blank'; } catch (_) {} }
    if (btnOpen) btnOpen.href = '#';
    showStart();
    const active = getActiveTab();
    if (active) {
      active.url = '';
      active.title = state.lang === 'vi' ? 'Tab mới' : 'New tab';
      const nav = ensureTabNav(active);
      if (nav) nav.index = -1; // keep stack so Forward can restore
      renderTabs();
    }
  });

  // Default search engine settings. Custom templates only accept HTTP(S) URLs and encoded query placeholders.
  function closeSearchSettings() { const overlay = $('search-settings-overlay'); if (overlay) overlay.hidden = true; }
  function openSearchSettings() {
    const overlay = $('search-settings-overlay'); if (!overlay) return;
    if ($('search-engine-select')) $('search-engine-select').value = state.searchEngine || 'bing';
    if ($('search-engine-custom')) $('search-engine-custom').value = state.customSearchUrl || '';
    if ($('search-engine-status')) $('search-engine-status').textContent = '';
    overlay.hidden = false; closeSettings();
  }
  if ($('btn-search-settings')) $('btn-search-settings').addEventListener('click', openSearchSettings);
  ['search-settings-close','search-settings-cancel'].forEach(id => { if ($(id)) $(id).addEventListener('click', closeSearchSettings); });
  if ($('search-settings-overlay')) $('search-settings-overlay').addEventListener('click', ev => { if (ev.target === $('search-settings-overlay')) closeSearchSettings(); });
  if ($('search-settings-save')) $('search-settings-save').addEventListener('click', () => {
    const engine = String(($('search-engine-select') || {}).value || 'bing').toLowerCase();
    const template = String(($('search-engine-custom') || {}).value || '').trim();
    const status = $('search-engine-status');
    if (engine === 'custom') {
      try {
        const parsed = new URL(template.replace(/\{query\}|%s/gi, 'test-query'));
        if (!['http:', 'https:'].includes(parsed.protocol) || !/(?:\{query\}|%s)/i.test(template)) throw new Error('invalid');
      } catch (_) {
        if (status) status.textContent = state.lang === 'vi' ? 'URL phải dùng HTTP(S) và chứa {query} hoặc %s.' : 'URL must use HTTP(S) and contain {query} or %s.';
        return;
      }
    }
    state.searchEngine = ['bing','google','duckduckgo','brave','custom'].includes(engine) ? engine : 'bing';
    state.customSearchUrl = template;
    try { localStorage.setItem('solo_search_engine', state.searchEngine); localStorage.setItem('solo_search_custom_url', template); } catch (_) {}
    if (status) status.textContent = state.lang === 'vi' ? 'Đã lưu công cụ tìm kiếm.' : 'Search engine saved.';
    clientLog('info', 'browser.search_engine_saved', { detail: state.searchEngine });
    setTimeout(closeSearchSettings, 500);
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
  if ($('btn-static-capture')) $('btn-static-capture').addEventListener('click', () => { window.location.href = '/static-capture.html'; });
  if ($('btn-menu')) $('btn-menu').addEventListener('click', () => {
    const m = $('settings-menu');
    if (m && m.hidden) openSettings(); else closeSettings();
  });
  if ($('settings-backdrop')) $('settings-backdrop').addEventListener('click', closeSettings);
  ['btn-theme','btn-library','btn-reader','btn-summary','btn-static-capture','btn-translate','btn-lang'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('click', () => setTimeout(closeSettings, 0));
  });

  applyTheme();
  applyLang();
  localeSyncPromise = syncRuntimeLocale();
  startScheduledTasks();
  try {
    const saved = JSON.parse(sessionStorage.getItem('solo_tabs_v1') || 'null');
    if (saved && Array.isArray(saved.tabs) && saved.tabs.length) { state.tabs = saved.tabs.slice(0, 12); state.activeTabId = saved.activeTabId; if (!getActiveTab()) state.activeTabId = state.tabs[0].id; }
  } catch (_) {}
  if (!state.tabs.length) { state.tabs = [{ id: 't' + Date.now().toString(36), title: state.lang === 'vi' ? 'Tab mới' : 'New tab', url: '' }]; state.activeTabId = state.tabs[0].id; }
  renderTabs();
  syncNavButtons();
  startSplash();
  showStart();
  try { bindBridgeViewportHelpers(); } catch (_) {}
  try { bindAccessGate(); } catch (_) {}

  try {
    const q = new URLSearchParams(location.search).get('url');
    if (q) navigate(q);
    else { const active = getActiveTab(); if (active && active.url) navigate(active.url); }
  } catch (_) {}


  /* —— Home: playlists, scripts, SoloHost apps (no AI required for scripts) —— */
  const homeLib = {
    playlists: [],
    scripts: [],
    apps: [],
    activePlaylistId: null,
    playIndex: 0,
    musicMode: false,
    shuffle: (typeof localStorage !== 'undefined' && localStorage.getItem('solo_music_shuffle') === '1'),
    repeatMode: (typeof localStorage !== 'undefined' && ['off','all','one'].includes(localStorage.getItem('solo_music_repeat')) ? localStorage.getItem('solo_music_repeat') : 'off'),
    isPlaying: false,
    scriptRun: null
  };

  async function libFetch(path, opts) {
    try {
      const r = await fetch(path, opts);
      return await r.json();
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  async function refreshHomeLibrary() {
    const [pl, sc, ap] = await Promise.all([
      libFetch('/api/library/playlists'),
      libFetch('/api/library/scripts'),
      libFetch('/api/library/apps')
    ]);
    if (pl && pl.ok) homeLib.playlists = pl.playlists || [];
    if (sc && sc.ok) homeLib.scripts = sc.scripts || [];
    if (ap && ap.ok) homeLib.apps = ap.apps || [];
    if (!homeLib.activePlaylistId && homeLib.playlists[0]) homeLib.activePlaylistId = homeLib.playlists[0].id;
    renderPlaylists();
    renderScripts();
    renderApps();
    updateHomeCounts();
  }

  function updateHomeCounts() {
    const plN = (homeLib.playlists || []).reduce((n, p) => n + ((p.items && p.items.length) || 0), 0);
    const scN = (homeLib.scripts || []).length;
    const apN = (homeLib.apps || []).length;
    const set = (id, v) => { const el = $(id); if (el) el.textContent = String(v); };
    set('pl-count', plN);
    set('sc-count', scN);
    set('app-count', apN);
  }

  function closeHomePanels() {
    ['panel-playlists', 'panel-scripts', 'panel-apps'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.hidden = true;
        el.setAttribute('hidden', '');
      }
    });
    const bd = document.getElementById('home-panel-backdrop');
    if (bd) { bd.hidden = true; bd.setAttribute('hidden', ''); }
  }

  function openHomePanel(panelId) {
    closeHomePanels();
    const el = document.getElementById(panelId);
    if (!el) {
      console.warn('[home] panel missing', panelId);
      return;
    }
    el.hidden = false;
    el.removeAttribute('hidden');
    const bd = document.getElementById('home-panel-backdrop');
    if (bd) { bd.hidden = false; bd.removeAttribute('hidden'); }
    // ensure lists painted
    try {
      if (panelId === 'panel-playlists') renderPlaylists();
      if (panelId === 'panel-scripts') renderScripts();
      if (panelId === 'panel-apps') renderApps();
    } catch (e) { console.warn(e); }
  }


  function renderPlaylists() {
    const box = $('pl-list');
    if (!box) return;
    box.innerHTML = '';
    if (!homeLib.playlists.length) {
      box.innerHTML = '<div class="home-hint">' + (state.lang === 'vi' ? 'Chưa có danh sách. Bấm ＋ để tạo.' : 'No playlists yet. Tap ＋ to create.') + '</div>';
      if ($('playlist-player-frame')) $('playlist-player-frame').src = 'about:blank';
      return;
    }
    homeLib.playlists.forEach((pl) => {
      const row = document.createElement('div');
      row.className = 'home-item';
      if (pl.id === homeLib.activePlaylistId) { row.style.fontWeight = '600'; row.classList.add('active-playlist'); }
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = pl.title + ' (' + (pl.items && pl.items.length || 0) + ')';
      label.onclick = () => { homeLib.activePlaylistId = pl.id; homeLib.playIndex = 0; renderPlaylists(); };
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'icon-btn tiny'; del.textContent = '×';
      del.title = state.lang === 'vi' ? 'Xóa' : 'Delete';
      del.onclick = async () => { await libFetch('/api/library/playlists/' + encodeURIComponent(pl.id), { method: 'DELETE' }); await refreshHomeLibrary(); };
      row.appendChild(label); row.appendChild(del);
      box.appendChild(row);
      (pl.items || []).forEach((it, idx) => {
        const ir = document.createElement('div');
        ir.className = 'home-item playlist-track' + (pl.id === homeLib.activePlaylistId && idx === homeLib.playIndex ? ' is-current' : '');
        ir.style.paddingLeft = '0.75rem';
        const lab = document.createElement('span');
        lab.className = 'label';
        lab.textContent = (it.source || 'web') + ' · ' + (it.title || it.url);
        lab.onclick = () => { homeLib.activePlaylistId = pl.id; homeLib.playIndex = idx; playPlaylistItem(); };
        const rm = document.createElement('button');
        rm.type = 'button'; rm.className = 'icon-btn tiny'; rm.textContent = '×';
        rm.onclick = async () => {
          await libFetch('/api/library/playlists/' + encodeURIComponent(pl.id) + '/items/' + encodeURIComponent(it.id), { method: 'DELETE' });
          await refreshHomeLibrary();
        };
        ir.appendChild(lab); ir.appendChild(rm);
        box.appendChild(ir);
      });
    });
  }

  function activePlaylist() {
    return homeLib.playlists.find((p) => p.id === homeLib.activePlaylistId) || homeLib.playlists[0];
  }

  function getVideoEmbedUrl(raw) {
    try {
      const u = new URL(String(raw || '').trim()); const h = u.hostname.toLowerCase().replace(/^www\./, '');
      let id = '';
      if (h === 'youtu.be') id = u.pathname.split('/').filter(Boolean)[0] || '';
      else if (h.endsWith('youtube.com') || h === 'youtube-nocookie.com') {
        if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
        else { const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([\w-]{6,15})/); if (m) id = m[1]; }
      }
      if (/^[\w-]{6,15}$/.test(id)) return 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(id) + '?autoplay=1&rel=0&playsinline=1';
      if (h === 'vimeo.com') { const m = u.pathname.match(/\/(\d+)/); if (m) return 'https://player.vimeo.com/video/' + m[1] + '?autoplay=1'; }
      if (h === 'tiktok.com') { const m = u.pathname.match(/\/video\/(\d+)/); if (m) return 'https://www.tiktok.com/player/v1/' + m[1] + '?autoplay=1'; }
      return null;
    } catch (_) { return null; }
  }

  function musicPlayerFrame() {
    // Prefer background dock so audio continues when home panel is closed
    return $('bg-music-frame') || $('playlist-player-frame');
  }

  function showMusicDock(on, titleText) {
    const dock = $('bg-music-dock');
    if (!dock) return;
    if (on) {
      dock.hidden = false;
      dock.removeAttribute('hidden');
      dock.classList.toggle('is-expanded', !!homeLib.musicMode);
      if ($('bg-music-title') && titleText) $('bg-music-title').textContent = titleText;
      if ($('bg-music-play')) $('bg-music-play').textContent = homeLib.isPlaying ? 'Ⅱ' : '▶';
    } else {
      dock.hidden = true;
      dock.setAttribute('hidden', '');
      const bg = $('bg-music-frame');
      if (bg) bg.src = 'about:blank';
      const audio = $('bg-music-audio');
      if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); audio.hidden = true; }
    }
  }

  function playPlaylistItem() {
    const pl = activePlaylist();
    const player = musicPlayerFrame();
    const panelPlayer = $('playlist-player-frame');
    const title = $('playlist-now-title'); const hint = $('playlist-player-hint');
    if (!pl || !pl.items || !pl.items.length) {
      if (player) player.src = 'about:blank';
      if (panelPlayer && panelPlayer !== player) panelPlayer.src = 'about:blank';
      homeLib.isPlaying = false; updateMusicControls(); showMusicDock(false);
      if (title) title.textContent = state.lang === 'vi' ? 'Chọn video để phát' : 'Choose a video';
      return;
    }
    homeLib.playIndex = ((homeLib.playIndex % pl.items.length) + pl.items.length) % pl.items.length;
    const it = pl.items[homeLib.playIndex];
    if (!it) return;
    const embed = getVideoEmbedUrl(it.url);
    const audio = $('bg-music-audio');
    if (title) { title.textContent = it.title || it.url; title.dataset.userTitle = '1'; }
    if (isDirectAudioUrl(it.url) && audio) {
      if (player) player.src = 'about:blank';
      if (panelPlayer && panelPlayer !== player) panelPlayer.src = 'about:blank';
      audio.hidden = false;
      audio.src = new URL(it.url).toString();
      audio.load();
      homeLib.isPlaying = true; updateMusicControls();
      showMusicDock(true, it.title || it.url);
      if (hint) hint.textContent = state.lang === 'vi'
        ? 'Âm thanh trực tiếp đang phát trên thiết bị của bạn; nguồn phải là tệp audio HTTP(S) công khai và được trình duyệt hỗ trợ.'
        : 'Direct audio plays in your device browser; the source must be a public HTTP(S) audio file supported by the browser.';
      const playAttempt = audio.play();
      if (playAttempt && typeof playAttempt.catch === 'function') playAttempt.catch(() => {
        homeLib.isPlaying = false; updateMusicControls();
        if (hint) hint.textContent = state.lang === 'vi' ? 'Nhấn Phát trên trình phát âm thanh để bắt đầu; trình duyệt có thể chặn tự phát.' : 'Press Play on the audio control to start; browser autoplay may be blocked.';
      });
      clientLog('info', 'playlist.direct_audio_play', { source: it.source || 'direct_audio', playback: 'client_native' });
    } else if (embed && player) {
      if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); audio.hidden = true; }
      const src = withPlayerApi(embed);
      player.src = src;
      // Keep panel preview in sync if open
      if (panelPlayer && panelPlayer !== player) panelPlayer.src = src;
      homeLib.isPlaying = true; updateMusicControls();
      showMusicDock(true, it.title || it.url);
      if (hint) hint.textContent = state.lang === 'vi'
        ? 'Đang phát nền — thu cửa sổ app vẫn nghe được (trình duyệt cho phép).'
        : 'Background play — keeps playing if the app window stays open.';
      clientLog('info', 'playlist.embed_play', { source: it.source || 'video', background: true });
    } else {
      if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); audio.hidden = true; }
      if (player) player.src = 'about:blank';
      homeLib.isPlaying = false; updateMusicControls(); showMusicDock(false);
      if (hint) hint.textContent = state.lang === 'vi' ? 'Nguồn này chưa có trình nhúng chính thức được hỗ trợ. Hãy thêm liên kết YouTube, Vimeo hoặc TikTok.' : 'This source has no supported official embed. Add a YouTube, Vimeo, or TikTok link.';
    }
  }

  function withPlayerApi(url) {
    try { const u = new URL(url); if (/youtube-nocookie\.com$/.test(u.hostname)) { u.searchParams.set('enablejsapi', '1'); u.searchParams.set('origin', location.origin); } return u.toString(); } catch (_) { return url; }
  }
  function updateMusicControls() {
    const play = $('btn-pl-play'), shuffle = $('btn-pl-shuffle'), repeat = $('btn-pl-repeat');
    if (play) { play.textContent = homeLib.isPlaying ? 'Ⅱ' : '▶'; play.title = state.lang === 'vi' ? (homeLib.isPlaying ? 'Tạm dừng' : 'Phát') : (homeLib.isPlaying ? 'Pause' : 'Play'); play.setAttribute('aria-label', play.title); }
    const dockPlay = $('bg-music-play'); if (dockPlay) { dockPlay.textContent = homeLib.isPlaying ? 'Ⅱ' : '▶'; dockPlay.title = state.lang === 'vi' ? (homeLib.isPlaying ? 'Tạm dừng' : 'Phát') : (homeLib.isPlaying ? 'Pause' : 'Play'); }
    if (shuffle) { shuffle.classList.toggle('active', homeLib.shuffle); shuffle.setAttribute('aria-pressed', homeLib.shuffle ? 'true' : 'false'); shuffle.title = (state.lang === 'vi' ? 'Trộn bài: ' : 'Shuffle: ') + (homeLib.shuffle ? (state.lang === 'vi' ? 'Bật' : 'On') : (state.lang === 'vi' ? 'Tắt' : 'Off')); }
    if (repeat) { const labels = { off: state.lang === 'vi' ? 'Tắt lặp' : 'Repeat off', all: state.lang === 'vi' ? 'Lặp tất cả' : 'Repeat all', one: state.lang === 'vi' ? 'Lặp một bài' : 'Repeat one' }; repeat.classList.toggle('active', homeLib.repeatMode !== 'off'); repeat.textContent = homeLib.repeatMode === 'one' ? '🔂' : '🔁'; repeat.title = labels[homeLib.repeatMode] || labels.off; repeat.setAttribute('aria-pressed', homeLib.repeatMode !== 'off' ? 'true' : 'false'); }
  }
  function sendPlayerCommand(command, args = {}) {
    const f = musicPlayerFrame(); if (!f || !f.contentWindow) return false;
    try { const u = new URL(f.src); if (/youtube-nocookie\.com$/.test(u.hostname)) { f.contentWindow.postMessage(JSON.stringify({ event: 'command', func: command, args }), 'https://www.youtube-nocookie.com'); return true; }
      if (/player\.vimeo\.com$/.test(u.hostname)) { f.contentWindow.postMessage({ method: command === 'playVideo' ? 'play' : command === 'pauseVideo' ? 'pause' : 'setCurrentTime', value: args[0] }, 'https://player.vimeo.com'); return true; }
    } catch (_) {} return false;
  }
  function advancePlaylist(direction = 1, automatic = false) {
    const pl = activePlaylist(); if (!pl || !Array.isArray(pl.items) || !pl.items.length) return;
    if (automatic && homeLib.repeatMode === 'one') { playPlaylistItem(); return; }
    if (homeLib.shuffle && pl.items.length > 1) { let next = homeLib.playIndex; while (next === homeLib.playIndex) next = Math.floor(Math.random() * pl.items.length); homeLib.playIndex = next; }
    else { let next = homeLib.playIndex + direction; if (next >= pl.items.length) { if (automatic && homeLib.repeatMode !== 'all') { homeLib.isPlaying = false; updateMusicControls(); return; } next = 0; } if (next < 0) next = pl.items.length - 1; homeLib.playIndex = next; }
    playPlaylistItem(); renderPlaylists();
  }
  const directAudio = $('bg-music-audio');
  if (directAudio) {
    directAudio.addEventListener('play', () => { homeLib.isPlaying = true; updateMusicControls(); });
    directAudio.addEventListener('pause', () => { if (!directAudio.ended) homeLib.isPlaying = false; updateMusicControls(); });
    directAudio.addEventListener('ended', () => advancePlaylist(1, true));
    directAudio.addEventListener('error', () => {
      homeLib.isPlaying = false; updateMusicControls();
      const hint = $('playlist-player-hint');
      if (hint) hint.textContent = state.lang === 'vi' ? 'Không phát được tệp audio. Kiểm tra liên kết, định dạng, quyền truy cập hoặc CORS/chính sách máy chủ nguồn.' : 'Audio could not be played. Check the URL, format, access permissions, and source-server policy.';
      clientLog('warn', 'playlist.direct_audio_error', { code: directAudio.error ? directAudio.error.code : 0 });
    });
  }
  if ($('bg-music-play')) $('bg-music-play').addEventListener('click', () => {
    const audio = $('bg-music-audio');
    if (audio && !audio.hidden && audio.src) {
      if (audio.paused) audio.play().catch(() => {}); else audio.pause();
    } else if (homeLib.isPlaying) { if (!sendPlayerCommand('pauseVideo')) { const f = musicPlayerFrame(); if (f) f.src = 'about:blank'; homeLib.isPlaying = false; } }
    else playPlaylistItem();
    updateMusicControls();
  });
  if ($('bg-music-next')) $('bg-music-next').addEventListener('click', () => advancePlaylist(1, false));
  if ($('bg-music-prev')) $('bg-music-prev').addEventListener('click', () => advancePlaylist(-1, false));
  if ($('bg-music-close')) $('bg-music-close').addEventListener('click', () => { const audio = $('bg-music-audio'); if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); audio.hidden = true; } showMusicDock(false); homeLib.isPlaying = false; updateMusicControls(); });
  const musicFrame = $('playlist-player-frame');
  if (musicFrame) musicFrame.addEventListener('load', () => {
    try { const u = new URL(musicFrame.src); if (/youtube-nocookie\.com$/.test(u.hostname)) musicFrame.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'addEventListener', args: ['onStateChange'] }), 'https://www.youtube-nocookie.com'); } catch (_) {}
  });
  window.addEventListener('message', (event) => {
    if (!['https://www.youtube-nocookie.com', 'https://www.youtube.com', 'https://player.vimeo.com'].includes(event.origin)) return;
    let data = event.data; try { if (typeof data === 'string') data = JSON.parse(data); } catch (_) { return; }
    // YouTube IFrame API reports state 0 when a video ends. Vimeo sends an `ended` event.
    if (data && (data.event === 'ended' || data.info === 0 || data.info === 'ended' || (data.info && data.info.playerState === 0))) advancePlaylist(1, true);
  });

  function renderScripts() {
    const box = $('sc-list');
    if (!box) return;
    box.innerHTML = '';
    (homeLib.scripts || []).forEach((sc) => {
      const row = document.createElement('div');
      row.className = 'home-item';
      const lab = document.createElement('span');
      lab.className = 'label';
      const nm = (state.lang === 'vi' && sc.nameVi) ? sc.nameVi : (sc.name || sc.id);
      lab.textContent = (sc.active === false ? 'Ⅱ ' : (sc.sample ? '◎ ' : '✦ ')) + nm;
      lab.title = (sc.sample
        ? (state.lang === 'vi' ? 'Mẫu · không cần AI' : 'Sample · no AI')
        : (state.lang === 'vi' ? 'Trợ lý AI' : 'AI assistant')) + ' — ' +
        ((state.lang === 'vi' && sc.descriptionVi) ? sc.descriptionVi : (sc.description || ''));
      const run = document.createElement('button');
      run.type = 'button'; run.className = 'chip'; run.textContent = '▶';
      run.title = state.lang === 'vi' ? 'Chạy' : 'Run';
      run.onclick = () => { runScript(sc); }; 
      const stop = document.createElement('button');
      stop.type = 'button'; stop.className = 'chip'; stop.textContent = sc.active === false ? '▶' : 'Ⅱ';
      stop.title = sc.active === false ? (state.lang === 'vi' ? 'Bật nhiệm vụ' : 'Enable task') : (state.lang === 'vi' ? 'Tạm dừng nhiệm vụ' : 'Pause task');
      stop.onclick = async () => { await libFetch('/api/library/scripts/' + encodeURIComponent(sc.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: sc.active === false }) }); await refreshHomeLibrary(); };
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'icon-btn tiny'; del.textContent = '×';
      del.onclick = async () => { await libFetch('/api/library/scripts/' + encodeURIComponent(sc.id), { method: 'DELETE' }); await refreshHomeLibrary(); };
      row.appendChild(lab); row.appendChild(run); row.appendChild(stop); row.appendChild(del);
      box.appendChild(row);
    });
  }

  function parseHHMM(s) {
    const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return { h: Number(m[1]), min: Number(m[2]) };
  }

  function msUntilTime(hhmm) {
    const t = parseHHMM(hhmm);
    if (!t) return 0;
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), t.h, t.min, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    return target - now;
  }

  function stopScript() {
    if (homeLib.scriptRun && homeLib.scriptRun.timers) {
      homeLib.scriptRun.timers.forEach((id) => clearTimeout(id));
    }
    homeLib.scriptRun = null;
  }

  function runScriptLocal(sc) {
    stopScript();
    const steps = (sc && sc.steps) || [];
    homeLib.scriptRun = { id: sc.id, timers: [], step: 0 };
    const run = homeLib.scriptRun;
    let delay = 0;
    steps.forEach((step) => {
      if (step.type === 'waitUntil' && step.time) {
        delay = msUntilTime(step.time);
      } else if (step.type === 'waitMs') {
        delay += Math.max(0, Number(step.ms) || 0);
      } else if (step.type === 'navigate' && step.url) {
        const d = delay;
        const url = step.url;
        const tid = setTimeout(() => {
          if (!homeLib.scriptRun || homeLib.scriptRun.id !== sc.id) return;
          if (url && url !== 'about:blank') navigate(url);
        }, d);
        run.timers.push(tid);
      } else if (step.type === 'stopAt' && step.time) {
        const d = msUntilTime(step.time);
        const tid = setTimeout(() => {
          stopScript();
          showStart();
        }, d);
        run.timers.push(tid);
      } else if (step.type === 'repeatEveryMs' && step.ms > 0) {
        const period = Math.max(60000, Number(step.ms) || 60000);
        // Re-run navigate steps on interval (AI Action / local)
        const navSteps = steps.filter((s) => s.type === 'navigate' && s.url);
        const tid = setInterval(() => {
          if (!homeLib.scriptRun || homeLib.scriptRun.id !== sc.id) return;
          navSteps.forEach((s) => { try { navigate(s.url); } catch (_) {} });
        }, period);
        run.timers.push(tid);
      }
    });
  }

  async function runScriptWithAi(sc) {
    // Prefer backend agent / AI action when available; fall back to local steps
    try {
      const task = (state.lang === 'vi' ? (sc.nameVi || sc.name) : sc.name) +
        ': ' + ((state.lang === 'vi' ? sc.descriptionVi : sc.description) || '') +
        ' Steps: ' + JSON.stringify(sc.steps || []).slice(0, 800);
      const r = await fetch('/api/browser/agent/step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: task,
          lang: state.lang || 'en',
          context: { scriptId: sc.id, steps: sc.steps, schedule: sc.schedule, intervalMin: sc.intervalMin, task: "schedule_or_repeat" }
        })
      });
      const j = await r.json().catch(() => ({}));
      if (j && j.ok && j.action && j.action.type === 'navigate' && j.action.url) {
        navigate(j.action.url);
        return;
      }
      if (j && j.ok && j.client && j.client.type === 'open_url' && j.client.url) {
        navigate(j.client.url);
        return;
      }
      // If AI cannot act, still run local steps when present
      if (sc.steps && sc.steps.length) return runScriptLocal(sc);
      alert(state.lang === 'vi'
        ? 'Trợ lý AI chưa sẵn sàng. Thêm bước điều hướng hoặc cấu hình AI trong Settings.'
        : 'AI assistant not ready. Add navigation steps or configure AI in Settings.');
    } catch (_) {
      if (sc.steps && sc.steps.length) runScriptLocal(sc);
    }
  }

  function runScript(sc) {
    if (!sc) return;
    // Sample templates: always local (no AI required)
    if (sc.sample) return runScriptLocal(sc);
    // User scripts: AI Action first, local fallback
    return runScriptWithAi(sc);
  }

  function renderApps() {
    const box = $('app-list');
    if (!box) return;
    box.innerHTML = '';
    if (!homeLib.apps.length) {
      box.innerHTML = '<div class="home-hint">' + (state.lang === 'vi' ? 'Thêm app local: http://127.0.0.1:PORT' : 'Add local app: http://127.0.0.1:PORT') + '</div>';
      return;
    }
    homeLib.apps.forEach((a) => {
      const row = document.createElement('div');
      row.className = 'home-item';
      const lab = document.createElement('span');
      lab.className = 'label';
      lab.textContent = a.name + ' · ' + a.url;
      lab.onclick = () => navigate(a.url);
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'icon-btn tiny'; del.textContent = '×';
      del.onclick = async () => { await libFetch('/api/library/apps/' + encodeURIComponent(a.id), { method: 'DELETE' }); await refreshHomeLibrary(); };
      row.appendChild(lab); row.appendChild(del);
      box.appendChild(row);
    });
  }

  async function syncRuntimeLocale() {
    try {
      const r = await fetch('/api/runtime/locale', { cache: 'no-store' });
      const j = await r.json();
      if (!j || !j.ok) return;
      const candidateZone = j.timeZone || state.timeZone;
      try { new Intl.DateTimeFormat('en-US', { timeZone: candidateZone }); state.timeZone = candidateZone; } catch (_) { state.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
      try { localStorage.setItem('solo_timezone', state.timeZone); } catch (_) {}
      const savedLang = localStorage.getItem('solo_lang');
      if (!savedLang || localStorage.getItem('solo_lang_manual') !== '1') {
        state.lang = j.lang === 'vi' ? 'vi' : 'en';
        applyLang();
      }
      const locale = $('runtime-locale');
      if (locale) { locale.textContent = (state.lang === 'vi' ? 'Múi giờ' : 'Time zone') + ': ' + state.timeZone; locale.title = (j.country ? j.country + ' · ' : '') + (j.source || 'local'); }
    } catch (_) {}
    finally { state.localeReady = true; }
  }

  function startScheduledTasks() {
    const keyPrefix = 'solo_task_last_run_';
    async function check() {
      try {
        const r = await fetch('/api/library/scripts'); const j = await r.json();
        const tasks = (j.scripts || []).filter(x => x && x.active !== false && x.schedule && x.schedule.type === 'daily' && x.schedule.time);
        let formatter;
        try { formatter = new Intl.DateTimeFormat('en-GB', { timeZone: state.timeZone || 'UTC', hour: '2-digit', minute: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit', hour12: false }); }
        catch (_) { formatter = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit', hour12: false }); }
        const parts = formatter.formatToParts(new Date());
        const get = t => parts.find(p => p.type === t)?.value || '';
        const nowTime = get('hour') + ':' + get('minute'); const dateKey = get('year') + '-' + get('month') + '-' + get('day');
        for (const task of tasks) {
          const storageKey = keyPrefix + task.id;
          if (task.schedule.time !== nowTime || localStorage.getItem(storageKey) === dateKey) continue;
          localStorage.setItem(storageKey, dateKey);
          const step = (task.steps || []).find(x => x.type === 'navigate' && x.url);
          if (step) {
            let yt = getVideoEmbedUrl(step.url);
            if (!yt && /youtube\.com\/results/i.test(step.url)) {
              try { const query = new URL(step.url).searchParams.get('search_query') || ''; const found = await fetch('/api/library/youtube/first?q=' + encodeURIComponent(query)).then(r => r.json()); if (found && found.ok) yt = found.embedUrl; } catch (_) {}
            }
            if (yt) {
              openHomePanel('panel-playlists');
              const player = $('playlist-player-frame'); if (player) player.src = yt;
              const title = $('playlist-now-title'); if (title) { title.textContent = task.nameVi && state.lang === 'vi' ? task.nameVi : task.name; title.dataset.userTitle = '1'; }
              if (homeLib.playlists.length) { const pl = activePlaylist(); if (pl) { homeLib.activePlaylistId = pl.id; } }
            } else navigate(step.url, { force: true });
            clientLog('info', 'ai_task.started', { taskId: task.id, time: nowTime, timeZone: state.timeZone, embedded: !!yt });
            const duration = Number(task.schedule.durationMinutes || 0);
            if (duration > 0) setTimeout(() => { const player = $('playlist-player-frame'); if (player) player.src = 'about:blank'; clientLog('info', 'ai_task.stopped', { taskId: task.id }); }, duration * 60000);
          }
        }
      } catch (_) {}
    }
    check(); setInterval(check, 15000);
  }

  function bindHomeLibrary() {
    const utils = document.getElementById('home-utils');
    if (utils && !utils._boundHome) {
      utils._boundHome = true;
      utils.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest && e.target.closest('.home-icon-btn[data-panel]');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        openHomePanel(btn.getAttribute('data-panel'));
      });
    }
    document.querySelectorAll('.home-panel-close').forEach((btn) => {
      if (btn._bound) return;
      btn._bound = true;
      btn.addEventListener('click', (e) => { e.preventDefault(); closeHomePanels(); });
    });
    const bd = document.getElementById('home-panel-backdrop');
    if (bd && !bd._bound) {
      bd._bound = true;
      bd.addEventListener('click', () => closeHomePanels());
    }

    if ($('btn-pl-add')) $('btn-pl-add').addEventListener('click', async () => {
      const title = state.lang === 'vi' ? 'Danh sách phát' : 'Playlist';
      await libFetch('/api/library/playlists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
      await refreshHomeLibrary();
    });
    if ($('pl-add-form')) $('pl-add-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      let pl = activePlaylist();
      if (!pl) {
        const r = await libFetch('/api/library/playlists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Playlist' }) });
        if (r.playlist) { homeLib.playlists.unshift(r.playlist); homeLib.activePlaylistId = r.playlist.id; pl = r.playlist; }
      }
      const url = ($('pl-url-input') && $('pl-url-input').value || '').trim();
      if (!url || !pl) return;
      await libFetch('/api/library/playlists/' + encodeURIComponent(pl.id) + '/items', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, title: url })
      });
      if ($('pl-url-input')) $('pl-url-input').value = '';
      await refreshHomeLibrary();
    });
    if ($('btn-pl-play')) $('btn-pl-play').addEventListener('click', () => {
      const pl = activePlaylist(); if (!pl || !pl.items || !pl.items.length) return;
      const audio = $('bg-music-audio');
      if (audio && !audio.hidden && audio.src) {
        if (audio.paused) audio.play().catch(() => {}); else audio.pause();
        updateMusicControls(); return;
      }
      if (!homeLib.isPlaying) { if (!$('playlist-player-frame')?.src || $('playlist-player-frame').src.endsWith('about:blank')) playPlaylistItem(); else if (!sendPlayerCommand('playVideo')) playPlaylistItem(); homeLib.isPlaying = true; }
      else { if (!sendPlayerCommand('pauseVideo')) { const f = $('playlist-player-frame'); if (f) f.src = 'about:blank'; homeLib.isPlaying = false; } else homeLib.isPlaying = false; }
      updateMusicControls();
    });
    if ($('btn-pl-music')) $('btn-pl-music').addEventListener('click', () => { homeLib.musicMode = !homeLib.musicMode; $('btn-pl-music').classList.toggle('active', homeLib.musicMode); });
    if ($('btn-pl-next')) $('btn-pl-next').addEventListener('click', () => advancePlaylist(1, false));
    if ($('btn-pl-prev')) $('btn-pl-prev').addEventListener('click', () => advancePlaylist(-1, false));
    if ($('btn-pl-shuffle')) $('btn-pl-shuffle').addEventListener('click', () => { homeLib.shuffle = !homeLib.shuffle; try { localStorage.setItem('solo_music_shuffle', homeLib.shuffle ? '1' : '0'); } catch (_) {} updateMusicControls(); });
    if ($('btn-pl-repeat')) $('btn-pl-repeat').addEventListener('click', () => { homeLib.repeatMode = homeLib.repeatMode === 'off' ? 'all' : homeLib.repeatMode === 'all' ? 'one' : 'off'; try { localStorage.setItem('solo_music_repeat', homeLib.repeatMode); } catch (_) {} updateMusicControls(); });
    updateMusicControls();
    if ($('btn-sc-refresh')) $('btn-sc-refresh').addEventListener('click', () => refreshHomeLibrary());
    if ($('app-add-form')) $('app-add-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = ($('app-name-input') && $('app-name-input').value || 'App').trim();
      const url = ($('app-url-input') && $('app-url-input').value || '').trim();
      if (!url) return;
      await libFetch('/api/library/apps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, url }) });
      if ($('app-name-input')) $('app-name-input').value = '';
      if ($('app-url-input')) $('app-url-input').value = '';
      await refreshHomeLibrary();
    });
    // Context menu: long-press / right-click on page frame cannot access cross-origin DOM;
    // offer "Add current URL to playlist" via custom event from chrome.
    document.addEventListener('contextmenu', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('#main-webview') || t.tagName === 'VIDEO' || (t.closest && t.closest('video'))) {
        // same-origin only for video elements outside iframe
      }
    });
  }

  function addCurrentUrlToPlaylist() {
    const url = state.url || ($('url-input') && $('url-input').value);
    if (!url || !/^https?:/i.test(url)) return;
    (async () => {
      let pl = activePlaylist();
      if (!pl) {
        const r = await libFetch('/api/library/playlists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Playlist' }) });
        pl = r.playlist;
        homeLib.activePlaylistId = pl && pl.id;
      }
      if (!pl) return;
      await libFetch('/api/library/playlists/' + encodeURIComponent(pl.id) + '/items', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, title: url })
      });
      await refreshHomeLibrary();
      showStart();
    })();
  }


  try { bindHomeLibrary(); } catch (e) { console.error('[home] bind', e); }
  try { refreshHomeLibrary(); } catch (e) { console.error('[home] refresh', e); }
  // Extra bind after paint (mobile WebView)
  setTimeout(function () { try { bindHomeLibrary(); refreshHomeLibrary(); } catch (_) {} }, 300);
  document.documentElement.setAttribute('data-solo-home-utils-ready', '1');

  function getBridgeSession() {
    const tab = getActiveTab();
    const nav = ensureTabNav(tab);
    return nav && nav.bridge ? { sessionId: nav.bridge.sessionId, token: nav.bridge.token, backend: nav.bridge.backend, url: state.url || '' } : null;
  }
  async function ensureBridgeSession() {
    let b = getBridgeSession();
    if (b && b.sessionId && b.token) return b;
    try {
      // Create a lightweight session via navigate to about:blank / example
      if (typeof ensureEngineSession === 'function') {
        await ensureEngineSession(getActiveTab());
      } else if (typeof createBridgeSession === 'function') {
        await createBridgeSession(getActiveTab());
      } else {
        // Soft navigate to open a backend session
        await navigate('https://example.com/', { force: true, skipHistory: true });
      }
    } catch (_) {}
    return getBridgeSession();
  }
  window.SoloBrowser = { navigate, extractPage, aiProcess, state, newTab, openLibrary, addCurrentUrlToPlaylist, refreshHomeLibrary, runScript, stopScript, showTasksPanel() { showStart(); openHomePanel('panel-scripts'); refreshHomeLibrary(); }, openHomePanel, getActiveBridge: getBridgeSession, getBridgeSession, ensureBridgeSession,
    softRefreshActiveBridge: softRefreshActiveBridge, refreshBridgeView() {
      const tab = getActiveTab();
      const nav = ensureTabNav(tab);
      if (!nav || !nav.bridge || !frame) return false;
      const view = bridgeViewUrl(nav.bridge);
      if (!view) return false;
      try {
        frame.setAttribute('sandbox', 'allow-same-origin allow-forms allow-scripts');
        if (frame.getAttribute('data-sh-view') !== view) { frame.src = view; frame.setAttribute('data-sh-view', view); }
        return true;
      } catch (_) { return false; }
    }, syncBackendState(url, title) { const tab = getActiveTab(); const nav = ensureTabNav(tab); if (url && !isInternalBridgeViewUrl(url)) { const nu = normalizeNavUrl(url); if (state.url !== nu && nav) { if (nav.index >= 0 && nav.stack[nav.index]) { nav.stack[nav.index] = nu; } else { pushNav(tab, nu); } saveVisit(nu); } applyUrlToUi(nu, title || ''); } if (nav && nav.bridge && frame) { const view = bridgeViewUrl(nav.bridge); if (view) { frame.setAttribute('sandbox', 'allow-same-origin allow-forms allow-scripts'); if (frame.getAttribute('data-sh-view') !== view) { frame.src = view; frame.setAttribute('data-sh-view', view); } } } } };
})();

  try {
    window.addEventListener('message', function (ev) {
      try {
        if (!ev || !ev.data || ev.data.type !== 'solohost-open-novnc') return;
        var btn = document.getElementById('btn-novnc');
        if (btn) btn.click();
      } catch (_) {}
    });
  } catch (_) {}
