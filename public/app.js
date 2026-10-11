(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const frame = $('main-webview');
  const input = $('url-input');
  const btnOpen = $('btn-open-tab');
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

  function classifyUrl(url) {
    const h = hostOf(url);
    // Let Chromium's native viewer handle direct media, images and PDFs instead of
    // trying to snapshot its internal browser UI through the DOM Bridge.
    if (isNativeMediaOrDocumentUrl(url)) return MODE.DIRECT;
    if (!h) return MODE.PROXY;
    // Site-owned authentication must use a normal system browser, not an embedded/automated view.
    if (isExternalAuthPath(url)) return MODE.EXTERNAL;
    // YouTube watch/Shorts/live URLs must reach the server's official-player shell.
    // The Bridge snapshot intentionally strips scripts/unsafe frames, so rendering these
    // URLs in the automated DOM view leaves a visible page with a non-working player.
    if (isYouTubeVideoUrl(url)) return MODE.PROXY;
    // DRM/subscription streaming sites need their own full browser profile/DRM stack.
    if (/(^|\.)(netflix|disneyplus|hulu|primevideo)\.com$/.test(h)) return MODE.EXTERNAL;
    // Official embeddable players remain direct when on their official embed endpoint.
    if (isDirectEmbed(url)) return MODE.DIRECT;
    // Dynamic sites use the JS-capable engine; do not rewrite them to proxy HTML pre-emptively.
    if (/google\.|youtube\.com|youtu\.be|(^|\.)(facebook|fb|instagram|whatsapp|messenger|tiktok|x|twitter|reddit)\.com$/.test(h)) return MODE.ENGINE;
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
        body: JSON.stringify({ privateMode: !!tab.private }),
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
      if (!j || !j.ok) return { ok: false, reason: (j && j.error) || 'bridge_navigate_failed', detail: j };
      if (j.externalRequired) return loadViaExternal(j.url || url, j.externalReason || 'site_auth_policy');
      const activeNav = ensureTabNav(tab);
      if (activeNav) activeNav.bridgeAudit = j.audit || {};
      if (!j.hasContent && j.error) return { ok: false, reason: j.error, detail: j };
      // If backend fell back to proxy inside server, treat as proxy success without bridge view
      if (j.backend === 'proxy' && j.hasContent === false) {
        return { ok: false, reason: 'bridge_empty', detail: j };
      }
      const view = bridgeViewUrl(b);
      if (!frame || !view) return { ok: false, reason: 'no_viewport' };
      try {
        frame.setAttribute('sandbox', 'allow-same-origin allow-forms allow-popups allow-scripts');
        frame.src = view + (view.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
      } catch (_) {
        return { ok: false, reason: 'frame_error' };
      }
      return {
        ok: true,
        mode: (j.backend === 'webkit' || b.backend === 'webkit') ? MODE.ENGINE : MODE.PROXY,
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
          if (tag === 'a') {
            try {
              const abs = new URL(el.getAttribute('href') || '', state.url || 'https://example.com').href;
              if (isNativeMediaOrDocumentUrl(abs)) {
                e.preventDefault(); e.stopPropagation(); navigate(abs, { force: true }); return;
              }
              // Hand video clicks from YouTube's live DOM to the official player route.
              // Do not click through the Playwright page and then display its script-stripped snapshot.
              if (isYouTubeVideoUrl(abs)) {
                e.preventDefault(); e.stopPropagation();
                clientLog('info', 'youtube.video_handoff', { url: abs, detail: 'official_embed_player_route' });
                navigate(abs, { force: true, mode: MODE.PROXY });
                return;
              }
            } catch (_) {}
          }
          const inputType = (el.getAttribute('type') || '').toLowerCase();
          if (tag === 'a' || tag === 'button' || tag === 'label' || ['button','link','tab','checkbox','switch','option','menuitem'].includes(el.getAttribute('role')) ||
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
      if ($('home-pl-title')) $('home-pl-title').textContent = vi ? 'Nhạc' : 'Playlist';
      if ($('home-sc-title')) $('home-sc-title').textContent = vi ? 'Lệnh' : 'Scripts';
      if ($('home-app-title')) $('home-app-title').textContent = vi ? 'Apps' : 'Apps';
      if ($('panel-pl-h')) $('panel-pl-h').textContent = vi ? '♪ Danh sách phát' : '♪ Playlist';
      if ($('panel-sc-h')) $('panel-sc-h').textContent = vi ? '⚡ Tập lệnh' : '⚡ Scripts';
      if ($('panel-app-h')) $('panel-app-h').textContent = vi ? '⊞ App SoloHost' : '⊞ SoloHost Apps';
      if ($('sc-hint')) $('sc-hint').textContent = vi
        ? '◎ Mẫu: không cần AI · ✦ Lệnh mới: ưu tiên AI Action'
        : '◎ Sample: no AI · ✦ Custom: AI Action first';
      if ($('sc-name-input')) $('sc-name-input').placeholder = vi ? 'Tên lệnh' : 'Script name';
      if ($('sc-url-input')) $('sc-url-input').placeholder = vi ? 'URL điều hướng…' : 'Navigate URL…';
      if ($('pl-url-input')) $('pl-url-input').placeholder = vi ? 'Dán URL video…' : 'Paste video URL…';
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
      el.addEventListener('click', hideSplash, { once: true });
      // Hard timeout 5s — always dismiss
      setTimeout(hideSplash, 5000);
      // Safety net if something blocks timers briefly
      setTimeout(hideSplash, 6500);
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
    // Restore the existing tab's Bridge view instead of reloading the website.
    const nav = ensureTabNav(tab);
    const view = nav && nav.bridge && bridgeViewUrl(nav.bridge);
    if (state.url && view) {
      if (frame) { frame.setAttribute('sandbox', 'allow-same-origin allow-forms allow-popups allow-scripts'); frame.src = view + '&t=' + Date.now(); }
      hideStart();
    } else if (state.url) navigate(state.url, { force: true, skipHistory: true });
    else { if (frame) frame.src = 'about:blank'; showStart(); }
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
  startSplash();
  showStart();

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
      const el = $(id);
      if (el) el.hidden = true;
    });
  }

  function openHomePanel(panelId) {
    closeHomePanels();
    const el = $(panelId);
    if (el) el.hidden = false;
  }


  function renderPlaylists() {
    const box = $('pl-list');
    if (!box) return;
    box.innerHTML = '';
    if (!homeLib.playlists.length) {
      box.innerHTML = '<div class="home-hint">' + (state.lang === 'vi' ? 'Chưa có danh sách. Bấm ＋ để tạo.' : 'No playlists yet. Tap ＋ to create.') + '</div>';
      return;
    }
    homeLib.playlists.forEach((pl) => {
      const row = document.createElement('div');
      row.className = 'home-item';
      if (pl.id === homeLib.activePlaylistId) row.style.fontWeight = '600';
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
      (pl.items || []).slice(0, 8).forEach((it, idx) => {
        const ir = document.createElement('div');
        ir.className = 'home-item';
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

  function playPlaylistItem() {
    const pl = activePlaylist();
    if (!pl || !pl.items || !pl.items.length) return;
    const it = pl.items[homeLib.playIndex % pl.items.length];
    if (!it) return;
    let url = it.url;
    // Music / background-friendly: prefer YouTube embed when possible
    if (homeLib.musicMode) {
      const m = String(url).match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{6,})/i);
      if (m) url = 'https://www.youtube.com/embed/' + m[1] + '?autoplay=1';
    }
    navigate(url);
  }

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
      lab.textContent = (sc.sample ? '◎ ' : '✦ ') + nm;
      lab.title = (sc.sample
        ? (state.lang === 'vi' ? 'Mẫu · không cần AI' : 'Sample · no AI')
        : (state.lang === 'vi' ? 'AI Action' : 'AI Action')) + ' — ' +
        ((state.lang === 'vi' && sc.descriptionVi) ? sc.descriptionVi : (sc.description || ''));
      const run = document.createElement('button');
      run.type = 'button'; run.className = 'chip'; run.textContent = '▶';
      run.title = state.lang === 'vi' ? 'Chạy' : 'Run';
      run.onclick = () => runScript(sc);
      const stop = document.createElement('button');
      stop.type = 'button'; stop.className = 'chip'; stop.textContent = '■';
      stop.onclick = () => stopScript();
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
          context: { scriptId: sc.id, steps: sc.steps }
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
        ? 'AI Action chưa sẵn sàng. Thêm bước navigate hoặc cấu hình AI trong Settings.'
        : 'AI Action not ready. Add navigate steps or configure AI in Settings.');
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

  function bindHomeLibrary() {
    document.querySelectorAll('.home-icon-btn[data-panel]').forEach((btn) => {
      btn.addEventListener('click', () => openHomePanel(btn.getAttribute('data-panel')));
    });
    document.querySelectorAll('.home-panel-close').forEach((btn) => {
      btn.addEventListener('click', () => closeHomePanels());
    });

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
    if ($('btn-pl-play')) $('btn-pl-play').addEventListener('click', () => { homeLib.musicMode = false; playPlaylistItem(); });
    if ($('btn-pl-music')) $('btn-pl-music').addEventListener('click', () => {
      homeLib.musicMode = !homeLib.musicMode;
      $('btn-pl-music').classList.toggle('active', homeLib.musicMode);
      playPlaylistItem();
    });
    if ($('btn-pl-next')) $('btn-pl-next').addEventListener('click', () => {
      const pl = activePlaylist();
      if (!pl || !pl.items) return;
      homeLib.playIndex = (homeLib.playIndex + 1) % Math.max(pl.items.length, 1);
      playPlaylistItem();
    });
    if ($('btn-sc-refresh')) $('btn-sc-refresh').addEventListener('click', () => refreshHomeLibrary());
    if ($('sc-add-form')) $('sc-add-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = ($('sc-name-input') && $('sc-name-input').value || 'Script').trim();
      const url = ($('sc-url-input') && $('sc-url-input').value || '').trim();
      if (!url && !name) return;
      const steps = url ? [{ type: 'navigate', url: url }] : [];
      await libFetch('/api/library/scripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, nameVi: name, description: url || name, steps: steps })
      });
      if ($('sc-name-input')) $('sc-name-input').value = '';
      if ($('sc-url-input')) $('sc-url-input').value = '';
      await refreshHomeLibrary();
    });

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


  bindHomeLibrary();
  refreshHomeLibrary();
  window.SoloBrowser = { navigate, extractPage, aiProcess, state, newTab, openLibrary, addCurrentUrlToPlaylist, refreshHomeLibrary, runScript, stopScript, getActiveBridge() { const tab = getActiveTab(); const nav = ensureTabNav(tab); return nav && nav.bridge ? { sessionId: nav.bridge.sessionId, token: nav.bridge.token, backend: nav.bridge.backend, url: state.url || '' } : null; },
    refreshBridgeView() {
      const tab = getActiveTab();
      const nav = ensureTabNav(tab);
      if (!nav || !nav.bridge || !frame) return false;
      const view = bridgeViewUrl(nav.bridge);
      if (!view) return false;
      try {
        frame.setAttribute('sandbox', 'allow-same-origin allow-forms allow-popups allow-scripts');
        frame.src = view + (view.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
        return true;
      } catch (_) { return false; }
    }, syncBackendState(url, title) { const tab = getActiveTab(); const nav = ensureTabNav(tab); if (url && !isInternalBridgeViewUrl(url)) { if (state.url !== url && nav) { pushNav(tab, url); saveVisit(url); } applyUrlToUi(url, title || ''); } if (nav && nav.bridge && frame) { const view = bridgeViewUrl(nav.bridge); if (view) { frame.setAttribute('sandbox', 'allow-same-origin allow-forms allow-popups allow-scripts'); frame.src = view + '&t=' + Date.now(); } } } };
})();
