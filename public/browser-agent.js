'use strict';
/**
 * Thin UI adapter for the backend-owned Browser Agent.
 * This module deliberately does not inspect iframe DOM or execute page actions.
 * It sends a task, polls progress, and renders status/confirmation requests only.
 */
(function () {
  const S = { running: false, stop: false, taskId: null, bridge: null, pollAbort: false, pendingAnswer: null };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const browser = () => window.SoloBrowser || {};
  async function api(url, options = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    if (S.bridge && S.bridge.token) headers['X-Session-Token'] = S.bridge.token;
    const response = await fetch(url, Object.assign({}, options, { headers }));
    const data = await response.json().catch(() => null);
    if (!data || !response.ok || data.ok === false) throw new Error((data && (data.error || data.message)) || ('HTTP ' + response.status));
    return data;
  }
  async function run(task, hooks, opts) {
    if (S.running) return { status: 'error', message: 'Agent already running', history: [] };
    hooks = Object.assign({ onStatus() {}, onStep() {}, onConfirm(_text, answer) { answer(false); } }, hooks || {});
    opts = opts || {};
    let bridge = browser().getActiveBridge && browser().getActiveBridge();
    if (!bridge || !bridge.sessionId || !bridge.token) {
      try {
        hooks.onStatus('Đang tạo phiên backend (Playwright)…');
        // Ensure a tab session exists by navigating home or blank engine session
        if (browser().navigate) await browser().navigate('https://example.com/');
        await sleep(800);
        bridge = browser().getActiveBridge && browser().getActiveBridge();
      } catch (_) {}
    }
    if (!bridge || !bridge.sessionId || !bridge.token) {
      return { status: 'error', message: 'Không tạo được phiên backend. Hãy mở một trang (Go) trước, rồi chạy lại Agent.' , history: [] };
    }
    S.running = true; S.stop = false; S.pollAbort = false; S.bridge = bridge; S.taskId = null;
    let cursor = 0, history = Array.isArray(opts.history) ? opts.history.slice() : [];
    const seen = new Set();
    try {
      hooks.onStatus('Đang gửi nhiệm vụ đến Browser Backend…');
      const started = await api('/api/browser/agent/tasks', { method: 'POST', body: JSON.stringify({ sessionId: bridge.sessionId, token: bridge.token, task, lang: (browser().state && browser().state.lang) || 'en', history, maxSteps: opts.maxSteps || 200, maxMs: opts.maxMs || (Number(localStorage.getItem('solo_agent_time_min')||60)*60000), workMemory: opts.workMemory || null }) });
      S.taskId = started.taskId;
      while (!S.pollAbort && !S.stop) {
        const st = await api('/api/browser/agent/sessions/' + encodeURIComponent(bridge.sessionId) + '/tasks/' + encodeURIComponent(S.taskId) + '?after=' + cursor, { method: 'GET' });
        cursor = Math.max(cursor, Number(st.cursor) || 0);
        for (const ev of (st.events || [])) {
          if (seen.has(ev.id)) continue; seen.add(ev.id);
          if (ev.type === 'status') hooks.onStatus(ev.message || 'Backend đang xử lý…');
          else if (ev.type === 'step') hooks.onStep({ n: ev.n, thought: ev.thought || '', action: ev.action || {}, text: describe(ev.action || {}, ev.url) });
          else if (ev.type === 'action_result') { hooks.onStatus((ev.ok ? '✓ ' : '⚠ ') + (ev.result || '')); if (browser().syncBackendState && ev.url) browser().syncBackendState(ev.url, ev.title || ''); }
          else if (ev.type === 'confirmation_required') {
            const answer = await new Promise(resolve => {
              let done = false;
              const finish = v => { if (done) return; done = true; S.pendingAnswer = null; resolve(!!v); };
              S.pendingAnswer = finish;
              hooks.onConfirm(ev.text || 'Cho phép thao tác nhạy cảm?', finish);
            });
            if (!S.stop) await api('/api/browser/agent/sessions/' + encodeURIComponent(bridge.sessionId) + '/tasks/' + encodeURIComponent(S.taskId) + '/confirm', { method: 'POST', body: JSON.stringify({ token: bridge.token, confirmationId: ev.confirmationId, approved: answer }) });
          } else if (ev.type === 'login_form') {
            const msg = ev.message || 'Login form — fill credentials in the browser viewport (not in chat).';
            hooks.onStatus('🔐 ' + msg + (ev.url ? ' · ' + ev.url : ''));
            if (typeof hooks.onLoginForm === 'function') hooks.onLoginForm(ev);
            // Refresh viewport so user sees live login fields from Playwright
            try {
              if (browser().refreshBridgeView) browser().refreshBridgeView();
              else if (browser().reload) browser().reload();
            } catch (_) {}
          } else if (ev.type === 'ask_user') {
            hooks.onStatus(ev.message || 'Need your action');
          } else if (ev.type === 'step' || ev.type === 'status' || ev.type === 'action_result') {
            if (ev.message) hooks.onStatus(ev.message);
            else if (ev.type === 'action_result' && ev.result) hooks.onStatus(String(ev.result));
            if (ev.type === 'step' && typeof hooks.onStep === 'function') hooks.onStep(ev);
          }
        }
        if (['done', 'failed', 'error', 'stopped', 'limit', 'waiting_user'].includes(st.status)) {
          history = Array.isArray(st.history) ? st.history : history;
          const status = st.status === 'waiting_user' ? 'ask' : st.status === 'failed' ? 'fail' : st.status === 'error' ? 'error' : st.status;
          return { status, message: st.message || st.error || '', history, workMemory: st.workMemory || null, taskId: S.taskId };
        }
        await sleep(500);
      }
      return { status: 'stopped', message: '', history };
    } catch (e) {
      return { status: 'error', message: String(e.message || e), history };
    } finally { S.running = false; S.taskId = null; S.bridge = null; }
  }
  function describe(a, url) {
    const t = a.type || 'action';
    if (t === 'navigate') return 'Backend mở ' + (a.url || 'trang');
    if (t === 'search') return 'Backend tìm kiếm ' + (a.query || '') + ' trên ' + (a.engine || 'Bing');
    if (t === 'click') return 'Backend bấm phần tử #' + a.id;
    if (t === 'type') return 'Backend nhập nội dung vào trường #' + a.id;
    if (t === 'select') return 'Backend chọn mục trong trường #' + a.id;
    if (t === 'done') return 'Hoàn tất';
    return 'Backend: ' + t + (url ? ' · ' + url : '');
  }
  async function stop() {
    S.stop = true; S.pollAbort = true;
    if (S.pendingAnswer) { const answer = S.pendingAnswer; S.pendingAnswer = null; answer(false); }
    if (S.taskId && S.bridge) {
      try { await api('/api/browser/agent/sessions/' + encodeURIComponent(S.bridge.sessionId) + '/tasks/' + encodeURIComponent(S.taskId) + '/stop', { method: 'POST', body: JSON.stringify({ token: S.bridge.token }) }); } catch (_) {}
    }
  }
  window.SoloAgent = { run, stop, isRunning: () => S.running };
})();
