'use strict';
/**
 * Reference AI panel controller (from Snake Arcade).
 * Host app may copy to public/ai-panel.js and adapt browserContext() / executeActions().
 * Depends on: UniversalAI, UniversalFeedback, markup in example/ui/ai-panel.html, styles in ai-panel.css.
 */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function flatten(src, prefix, out) {
  if (src == null) return;
  if (typeof src === 'string' || typeof src === 'number') {
    if (String(src).trim()) out.push([prefix || 'info', String(src)]);
    return;
  }
  if (Array.isArray(src)) { src.forEach((v, i) => flatten(v, prefix + ' ' + (i + 1), out)); return; }
  if (typeof src === 'object') Object.keys(src).forEach(k => flatten(src[k], prefix ? prefix + ' · ' + k : k, out));
}
function renderDonate(donate) {
  const box = document.getElementById('fbDonate');
  if (!box) return;
  const rows = [];
  flatten(donate, '', rows);
  if (!rows.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = '<strong>Ủng hộ tác giả</strong>' + rows.slice(0, 12).map(([k, v]) =>
    '<div class="fb-acc"><div class="fb-k">' + escapeHtml(k) + '</div><code class="fb-val">' + escapeHtml(v) + '</code></div>').join('');
}
function setUnread(n) {
  const badge = document.getElementById('aiBadge');
  const tabBadge = document.getElementById('fbTabBadge');
  const count = Number(n) || 0;
  if (badge) {
    if (count > 0) {
      badge.hidden = false;
      badge.style.display = '';
      badge.textContent = count > 9 ? '9+' : String(count);
    } else {
      badge.hidden = true;
      badge.style.display = 'none';
      badge.textContent = '';
    }
  }
  if (tabBadge) {
    if (count > 0) {
      tabBadge.hidden = false;
      tabBadge.style.display = '';
      tabBadge.textContent = count > 9 ? '9+' : String(count);
    } else {
      tabBadge.hidden = true;
      tabBadge.style.display = 'none';
      tabBadge.textContent = '';
    }
  }
}
function setFabVisible(visible) {
  const fab = document.getElementById('aiFab');
  if (!fab) return;
  fab.hidden = !visible;
  fab.style.display = visible ? '' : 'none';
}
function browserContext() {
  const st = (window.SoloBrowser && window.SoloBrowser.state) || {};
  return {
    url: st.url || document.getElementById('url-input')?.value || '',
    currentUrl: st.url || '',
    lang: st.lang || (document.documentElement.lang || 'en'),
    theme: st.theme || document.documentElement.getAttribute('data-theme') || 'rainbow',
    app: 'SoloHost Browser',
    version: '9.0.17'
  };
}
function executeActions(actions) {
  (actions || []).forEach(a => {
    if (!a || a.ok === false) return;
    const name = a.action || a.name;
    const value = a.value || (a.args && (a.args.url || a.args.value)) || '';
    if (name === 'open_url' && value && window.SoloBrowser && typeof window.SoloBrowser.navigate === 'function') {
      window.SoloBrowser.navigate(String(value));
    }
    if (name === 'open_security') window.open('/security.html', '_blank');
    if (name === 'toggle_theme') document.getElementById('btn-theme')?.click();
    if (name === 'open_tab') document.querySelector('.tab[data-tab="' + (value || 'chat') + '"]')?.click();
  });
}

const aiChat = document.getElementById('chatLog') || document.getElementById('aiChat');
const aiInput = document.getElementById('chatInput') || document.getElementById('aiInput');
function appendMsg(role, html) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.innerHTML = html;
  if (aiChat) { aiChat.appendChild(div); aiChat.scrollTop = aiChat.scrollHeight; }
  return div;
}

const ai = window.UniversalAI.create({
  button: document.getElementById('aiFab'),
  onOpen() {
    const ov = document.getElementById('aiOverlay');
    if (ov) ov.hidden = false;
    setFabVisible(false);
    refreshStatus();
    loadSettings();
  },
  onActions: executeActions
});

function closeAIPanel() {
  const ov = document.getElementById('aiOverlay');
  if (ov) ov.hidden = true;
  setFabVisible(true);
}
document.getElementById('aiClose')?.addEventListener('click', closeAIPanel);
document.getElementById('aiOverlay')?.addEventListener('click', e => {
  if (e.target.id === 'aiOverlay') closeAIPanel();
});
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(x => {
    x.classList.remove('active');
    x.hidden = true;
  });
  t.classList.add('active');
  // Support both id patterns: pane-chat (current) and tab-chat (legacy)
  const name = t.dataset.tab;
  const pane = document.getElementById('pane-' + name) || document.getElementById('tab-' + name);
  if (pane) {
    pane.classList.add('active');
    pane.hidden = false;
  }
  if (name === 'settings') loadSettings();
  if (name === 'logs') loadLogs();
  if (name === 'feedback') setUnread(0);
}));

async function refreshStatus() {
  const bar = document.getElementById('aiStatusBar');
  const dot = document.getElementById('aiStatusDot');
  try {
    const j = await ai.status();
    const configured = !!(j.configured || (j.settings && j.settings.hasKey));
    const provider = (j.settings && j.settings.provider) || j.provider || '';
    if (bar) bar.textContent = configured ? ('AI ready · ' + provider) : 'Local guide ON · add key in Settings';
    if (dot) { dot.classList.toggle('on', configured); dot.classList.toggle('off', !configured); }
  } catch (e) {
    if (bar) bar.textContent = 'AI unavailable';
  }
}

async function applyAiActions(actions) {
  if (!Array.isArray(actions)) return;
  for (const a of actions) {
    const name = a.name || a.action;
    const args = a.args || {};
    try {
      if (name === 'open_url' && args.url && window.SoloBrowser && window.SoloBrowser.navigate) {
        window.SoloBrowser.navigate(args.url);
      } else if (name === 'toggle_theme') {
        document.getElementById('btn-theme')?.click();
      } else if (name === 'diagnose_logs') {
        // Already answered in reply; optional refresh logs tab
        document.querySelector('.tab[data-tab="logs"]')?.click();
        if (typeof loadLogs === 'function') loadLogs();
      }
    } catch (_) {}
  }
}

async function sendAI() {
  const text = (aiInput.value || '').trim();
  if (!text) return;
  aiInput.value = '';
  appendMsg('user', escapeHtml(text));
  if (agentOn()) { await runAgentTask(text); return; }
  const loading = appendMsg('ai', '…');
  try {
    let logs = [];
    try {
      const lr = await fetch('/api/logs').then(r => r.json());
      logs = (lr.logs || []).filter(l => l && l.level !== 'debug').slice(-40);
    } catch (_) {}
    const ctx = Object.assign(browserContext(), { logs });
    const out = await ai.chat(text, ctx);
    if (out && Array.isArray(out.actions)) await applyAiActions(out.actions);
    loading.remove();
    executeActions(out.actions);
    const local = out.source === 'local' || out.configured === false;
    appendMsg('ai', escapeHtml(out.reply || 'Không có phản hồi').replace(/\n/g, '<br>') +
      (local ? '<div style="opacity:.55;font-size:.75rem">Local guide</div>' : ''));
  } catch (e) {
    loading.remove();
    appendMsg('ai', escapeHtml(e.message || 'AI connection failed'));
  }
}
document.getElementById('aiSend')?.addEventListener('click', sendAI);
document.getElementById('chatSend')?.addEventListener('click', (e) => { e.preventDefault(); sendAI(); });
document.getElementById('chatForm')?.addEventListener('submit', (e) => { e.preventDefault(); sendAI(); });
document.getElementById('aiInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAI(); } });
document.getElementById('chatInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAI(); } });
aiInput?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendAI(); } });

function fillModelSelect(models, current) {
  const sel = document.getElementById('setModel');
  if (!sel) return;
  if (!Array.isArray(models) || !models.length) {
    if (sel.tagName === 'SELECT') {
      sel.outerHTML = '<input type="text" id="setModel" placeholder="auto" value="' + escapeHtml(current || 'auto') + '">';
    } else {
      sel.value = current || 'auto';
    }
    return;
  }
  const opts = ['<option value="auto">auto</option>'].concat(
    models.slice(0, 40).map(m => {
      const id = typeof m === 'string' ? m : (m.id || m.name || '');
      return '<option value="' + escapeHtml(id) + '">' + escapeHtml(id) + '</option>';
    })
  );
  if (sel.tagName !== 'SELECT') {
    sel.outerHTML = '<select id="setModel">' + opts.join('') + '</select>';
  } else {
    sel.innerHTML = opts.join('');
  }
  const el = document.getElementById('setModel');
  if (el) el.value = current || 'auto';
}

async function loadSettings() {
  const sel = document.getElementById('setProvider');
  const status = document.getElementById('setStatus');
  try {
    const [st, cat] = await Promise.all([ai.settings(), ai.catalog()]);
    const providers = (cat && cat.providers) || (Array.isArray(cat) ? cat : []);
    if (sel && providers.length) {
      sel.innerHTML = '<option value="none">— None —</option>' +
        providers.map(p => '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.name || p.id) + '</option>').join('');
      sel.value = st.provider || 'none';
    }
    const keyHint = document.getElementById('setKeyHint');
    if (keyHint) keyHint.textContent = st.hasKey ? ('Key hiện tại: ' + (st.maskedKey || '****')) : 'Key hiện tại: (chưa có)';
    const apiKey = document.getElementById('setApiKey');
    if (apiKey) apiKey.value = '';
    const base = document.getElementById('setBaseUrl');
    if (base) base.value = st.baseUrl || '';
    fillModelSelect([], st.model || 'auto');
    const mode = document.getElementById('setMode');
    if (mode) mode.value = st.mode || 'cloud_enabled';
    if (status) status.textContent = '';
  } catch (e) {
    if (status) status.textContent = 'Không tải được settings: ' + e.message;
  }
}

document.getElementById('setSave')?.addEventListener('click', async () => {
  const status = document.getElementById('setStatus');
  if (status) status.textContent = 'Saving…';
  try {
    const body = {
      provider: document.getElementById('setProvider')?.value,
      baseUrl: document.getElementById('setBaseUrl')?.value.trim(),
      model: document.getElementById('setModel')?.value.trim() || 'auto',
      mode: document.getElementById('setMode')?.value
    };
    const key = document.getElementById('setApiKey')?.value.trim();
    if (key) body.apiKey = key;
    const j = await ai.saveSettings(body);
    if (status) status.textContent = j.ok === false ? (j.error || 'Failed') : 'Saved ✓';
    await loadSettings();
    refreshStatus();
  } catch (e) {
    if (status) status.textContent = e.message;
  }
});

document.getElementById('setTest')?.addEventListener('click', async () => {
  const status = document.getElementById('setStatus');
  if (status) status.textContent = 'Checking token…';
  try {
    // save current form first so server tests the right provider/key
    const body = {
      provider: document.getElementById('setProvider')?.value,
      baseUrl: document.getElementById('setBaseUrl')?.value.trim(),
      model: document.getElementById('setModel')?.value.trim() || 'auto',
      mode: document.getElementById('setMode')?.value
    };
    const key = document.getElementById('setApiKey')?.value.trim();
    if (key) body.apiKey = key;
    await ai.saveSettings(body);
    const r = await ai.testConnection();
    if (r.ok) {
      const models = r.models || [];
      fillModelSelect(models, r.model || 'auto');
      if (status) status.textContent = 'Token OK' + (r.model ? ' · model: ' + r.model : '') + (models.length ? '. Models: ' + models.slice(0, 6).map(m => m.id || m).join(', ') : '. (server lists no models)') + (r.warning ? ' ⚠ ' + r.warning : '');
    } else {
      if (status) status.textContent = r.warning || r.error || 'Token check failed';
      if (r.suggested_provider) {
        const sel = document.getElementById('setProvider');
        if (sel) sel.value = r.suggested_provider;
      }
    }
  } catch (e) {
    if (status) status.textContent = e.message;
  }
});

async function refreshModelsClick() {
  const status = document.getElementById('setStatus');
  if (status) status.textContent = 'Refreshing models…';
  try {
    const r = await ai.models();
    fillModelSelect(r.models || r || [], document.getElementById('setModel')?.value || 'auto');
    if (status) status.textContent = r.warning || 'Models updated';
  } catch (e) {
    if (status) status.textContent = e.message;
  }
}
// HTML button is id="setModels"; keep the legacy id working too.
['setModels', 'setRefreshModels'].forEach(id => document.getElementById(id)?.addEventListener('click', refreshModelsClick));

async function loadLogs() {
  const view = document.getElementById('logsView');
  if (!view) return;
  try {
    const r = await fetch('/api/logs');
    const j = await r.json();
    view.textContent = (j.logs || []).map(l => {
      const ts = l.ts || '';
      const lvl = l.level || 'info';
      const msg = l.msg || '';
      const bits = [ts, '[' + lvl + ']', msg];
      if (l.code) bits.push('code=' + l.code);
      if (l.error) bits.push('error=' + l.error);
      if (l.blocked) bits.push('blocked=' + l.blocked);
      if (l.status != null) bits.push('status=' + l.status);
      if (l.ms != null) bits.push(l.ms + 'ms');
      if (l.url) bits.push(String(l.url).slice(0, 120));
      if (l.snippet) bits.push('"' + String(l.snippet).slice(0, 80) + '"');
      return bits.join(' ');
    }).join('\n') || '(no logs)';
  } catch (e) {
    view.textContent = e.message;
  }
}
document.getElementById('logsRefresh')?.addEventListener('click', loadLogs);
document.getElementById('logsClear')?.addEventListener('click', async () => {
  await fetch('/api/logs', { method: 'DELETE' });
  loadLogs();
});

const fb = window.UniversalFeedback.create({
  onUnread: setUnread,
  onSync(sync) {
    renderDonate(sync.donate);
    renderNotices(sync.notices);
  }
});
function renderNotices(notices) {
  const el = document.getElementById('fbNotices');
  if (!el) return;
  el.innerHTML = (notices || []).map(n =>
    '<div class="fb-notice"><strong>' + escapeHtml(n.title || 'Notice') + '</strong>' +
    (n.body ? '<div>' + escapeHtml(n.body) + '</div>' : '') +
    (n.id ? '<button type="button" data-mark="' + escapeHtml(n.id) + '">Đã đọc</button>' : '') +
    '</div>'
  ).join('');
  el.querySelectorAll('[data-mark]').forEach(btn => btn.addEventListener('click', async () => {
    await fb.markRead(btn.dataset.mark);
    btn.closest('.fb-notice')?.remove();
  }));
}
let fbRating = 0;
document.querySelectorAll('#fbStars button').forEach(b => b.addEventListener('click', () => {
  fbRating = Number(b.dataset.r);
  document.querySelectorAll('#fbStars button').forEach(x => x.classList.toggle('on', Number(x.dataset.r) <= fbRating));
}));
document.getElementById('fbSubmit')?.addEventListener('click', async () => {
  const status = document.getElementById('fbStatus');
  const msg = (document.getElementById('fbMessage')?.value || '').trim();
  if (!msg) { if (status) status.textContent = 'Vui lòng nhập nội dung.'; return; }
  if (status) status.textContent = 'Sending…';
  try {
    await fb.send({ type: document.getElementById('fbType')?.value, message: msg, rating: fbRating });
    if (status) status.textContent = 'Cảm ơn bạn!';
    const ta = document.getElementById('fbMessage');
    if (ta) ta.value = '';
  } catch (e) {
    if (status) status.textContent = e.message;
  }
});

refreshStatus();
loadSettings();
fb.sync().catch(e => {
  const st = document.getElementById('fbStatus');
  if (st) st.textContent = 'Hub: ' + e.message;
});
setUnread(0);
setFabVisible(true);

// Feedback form (SoloHost Browser panel)
document.getElementById('fbSend')?.addEventListener('click', async () => {
  const status = document.getElementById('fbStatus');
  const msg = (document.getElementById('fbMessage')?.value || '').trim();
  if (!msg) { if (status) status.textContent = 'Please enter a message'; return; }
  if (status) status.textContent = 'Sending…';
  try {
    if (!window.SoloFeedback || !window.SoloFeedback.send) throw new Error('Feedback module unavailable');
    const type = document.getElementById('fbType')?.value || 'improvement';
    const r = await window.SoloFeedback.send({ type, message: msg });
    if (status) status.textContent = r && r.ok === false ? (r.error || 'Failed') : 'Sent ✓';
    if (r && r.ok !== false) {
      const ta = document.getElementById('fbMessage'); if (ta) ta.value = '';
    }
  } catch (e) {
    if (status) status.textContent = e.message || String(e);
  }
});


// ---------------------------------------------------------------------------
// Browser Agent mode (AI operates the open page). Logic lives in browser-agent.js + lib/browser-agent.js.
// ---------------------------------------------------------------------------
let agentCtx = null; // { task, history } kept after ask_user so the next message continues the task
function agentLang() { return ((window.SoloBrowser && window.SoloBrowser.state && window.SoloBrowser.state.lang) || 'en') === 'vi' ? 'vi' : 'en'; }
function agentOn() {
  return !!document.getElementById('agentToggle')?.classList.contains('on') && !!window.SoloAgent;
}
function applyAgentMode(on) {
  const btn = document.getElementById('agentToggle');
  const hint = document.getElementById('agentHint');
  if (btn) { btn.classList.toggle('on', !!on); btn.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  if (aiInput) {
    aiInput.placeholder = on
      ? (agentLang() === 'vi' ? 'Giao nhiệm vụ: vd. "tìm phim hay trên youtube và mở video đầu"' : 'Give a task: e.g. "search cats on youtube and open the first video"')
      : 'Ask anything…';
  }
  if (hint) {
    hint.hidden = !on;
    hint.textContent = agentLang() === 'vi'
      ? 'Chế độ Agent: AI tự thao tác trên trang đang mở (mở link, gõ, bấm, cuộn). Việc nhạy cảm cần bạn xác nhận; không bao giờ nhập mật khẩu/thẻ. Bấm Stop để dừng.'
      : 'Agent mode: the AI operates the open page (open links, type, click, scroll). Sensitive steps need your confirmation; it never enters passwords/cards. Tap Stop to halt.';
  }
  try { localStorage.setItem('solo_agent_mode', on ? '1' : '0'); } catch (_) {}
}
document.getElementById('agentToggle')?.addEventListener('click', () => {
  applyAgentMode(!document.getElementById('agentToggle').classList.contains('on'));
  agentCtx = null;
});
try { if (localStorage.getItem('solo_agent_mode') === '1') applyAgentMode(true); } catch (_) {}

function agentUi(show) {
  const bar = document.getElementById('agentBar');
  if (bar) bar.hidden = !show;
  const ov = document.getElementById('aiOverlay');
  if (show) { if (ov) ov.hidden = true; setFabVisible(false); }
  else { if (ov) ov.hidden = false; setFabVisible(false); }
}
document.getElementById('agentStop')?.addEventListener('click', () => window.SoloAgent && window.SoloAgent.stop());

async function runAgentTask(text) {
  const vi = agentLang() === 'vi';
  if (!window.SoloAgent) { appendMsg('ai', escapeHtml(vi ? 'Module Agent chưa tải.' : 'Agent module not loaded.')); return; }
  if (window.SoloAgent.isRunning()) { appendMsg('ai', escapeHtml(vi ? 'Agent đang chạy.' : 'Agent is already running.')); return; }
  let task = text;
  let history = [];
  if (/^\/new\s+/i.test(text)) { agentCtx = null; task = text.replace(/^\/new\s+/i, ''); }
  else if (agentCtx) { task = agentCtx.task + '\nUser follow-up/answer: ' + text; history = agentCtx.history; }
  agentCtx = null;

  const statusEl = document.getElementById('agentStatus');
  const confirmBox = document.getElementById('agentConfirm');
  const confirmText = document.getElementById('agentConfirmText');
  const yes = document.getElementById('agentYes');
  const no = document.getElementById('agentNo');
  let answerFn = null;
  const onYes = () => { if (answerFn) answerFn(true); };
  const onNo = () => { if (answerFn) answerFn(false); };
  yes?.addEventListener('click', onYes);
  no?.addEventListener('click', onNo);
  agentUi(true);
  if (statusEl) statusEl.textContent = vi ? 'Bắt đầu…' : 'Starting…';

  const out = await window.SoloAgent.run(task, {
    onStatus(t) { if (statusEl) statusEl.textContent = t; },
    onStep(s) {
      appendMsg('agent-step ai', '<b>' + s.n + '.</b> ' + escapeHtml(s.text) + (s.thought ? '<small>' + escapeHtml(s.thought) + '</small>' : ''));
    },
    onConfirm(t, answer) {
      answerFn = (v) => { answerFn = null; if (confirmBox) confirmBox.hidden = true; answer(v); };
      if (confirmText) confirmText.textContent = (vi ? 'AI muốn: ' : 'AI wants to: ') + t + (vi ? '. Cho phép?' : '. Allow?');
      if (confirmBox) confirmBox.hidden = false;
    }
  }, { history });

  yes?.removeEventListener('click', onYes);
  no?.removeEventListener('click', onNo);
  if (confirmBox) confirmBox.hidden = true;
  agentUi(false);

  const msg = out.message ? escapeHtml(out.message).replace(/\n/g, '<br>') : '';
  if (out.status === 'done') appendMsg('ai', '✅ ' + (msg || (vi ? 'Xong.' : 'Done.')));
  else if (out.status === 'ask') { agentCtx = { task, history: out.history }; appendMsg('ai', '❓ ' + msg); }
  else if (out.status === 'stopped') appendMsg('ai', '⏹ ' + escapeHtml(vi ? 'Đã dừng theo yêu cầu.' : 'Stopped.'));
  else if (out.status === 'limit') appendMsg('ai', '⏱ ' + msg);
  else if (out.status === 'fail') appendMsg('ai', '⚠️ ' + msg);
  else appendMsg('ai', '⚠️ ' + (msg || escapeHtml(vi ? 'Agent lỗi.' : 'Agent error.')));
}
