
function ensureAgentTimeSetting() {
  try {
    // Must bind to settings body pane — NEVER the tab button [data-tab="settings"]
    const host =
      document.querySelector('#pane-settings .settings-body') ||
      document.getElementById('pane-settings') ||
      document.getElementById('ai-settings') ||
      document.getElementById('settings-pane');
    if (!host) return;
    document.querySelectorAll('.panel-tabs #agent-time-limit, .tab #agent-time-limit, .panel-tabs .agent-time-field').forEach((el) => {
      try {
        const row = el.closest('.agent-time-field') || el.closest('label') || el;
        if (row && !host.contains(row)) row.remove();
      } catch (_) {}
    });
    const existing = host.querySelector('#agent-time-limit');
    if (existing) {
      if (!existing.dataset.bound) {
        existing.dataset.bound = '1';
        existing.value = localStorage.getItem('solo_agent_time_min') || existing.value || '60';
        existing.addEventListener('change', (e) => {
          const v = Math.max(5, Math.min(180, Number(e.target.value) || 60));
          localStorage.setItem('solo_agent_time_min', String(v));
          e.target.value = String(v);
        });
      }
      return;
    }
    const row = document.createElement('div');
    row.className = 'settings-field agent-time-field';
    row.style.cssText = 'display:block;margin:12px 0 4px;clear:both;position:relative;z-index:0';
    const vi = (typeof isVi === 'function' && isVi());
    const label = vi ? 'Giới hạn thời gian Agent (phút)' : 'Agent time limit (minutes)';
    const hint = vi
      ? 'Mỗi nhiệm vụ Agent tối đa số phút này (mặc định 60). Có thể bấm Tiếp tục để resume.'
      : 'Each Agent task runs up to this many minutes (default 60). Use Continue to resume.';
    row.innerHTML =
      '<label for="agent-time-limit" style="display:block;font-size:12px;opacity:.75;margin:0 0 4px">' + label + '</label>' +
      '<input type="number" id="agent-time-limit" min="5" max="180" step="5" value="' +
        (localStorage.getItem('solo_agent_time_min') || '60') +
      '" style="width:100%;box-sizing:border-box;min-height:40px;padding:8px 10px;border-radius:8px;background:#120f22;color:#fff;border:1px solid #445">' +
      '<p style="font-size:11px;opacity:.6;margin:6px 0 0;line-height:1.35">' + hint + '</p>';
    const anchor = host.querySelector('#setSave, #btnSaveSettings, .settings-actions, #setTest');
    if (anchor && anchor.parentNode === host) host.insertBefore(row, anchor);
    else host.appendChild(row);
    const input = row.querySelector('#agent-time-limit');
    if (input) {
      input.dataset.bound = '1';
      input.addEventListener('change', (e) => {
        const v = Math.max(5, Math.min(180, Number(e.target.value) || 60));
        localStorage.setItem('solo_agent_time_min', String(v));
        e.target.value = String(v);
      });
    }
  } catch (_) {}
}
'use strict';
/**
 * SoloHost Browser AI panel controller.
 * Host app may copy to public/ai-panel.js and adapt browserContext() / executeActions().
 * Depends on: UniversalAI, UniversalFeedback, markup in example/ui/ai-panel.html, styles in ai-panel.css.
 */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/** NFC + strip bidi/control junk so Vietnamese diacritics stay intact through IME → fetch → AI. */
function normalizeChatText(s) {
  let t = String(s == null ? '' : s);
  try { t = t.normalize('NFC'); } catch (_) {}
  // Remove bidi marks and most C0 controls except tab/newline
  t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '');
  return t.trim();
}
function looksVietnamese(s) {
  return /[ăâêôơưđĂÂÊÔƠƯĐáàảãạắằẳẵặấầẩẫậéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i.test(String(s || ''));
}
let _imeComposing = false;
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
    version: '10.31.1'
  };
}
const aiChat = document.getElementById('chatLog') || document.getElementById('aiChat');
const aiInput = document.getElementById('chatInput') || document.getElementById('aiInput');
function formatAgentHtml(raw) {
  const esc = (v) => escapeHtml(String(v == null ? '' : v));
  const safeHref = (v) => {
    try { const u = new URL(String(v || '').trim()); return /^https?:$/.test(u.protocol) ? u.href : ''; }
    catch (_) { return ''; }
  };
  let text = String(raw || '').replace(/\r\n?/g, '\n');
  const codeBlocks = [];
  text = text.replace(/```(?:[\w+-]+)?\n?([\s\S]*?)```/g, (_, code) => {
    const i = codeBlocks.push('<pre class="agent-code-block"><code>' + esc(code.replace(/^\n+|\n+$/g, '')) + '</code></pre>') - 1;
    return '\u0000CODE' + i + '\u0000';
  });
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const rows = [line]; i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      i--;
      const cells = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
      const head = cells(rows[0]);
      let html = '<div class="agent-md-table-wrap" style="overflow-x:auto"><table class="agent-md-table"><thead><tr>' + head.map(c => '<th>' + esc(c) + '</th>').join('') + '</tr></thead><tbody>';
      rows.slice(1).forEach(r => { html += '<tr>' + cells(r).map(c => '<td>' + esc(c) + '</td>').join('') + '</tr>'; });
      out.push(html + '</tbody></table></div>'); continue;
    }
    let v = esc(line);
    v = v.replace(/^###\s+(.+)$/, '<h4 class="agent-h">$1</h4>').replace(/^##\s+(.+)$/, '<h3 class="agent-h">$1</h3>').replace(/^#\s+(.+)$/, '<h2 class="agent-h">$1</h2>');
    v = v.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`\n]+)`/g, '<code>$1</code>');
    // Markdown links are parsed before bare URLs; only HTTP(S) destinations survive.
    v = v.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+(?:\([^\s)]*\)[^\s)]*)?)\)/g, (_, label, href) => {
      const clean = safeHref(href); return clean ? '<a class="agent-link" href="' + esc(clean) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>' : label;
    });
    v = v.replace(/https?:\/\/[^\s<]+/g, (token) => {
      let url = token;
      while (/[.,;:!?]$/.test(url)) url = url.slice(0, -1);
      while (url.endsWith(')') && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) url = url.slice(0, -1);
      const clean = safeHref(url); if (!clean) return token;
      const tail = token.slice(url.length);
      return '<a class="agent-link" href="' + esc(clean) + '" target="_blank" rel="noopener noreferrer">' + esc(url) + '</a>' + esc(tail);
    });
    if (/^\s*[-*]\s+/.test(line)) v = '• ' + v.replace(/^\s*[-*]\s+/, '');
    else if (/^\s*\d+[.)]\s+/.test(line)) v = v.replace(/^\s*(\d+[.)])\s+/, '$1 ');
    out.push(v || '<br>');
  }
  let html = out.join('<br>');
  html = html.replace(/\u0000CODE(\d+)\u0000/g, (_, n) => codeBlocks[Number(n)] || '');
  return html;
}

/** Static professional report card for completed agent tasks. */
function renderAgentReportCard(out, vi) {
  const report = out.report || null;
  const bodyMd = out.message || (report && report.markdown) || '';
  const wrap = document.createElement('div');
  wrap.className = 'agent-report-card';
  const head = document.createElement('div');
  head.className = 'agent-report-head';
  head.innerHTML = '<span class="agent-report-badge">✅ ' + (vi ? 'Báo cáo hoàn thành' : 'Completion report') + '</span>' +
    '<button type="button" class="agent-report-open" title="Open full">' + (vi ? 'Mở rộng' : 'Expand') + '</button>' +
    '<button type="button" class="agent-report-copy" title="Copy">' + (vi ? 'Sao chép' : 'Copy') + '</button>';
  const body = document.createElement('div');
  body.className = 'agent-report-body msg-body';
  body.innerHTML = formatAgentHtml(bodyMd);
  // Extra structured sections from report object
  if (report) {
    const extra = document.createElement('div');
    extra.className = 'agent-report-extra';
    if (report.links && report.links.length) {
      extra.innerHTML += '<h4 class="agent-h">' + (vi ? 'Liên kết tham chiếu' : 'Reference links') + '</h4><ul class="agent-ref-list">' +
        report.links.slice(0, 40).map(function (u) {
          return '<li><a class="agent-link" href="' + escapeHtml(u) + '" target="_blank" rel="noopener">' + escapeHtml(u) + '</a></li>';
        }).join('') + '</ul>';
    }
    if (report.media && report.media.length) {
      extra.innerHTML += '<h4 class="agent-h">' + (vi ? 'Media' : 'Media') + '</h4><div class="agent-media-grid">' +
        report.media.slice(0, 24).map(function (u) {
          if (/\.(png|jpe?g|gif|webp)(\?|$)/i.test(u)) {
            return '<a href="' + escapeHtml(u) + '" target="_blank" rel="noopener"><img class="agent-embed-img" src="' + escapeHtml(u) + '" loading="lazy" alt=""></a>';
          }
          return '<a class="agent-link" href="' + escapeHtml(u) + '" target="_blank" rel="noopener">' + escapeHtml(u) + '</a>';
        }).join('') + '</div>';
    }
    if (report.limitations || (report.sources_status && Object.keys(report.sources_status).length)) {
      const lim = report.limitations || '';
      extra.innerHTML += '<h4 class="agent-h">' + (vi ? 'Phạm vi & hạn chế' : 'Scope & limitations') + '</h4><p>' + escapeHtml(lim || (vi ? 'Một số nguồn có thể chưa truy cập được.' : 'Some sources may be incomplete.')) + '</p>';
    }
    if (report.steps && report.steps.length) {
      extra.innerHTML += '<details class="agent-steps"><summary>' + (vi ? 'Các bước (' + report.steps.length + ')' : 'Steps (' + report.steps.length + ')') + '</summary><ol>' +
        report.steps.map(function (s) {
          return '<li>' + escapeHtml((s.action || s.thought || '') + (s.url ? ' — ' + s.url : '')) + '</li>';
        }).join('') + '</ol></details>';
    }
    body.appendChild(extra);
  }
  wrap.appendChild(head);
  wrap.appendChild(body);
  // Open full static page in new browser tab inside SoloHost
  head.querySelector('.agent-report-open')?.addEventListener('click', function () {
    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Agent Report</title><style>body{font-family:system-ui,sans-serif;max-width:820px;margin:24px auto;padding:0 16px;line-height:1.55;color:#111}' +
      'a{color:#1d4ed8;word-break:break-all}pre{background:#f4f4f5;padding:12px;overflow:auto;border-radius:8px}' +
      'img{max-width:100%;border-radius:8px}h2,h3,h4{margin:1.2em 0 .4em}.agent-link{word-break:break-all}</style></head><body>' +
      body.innerHTML + '</body></html>';
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  });
  head.querySelector('.agent-report-copy')?.addEventListener('click', function () {
    try {
      navigator.clipboard.writeText(bodyMd);
      appendMsg('ai', vi ? 'Đã sao chép báo cáo.' : 'Report copied.');
    } catch (_) {}
  });
  if (aiChat) {
    const div = document.createElement('div');
    div.className = 'msg ai agent-report-msg';
    div.appendChild(wrap);
    aiChat.appendChild(div);
    aiChat.scrollTop = aiChat.scrollHeight;
  }
  return wrap;
}

function appendMsg(role, html) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  const isAgent = /\bagent-step\b/.test(role);
  const isUser = /\buser\b/.test(role);
  let icon = '';
  if (isUser) icon = '<span class="msg-icon" aria-hidden="true">👤</span>';
  else if (isAgent) icon = '<span class="msg-icon" aria-hidden="true">⚙️</span>';
  else if (/\blimit\b/.test(role)) icon = '<span class="msg-icon" aria-hidden="true">⏱</span>';
  else icon = '<span class="msg-icon" aria-hidden="true">✦</span>';
  const body = document.createElement('div');
  body.className = 'msg-body';
  body.innerHTML = formatAgentHtml(html);
  div.appendChild(document.createRange().createContextualFragment(icon));
  div.appendChild(body);
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
  // Actions are dispatched once by sendAI(); do not also execute them from UniversalAI.onActions.
});

// Long-lived conversation + user memory are stored in the app data volume by profile ID.
let aiMemory = { profileId: '', memories: [], skills: [], history: [] };
let aiMemoryReady = false;
function memoryProfileId() {
  try {
    let id = localStorage.getItem('solo_ai_profile_id');
    if (/^[a-f0-9]{32}$/i.test(id || '')) return id.toLowerCase();
    const bytes = new Uint8Array(16);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    id = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('solo_ai_profile_id', id); return id;
  } catch (_) { return '00000000000000000000000000000001'; }
}
async function loadAIMemory() {
  try { ensureAgentTimeSetting(); } catch(_){}

  if (aiMemoryReady) return aiMemory;
  aiMemory.profileId = memoryProfileId();
  try {
    const r = await fetch('/api/ai/memory?profile=' + encodeURIComponent(aiMemory.profileId), { cache: 'no-store' });
    const j = await r.json(); if (j && j.ok && j.memory) aiMemory = Object.assign(aiMemory, j.memory, { profileId: aiMemory.profileId });
  } catch (_) {
    try { aiMemory.history = JSON.parse(localStorage.getItem('solo_ai_history') || '[]').slice(-40); } catch (_) {}
  }
  aiMemoryReady = true;
  if (aiChat && aiChat.children.length === 0) (aiMemory.history || []).slice(-24).forEach(m => appendMsg(m.role === 'user' ? 'user' : 'ai', escapeHtml(m.content || '').replace(/\n/g, '<br>')));
  return aiMemory;
}
async function saveMemoryRecord(type, values) {
  await loadAIMemory();
  try {
    const r = await fetch('/api/ai/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ profile: aiMemory.profileId, type }, values || {})) });
    const j = await r.json(); if (j && j.ok && j.memory) aiMemory = Object.assign(aiMemory, j.memory, { profileId: aiMemory.profileId });
    return !!(j && j.ok);
  } catch (_) { return false; }
}
async function persistTurn(user, assistant) {
  await saveMemoryRecord('turn', { user: String(user || '').slice(0, 12000), assistant: String(assistant || '').slice(0, 3000) });
  try { localStorage.setItem('solo_ai_history', JSON.stringify((aiMemory.history || []).slice(-40))); } catch (_) {}
}
function memoryIntent(text) {
  const t = String(text || '').trim();
  if (/^(?:\/forget\s+memory|forget all (?:my )?memories|xóa toàn bộ bộ nhớ|xoa het bo nho)$/i.test(t)) return { clear: true };
  const skill = t.match(/^(?:please\s+)?(?:hãy\s+)?(?:lưu|luu|save)\s+(?:lại\s+)?(?:skill|kỹ năng|ky nang)\s*[:：-]?\s*(.+)$/i);
  if (skill) { const body = skill[1].trim(); const parts = body.split(/\s*[:：]\s*/); return { skill: true, name: parts.length > 1 ? parts.shift().slice(0, 100) : 'Reusable skill', content: parts.join(': ').slice(0, 1500) || body }; }
  const m = t.match(/^(?:hãy\s+)?(?:ghi nhớ|ghi nho|nhớ rằng|nho rang|remember that|please remember|always remember)\s*[:：,-]?\s*(.+)$/i);
  if (m) return { memory: true, content: m[1].slice(0, 1500) };
  return null;
}
function stablePreference(text, history) {
  const t = String(text || '').trim();
  if (!/(?:từ nay|tu nay|always|prefer|ưu tiên|uu tien|hãy nhớ|remember|trả lời|tra loi|reply in|keep it|ngắn gọn|short answers)/i.test(t)) return false;
  const key = t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 120);
  const count = (history || []).filter(m => m && m.role === 'user' && String(m.content || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 120) === key).length;
  return count >= 2;
}

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
    const actionValue = args.url || args.value || a.url || a.value || '';
    try {
      if (name === 'open_url' && actionValue && window.SoloBrowser && window.SoloBrowser.navigate) {
        await window.SoloBrowser.navigate(String(actionValue), { force: true });
      } else if (name === 'open_security') {
        window.open('/security.html', '_blank', 'noopener');
      } else if (name === 'open_tab') {
        document.querySelector('.tab[data-tab="' + String(actionValue || 'chat').replace(/[^a-z-]/gi, '') + '"]')?.click();
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

function parseRequestedTime(text) {
  const t = String(text || '').toLowerCase();
  const marker = /(?:at|to|set(?:\s+it)?\s+to|change(?:\s+it)?\s+to|lúc|vào lúc|sang|thành|đến|giờ|time(?:\s+to)?)\s*(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<suffix>am|pm|h|giờ)?/i;
  const explicit = /\b(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<suffix>am|pm|h|giờ)\b/i;
  const colon = /\b(?<hour>\d{1,2}):(?<minute>\d{2})\s*(?<suffix>am|pm)?\b/i;
  const m = t.match(marker) || t.match(explicit) || t.match(colon);
  if (!m || !m.groups) return null;
  let hour = Number(m.groups.hour), minute = Number(m.groups.minute || 0); const suffix = String(m.groups.suffix || '').toLowerCase();
  if (suffix === 'pm' && hour < 12) hour += 12; if (suffix === 'am' && hour === 12) hour = 0;
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 23 || minute > 59) return null;
  return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
}
async function modifyRecentTask(text) {
  const raw = String(text || '');
  // Never hijack multi-step agent briefs or long role prompts
  if (raw.length > 350) return null;
  if (/role\s*:|goal\s*:|step-by-step|required output|guardrails|markdown/i.test(raw)) return null;
  if (/(?:hãy thực hiện|hay thuc hien|làm đi|lam di|thực hiện ngay|thuc hien ngay|execute now|run this task)/i.test(raw) && raw.length > 80) return null;
  const t = raw.toLowerCase();
  // "dừng lại trước bước…" in agent briefs is NOT pause-task intent
  const changeIntent = /(?:đổi|doi|thay đổi|thay doi|sửa|sua|chỉnh|chinh|change|modify|update|make it|set it|pause|resume|disable|enable|tạm dừng|tam dung|bật lại|bat lai|tắt nhiệm vụ|tat nhiem vu)/i.test(t)
    && !/dừng lại trước|dung lai truoc|stop immediately before|do not (?:enter|perform) (?:any )?payment/i.test(t);
  const taskReference = /(?:task|nhiệm vụ|nhiem vu|lịch phát|lich phat|schedule|giờ đó|gio do|lúc đó|luc do|repeat|duration|phút|phut|minutes?)/i.test(t);
  if (!changeIntent || !taskReference) return null;
  await loadAIMemory();
  let taskId = '';
  try { taskId = localStorage.getItem('solo_ai_last_task_id') || ''; } catch (_) {}
  let tasks = [];
  try { const r = await fetch('/api/library/tasks', { cache: 'no-store' }); const j = await r.json(); tasks = j.tasks || []; } catch (_) {}
  let task = tasks.find(x => x.id === taskId);
  if (!task) task = tasks.filter(x => x && !x.sample && !x.deleted).sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
  if (!task) return null;
  const patch = {};
  if (/(?:pause|disable|stop|tạm dừng|tam dung|tắt nhiệm vụ|tat nhiem vu|dừng lịch|dung lich)/i.test(t)) patch.active = false;
  else if (/(?:resume|enable|bật lại|bat lai|tiếp tục lịch|tiep tuc lich)/i.test(t)) patch.active = true;
  const time = parseRequestedTime(text);
  const durationMatch = t.match(/(\d+)\s*(?:phút|phut|minutes?|mins?)/i) || t.match(/(\d+)\s*(?:tiếng|tieng|giờ|hours?|hrs?)/i);
  if (time || durationMatch || /repeat|lặp|lap|every day|daily|hằng ngày|hang ngay/i.test(t)) {
    const schedule = Object.assign({ type: 'daily', time: '21:00' }, task.schedule || {});
    if (time) schedule.time = time;
    if (durationMatch) { const n = Number(durationMatch[1]); schedule.durationMinutes = Math.max(1, Math.min(720, n * (/tiếng|tieng|giờ|hours?|hrs?/i.test(durationMatch[0]) ? 60 : 1))); }
    if (/(?:every day|daily|hằng ngày|hang ngay|mỗi ngày|moi ngay)/i.test(t)) schedule.type = 'daily';
    patch.schedule = schedule;
  }
  if (!Object.keys(patch).length) return null;
  const response = await fetch('/api/library/scripts/' + encodeURIComponent(task.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  const result = await response.json();
  if (!response.ok || !result.ok || !result.script) throw new Error(result.error || 'Could not update the saved AI task');
  try { localStorage.setItem('solo_ai_last_task_id', result.script.id); } catch (_) {}
  return result.script;
}

async function sendAI() {
  if (_imeComposing) return; // never commit mid-IME composition (Android VN keyboards)
  const text = normalizeChatText(aiInput && aiInput.value);
  if (!text) return;
  aiInput.value = '';
  // Keep app language aligned with the message the user actually typed
  try {
    if (looksVietnamese(text)) {
      if (window.SoloBrowser && window.SoloBrowser.state) window.SoloBrowser.state.lang = 'vi';
      document.documentElement.lang = 'vi';
      try { localStorage.setItem('solo_lang', 'vi'); } catch (_) {}
    }
  } catch (_) {}
  appendMsg('user', escapeHtml(text));
  await loadAIMemory();
  const intent = memoryIntent(text);
  if (intent && intent.clear) {
    try { await fetch('/api/ai/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile: aiMemory.profileId, type: 'clear' }) }); } catch (_) {}
    aiMemory = { profileId: aiMemory.profileId, memories: [], skills: [], history: [] };
    try { localStorage.removeItem('solo_ai_history'); } catch (_) {}
    appendMsg('ai', escapeHtml(agentLang() === 'vi' ? 'Đã xóa bộ nhớ và lịch sử hội thoại đã lưu.' : 'Saved memory and conversation history have been cleared.'));
    return;
  }
  if (intent && intent.memory) {
    const ok = await saveMemoryRecord('memory', { content: intent.content });
    if (ok) appendMsg('ai', escapeHtml(agentLang() === 'vi' ? 'Đã lưu vào bộ nhớ dài hạn. Tôi sẽ dùng điều này trong các cuộc trò chuyện sau.' : 'Saved to long-term memory. I will use this in future conversations.'));
    else appendMsg('ai', escapeHtml(agentLang() === 'vi' ? 'Không thể lưu nội dung này. Thông tin nhạy cảm như mật khẩu/token không được lưu.' : 'Could not save this. Sensitive details such as passwords or tokens are not stored.'));
    await persistTurn(text, intent.content ? 'Saved memory: ' + intent.content : 'Memory updated');
    return;
  }
  if (intent && intent.skill) {
    const ok = await saveMemoryRecord('skill', { name: intent.name, content: intent.content });
    appendMsg('ai', escapeHtml(ok ? (agentLang() === 'vi' ? 'Đã lưu skill có thể tái sử dụng: ' : 'Saved reusable skill: ') + intent.name : (agentLang() === 'vi' ? 'Không lưu được skill; hãy kiểm tra nội dung có chứa bí mật hay không.' : 'Could not save this skill; check that it contains no secrets.')));
    await persistTurn(text, ok ? 'Saved skill: ' + intent.name : 'Skill not saved');
    return;
  }
  // Multi-step agent briefs run immediately (never mis-route to schedule/task patch)
  if (isAgentBrief(text) || shouldRunAgent(text)) {
    // Prefer agent over local one-shot when the request is a long brief
    if (isAgentBrief(text) || (shouldRunAgent(text) && String(text).length > 120)) {
      await runAgentTask(text);
      return;
    }
  }
  try {
    const updatedTask = await modifyRecentTask(text);
    if (updatedTask) {
      const vi = agentLang() === 'vi';
      const schedule = updatedTask.schedule || {};
      const reply = (vi ? 'Đã cập nhật nhiệm vụ “' : 'Updated task “') + (vi ? (updatedTask.nameVi || updatedTask.name) : updatedTask.name) + '”: ' + (updatedTask.active === false ? (vi ? 'đã tạm dừng' : 'paused') : (vi ? 'đang bật' : 'enabled')) + (schedule.time ? (vi ? ', giờ chạy ' : ', scheduled at ') + schedule.time : '') + (schedule.durationMinutes ? (vi ? ', thời lượng ' : ', duration ') + schedule.durationMinutes + (vi ? ' phút.' : ' minutes.') : '.');
      appendMsg('ai', escapeHtml(reply)); await persistTurn(text, reply); if (window.SoloBrowser && window.SoloBrowser.showTasksPanel) window.SoloBrowser.showTasksPanel(); return;
    }
  } catch (e) { appendMsg('ai', escapeHtml(e.message || 'Task update failed')); await persistTurn(text, e.message || 'Task update failed'); return; }
  // 1) Fast path: clear open/search intents execute immediately (no AI delay)
  const localAct = resolveLocalBrowserAction(text);
  if (localAct) {
    const ok = await executeLocalBrowserAction(localAct, text);
    if (ok) return;
  }
  // 2) Complex browser ops → Agent; pure Q&A stays in chat
  if (shouldRunAgent(text)) { await runAgentTask(text); return; }
  const taskIntent = /(?:mỗi ngày|hằng ngày|hang ngay|daily|every day|lúc \d{1,2}|\d{1,2}\s*(?:h|giờ)|schedule|đặt lịch|dat lich)/i.test(text) && /youtube|nhạc|nhac|music|thiền|thien|meditation|lofi|video|mở|mo/i.test(text);
  if (taskIntent) {
    const loadingTask = appendMsg('ai', '…');
    try {
      const tr = await fetch('/api/library/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction: text }) });
      const tj = await tr.json(); loadingTask.remove();
      if (tj.ok && tj.task) {
        try { localStorage.setItem('solo_ai_last_task_id', tj.task.id); } catch (_) {}
        const vi = document.documentElement.lang === 'vi' || (navigator.language || '').toLowerCase().startsWith('vi') || /[ăâđêôơưáàảãạ]/i.test(text);
        const taskName = vi ? (tj.task.nameVi || tj.task.name) : tj.task.name;
        const reply = (vi ? 'Đã tạo nhiệm vụ AI: ' : 'AI task created: ') + taskName + '. ' + (vi ? 'Nhiệm vụ chạy theo múi giờ cấu hình khi trình duyệt đang mở. Bạn có thể xem hoặc tạm dừng trong mục Nhiệm vụ AI.' : 'It runs in the configured time zone while the browser is open. View or pause it under AI Tasks.');
        appendMsg('ai', escapeHtml(reply)); await persistTurn(text, reply);
        if (window.SoloBrowser && window.SoloBrowser.showTasksPanel) window.SoloBrowser.showTasksPanel();
        else document.querySelector('[data-panel="panel-scripts"]')?.click();
        return;
      }
      const reply = (tj && tj.error) || 'Could not create the task.'; appendMsg('ai', escapeHtml(reply)); await persistTurn(text, reply); return;
    } catch (e) { loadingTask.remove(); const reply = e.message || 'Task creation failed'; appendMsg('ai', escapeHtml(reply)); await persistTurn(text, reply); return; }
  }
  const loading = appendMsg('ai', '…');
  try {
    let logs = [];
    try { const lr = await fetch('/api/logs').then(r => r.json()); logs = (lr.logs || []).filter(l => l && l.level !== 'debug').slice(-8).map(l => ({ level: l.level, event: l.event || l.message || '', at: l.at || l.timestamp || '' })); } catch (_) {}
    const ctx = Object.assign(browserContext(), { aiMemory: { memories: (aiMemory.memories || []).map(x => x.content).slice(0, 30), skills: (aiMemory.skills || []).map(x => ({ name: x.name, content: x.content })).slice(0, 20), profileUpdatedAt: aiMemory.updatedAt || null }, conversationSummary: (aiMemory.history || []).slice(-12).map(m => ({ role: m.role, content: String(m.content || '').slice(0, 1200) })), logs });
    const out = await ai.chat(text, ctx, { history: (aiMemory.history || []).slice(-16) });
    if (out && Array.isArray(out.actions) && out.actions.length) await applyAiActions(out.actions);
    else if (out && out.reply) {
      // Provider said it would open a site but forgot structured actions — recover
      const recovered = resolveLocalBrowserAction(text) || resolveLocalBrowserAction(out.reply);
      if (recovered && window.SoloBrowser && window.SoloBrowser.navigate) {
        try { await window.SoloBrowser.navigate(String(recovered.url), { force: true }); } catch (_) {}
      }
    }
    for (const suggestion of (out.memorySuggestions || []).slice(0, 3)) {
      if (suggestion && suggestion.content) await saveMemoryRecord('memory', { content: suggestion.content });
    }
    loading.remove();
    const local = out.source === 'local' || out.configured === false;
    const reply = out.reply || 'Không có phản hồi';
    appendMsg('ai', escapeHtml(reply).replace(/\n/g, '<br>') + (local ? '<div style="opacity:.55;font-size:.75rem">Local guide</div>' : ''));
    if (stablePreference(text, aiMemory.history)) await saveMemoryRecord('memory', { content: 'Repeated preference: ' + text.slice(0, 500) });
    await persistTurn(text, reply);
  } catch (e) {
    loading.remove(); const reply = e.message || 'AI connection failed'; appendMsg('ai', escapeHtml(reply)); await persistTurn(text, reply);
  }
}
document.getElementById('aiSend')?.addEventListener('click', sendAI);
document.getElementById('chatSend')?.addEventListener('click', (e) => { e.preventDefault(); sendAI(); });
document.getElementById('chatForm')?.addEventListener('submit', (e) => { e.preventDefault(); sendAI(); });
(function bindChatInputIme() {
  const el = document.getElementById('chatInput') || document.getElementById('aiInput');
  if (!el || el.dataset.imeBound === '1') return;
  el.dataset.imeBound = '1';
  el.addEventListener('compositionstart', () => { _imeComposing = true; });
  el.addEventListener('compositionend', (e) => {
    _imeComposing = false;
    // Some Android IMEs leave decomposed marks — normalize in-place
    try {
      const v = normalizeChatText(el.value);
      if (v !== el.value) {
        const pos = el.selectionStart;
        el.value = v;
        try { el.setSelectionRange(pos, pos); } catch (_) {}
      }
    } catch (_) {}
  });
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    // During IME composition Enter often means "confirm candidate", not "send"
    if (_imeComposing || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    sendAI();
  });
})();
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
      if (l.taskId) bits.push('taskId=' + l.taskId);
      if (l.action) bits.push('action=' + l.action);
      if (l.query) bits.push('query=' + String(l.query).slice(0, 80));
      if (l.engine) bits.push('engine=' + l.engine);
      if (l.outcome) bits.push('outcome=' + l.outcome);
      if (l.resultCount != null) bits.push('results=' + l.resultCount);
      if (l.code) bits.push('code=' + l.code);
      if (l.error) bits.push('error=' + String(l.error).slice(0, 160));
      const blocked = Array.isArray(l.blockedEngines) ? l.blockedEngines
        : (Array.isArray(l.blocked) ? l.blocked : (l.blocked ? [l.blocked] : []));
      if (blocked.length) bits.push('blockedEngines=' + blocked.filter(Boolean).join(','));
      if (l.status != null) bits.push('status=' + l.status);
      const dur = l.durationMs != null ? l.durationMs : l.ms;
      if (dur != null && dur !== '') bits.push('durationMs=' + dur);
      if (l.cached) bits.push('cached=1');
      if (l.provider) bits.push('provider=' + l.provider);
      if (l.model) bits.push('model=' + l.model);
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
  if (st) st.textContent = 'AI: ' + e.message;
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
// Unified conversational Agent. There is no separate AI Action/AI Panel switch.
// The same input automatically selects browser operation for imperative page tasks.
// ---------------------------------------------------------------------------
let agentCtx = null;
try { agentCtx = JSON.parse(localStorage.getItem('solo_agent_context') || 'null'); } catch (_) { agentCtx = null; }
function agentLang() {
  try {
    const st = window.SoloBrowser && window.SoloBrowser.state;
    if (st && st.lang === 'vi') return 'vi';
    if (document.documentElement.lang === 'vi') return 'vi';
    const nav = String(navigator.language || navigator.userLanguage || '').toLowerCase();
    if (nav.startsWith('vi')) return 'vi';
  } catch (_) {}
  return 'en';
}

function loadWorkMemory() {
  try { return JSON.parse(localStorage.getItem('solo_agent_work_memory') || 'null') || { taskId: null, task: '', status: '' }; }
  catch (_) { return { taskId: null, task: '', status: '' }; }
}
function saveWorkMemory(wm) {
  // Client stores only UI metadata. Findings, history, notes, errors and ledger are server-owned per task.
  const safe = { taskId: wm && wm.taskId || null, task: String(wm && wm.task || '').slice(0, 120), status: String(wm && wm.status || '').slice(0, 40), updatedAt: new Date().toISOString() };
  try { localStorage.setItem('solo_agent_work_memory', JSON.stringify(safe)); } catch (_) {}
}
function agentTimeLimitMs() {
  try {
    const min = Number(localStorage.getItem('solo_agent_time_min') || 60);
    return Math.max(60000, Math.min(3600000, (min || 60) * 60000));
  } catch (_) { return 3600000; }
}

/** CHAT | QUICK_LOOKUP | TASK — lean intent (mirrors lib/agent-intent.js) */
function classifyUserIntent(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  if (!t) return { kind: 'CHAT', reason: 'empty' };
  const low = t.toLowerCase();
  const isBrief = t.length > 500 || /role\s*:|goal\s*:|step-by-step|required output|guardrails/i.test(t)
    || /(?:hãy thực hiện|thực hiện ngay|execute now|run this task)/i.test(t);
  const isTask = isBrief
    || /(?:so sánh|so sanh|compare|versus|\bvs\.?\b)/i.test(low)
    || /(?:giá|price|bao nhiêu tiền|how much).{0,80}(?:rẻ|cheap|nơi bán|where to buy|nhà bán|retailer|store)/i.test(low)
    || /(?:nơi nào bán|where (?:can i )?buy|best price|giá rẻ nhất)/i.test(low)
    || /(?:tổng hợp|digest|tin tức|news).{0,40}(?:24\s*h|hôm nay|today|nhiều nguồn)/i.test(low)
    || /(?:nghiên cứu|research|deep dive|thu thập|extract)/i.test(low)
    || /(?:tìm\s+\d+|find\s+\d+|top\s*\d+|liệt kê)/i.test(low)
    || /(?:iphone|samsung|pixel|laptop|macbook).{0,60}(?:giá|price|bao nhiêu)/i.test(low)
    || /(?:giá|price).{0,60}(?:iphone|samsung|pixel|laptop|macbook)/i.test(low)
    || ((t.match(/https?:\/\/[^\s]+/gi) || []).length >= 2);
  if (isTask) return { kind: 'TASK', reason: 'multi_step_or_research' };
  if (/^https?:\/\//i.test(t) || /^(?:mở|open|truy cập|go to)\s+https?:\/\//i.test(t)) return { kind: 'QUICK_LOOKUP', reason: 'url' };
  if (/^(?:hãy\s+|please\s+)?(?:mở|open|tìm trên|search on)\s+(?:youtube|google|facebook|tiktok)\b/i.test(t)) return { kind: 'QUICK_LOOKUP', reason: 'single_site' };
  return { kind: 'CHAT', reason: 'conversational' };
}

function isAgentBrief(text) {
  const t = String(text || '');
  if (t.length > 500) return true;
  if (/role\s*:|goal\s*:|step-by-step instructions|required output format|guardrails/i.test(t)) return true;
  if (/(?:so sánh|so sanh|compare|thu thập|thu thap|extract|scraping|báo cáo|bao cao|markdown table|top 3)/i.test(t) && t.length > 200) return true;
  if (/(?:hãy thực hiện|hay thuc hien|thực hiện ngay|thuc hien ngay|làm đi|lam di|execute (?:now|this)|run (?:this )?task|bắt đầu ngay|bat dau ngay)/i.test(t)) return true;
  return false;
}
function shouldRunAgent(text) {
  if (!window.SoloAgent) return false;
  if (agentCtx) return true;
  const c = classifyUserIntent(text);
  return c.kind === 'TASK';
}


/** Fast local browser action — no AI round-trip for clear open/search intents */
function resolveLocalBrowserAction(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 500) return null;
  const t = raw.replace(/^(?:hãy|vui lòng|giúp tôi|giup toi|please|can you|could you)\s+/i, '').trim();
  // Direct URL
  const urlM = t.match(/https?:\/\/[^\s<>"']+/i);
  if (urlM && /^(?:mở|mo|open|truy cập|truy cap|đi tới|di toi|go to|visit)\b/i.test(t)) {
    return { type: 'open_url', url: urlM[0], label: urlM[0] };
  }
  if (urlM && t === urlM[0]) return { type: 'open_url', url: urlM[0], label: urlM[0] };
  // YouTube search / open
  if (/youtube|\byt\b/i.test(t) && /mở|mo\b|open|tìm|tim|search|nghe|phát|phat|play|nhạc|nhac|music/i.test(t)) {
    let q = t
      .replace(/^(?:mở|mo|open|tìm(?:\s*kiếm)?|tim(?:\s*kiem)?|search|nghe|phát|phat|play)\s+/i, '')
      .replace(/\b(?:trên|on|trong|in|từ|from)\s+/gi, ' ')
      .replace(/\b(?:youtube|yt)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!q || q.length < 1) q = 'music';
    const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q);
    return { type: 'open_url', url: url, label: 'YouTube: ' + q };
  }
  // Google / Bing search
  if (/(?:google|bing)\b/i.test(t) && /mở|mo\b|open|tìm|tim|search/i.test(t)) {
    let q = t
      .replace(/^(?:mở|mo|open|tìm(?:\s*kiếm)?|tim(?:\s*kiem)?|search)\s+/i, '')
      .replace(/\b(?:trên|on|trong|in)\s+/gi, ' ')
      .replace(/\b(?:google|bing)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'news';
    const eng = /bing/i.test(t) ? 'bing' : 'google';
    const url = eng === 'bing'
      ? 'https://www.bing.com/search?q=' + encodeURIComponent(q)
      : 'https://www.google.com/search?q=' + encodeURIComponent(q);
    return { type: 'open_url', url: url, label: eng + ': ' + q };
  }
  // Generic "search X" / "tìm X"
  const sm = t.match(/^(?:tìm(?:\s*kiếm)?|tim(?:\s*kiem)?|search(?:\s+for)?)\s+(.+)$/i);
  if (sm && sm[1] && !/youtube|google|bing/i.test(t)) {
    const q = sm[1].trim();
    if (q.length >= 2) {
      return { type: 'open_url', url: 'https://www.bing.com/search?q=' + encodeURIComponent(q), label: 'Search: ' + q };
    }
  }
  return null;
}

async function executeLocalBrowserAction(action, text) {
  if (!action || !action.url) return false;
  const vi = agentLang() === 'vi';
  try {
    if (window.SoloBrowser && typeof window.SoloBrowser.navigate === 'function') {
      await window.SoloBrowser.navigate(String(action.url), { force: true });
      const reply = vi
        ? ('Đã mở: ' + (action.label || action.url))
        : ('Opened: ' + (action.label || action.url));
      appendMsg('ai', escapeHtml(reply));
      await persistTurn(text, reply);
      return true;
    }
  } catch (e) {
    appendMsg('ai', escapeHtml(String(e.message || e)));
  }
  return false;
}

function agentUi(show) {
  const bar = document.getElementById('agentBar');
  if (bar) bar.hidden = !show;
  const ov = document.getElementById('aiOverlay');
  if (show) { if (ov) ov.hidden = true; setFabVisible(false); }
  else { if (ov) ov.hidden = false; setFabVisible(false); }
}
document.getElementById('agentStop')?.addEventListener('click', () => window.SoloAgent && window.SoloAgent.stop());


function setAgentBusy(on, detail) {
  try {
    document.body.classList.toggle('agent-busy', !!on);
    let lock = document.getElementById('agent-browser-lock');
    if (on) {
      if (!lock) {
        lock = document.createElement('div');
        lock.id = 'agent-browser-lock';
        lock.className = 'agent-browser-lock';
        lock.innerHTML = '<div class="agent-browser-lock-card"><div class="agent-browser-lock-spin"></div><div class="agent-browser-lock-title" id="agent-lock-title">Agent running</div><div class="agent-browser-lock-sub" id="agent-lock-sub"></div></div>';
        document.body.appendChild(lock);
      }
      lock.hidden = false;
      lock.style.display = 'flex';
      const title = document.getElementById('agent-lock-title');
      const sub = document.getElementById('agent-lock-sub');
      const vi = agentLang() === 'vi';
      if (title) title.textContent = vi ? 'Browser Agent đang chạy' : 'Browser Agent running';
      if (sub) sub.textContent = detail || (vi ? 'Trình duyệt tạm khóa — xem tiến trình trong panel AI.' : 'Browser locked — follow progress in the AI panel.');
    } else if (lock) {
      lock.hidden = true;
      lock.style.display = 'none';
    }
  } catch (_) {}
}

function updateAgentLockProgress(text) {
  try {
    const sub = document.getElementById('agent-lock-sub');
    if (sub && text) sub.textContent = String(text).slice(0, 180);
  } catch (_) {}
}

async function runAgentTask(text) {
  const vi = agentLang() === 'vi';
  if (!window.SoloAgent) { setAgentBusy(false); appendMsg('ai', escapeHtml(vi ? 'Module Agent chưa tải.' : 'Agent module not loaded.')); return; }
  if (window.SoloAgent.isRunning()) {
    const steps = (agentCtx && agentCtx.history && agentCtx.history.length) || 0;
    appendMsg('ai', escapeHtml(vi
      ? ('Agent vẫn đang chạy nền (đã ghi nhận ~' + steps + ' bước). Không bắt đầu lại — mở tab Logs hoặc đợi báo cáo. Bấm Dừng nếu cần hủy.')
      : ('Agent is still running in the background (~' + steps + ' steps so far). Not restarting — check Logs or wait for the report. Tap Stop to cancel.')));
    setAgentBusy(true, vi ? 'Tiếp tục theo dõi tiến trình…' : 'Keep watching progress…');
    return;
  }
  let task = text;
  let history = [];
  if (/^\/new\s+/i.test(text)) {
    agentCtx = null;
    try { localStorage.removeItem('solo_agent_context'); } catch (_) {}
    saveWorkMemory({ notes: [], findings: [], lastUrl: '', progress: '', task: '', history: [] });
    task = text.replace(/^\/new\s+/i, '');
  } else if (agentCtx) {
    task = agentCtx.task || text;
    history = agentCtx.history || [];
  }
  let workMemory = loadWorkMemory();
  const sameTask = !!(agentCtx && agentCtx.taskId && workMemory.taskId === agentCtx.taskId);
  if (!sameTask) { history = []; workMemory = { taskId: null, task, status: 'new' }; }

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
  if (statusEl) statusEl.textContent = vi
    ? ('Bắt đầu · tối đa ' + Math.round(agentTimeLimitMs() / 60000) + ' phút' + (history.length ? ' · resume' : ''))
    : ('Starting · max ' + Math.round(agentTimeLimitMs() / 60000) + ' min' + (history.length ? ' · resume' : ''));

  setAgentBusy(true, vi ? 'Đang khởi chạy nhiệm vụ…' : 'Starting task…');
  let out;
  try {
  out = await window.SoloAgent.run(task, {
    onStatus(t) { if (statusEl) statusEl.textContent = t; updateAgentLockProgress(t); },
    onPlan(plan) { if (plan && Array.isArray(plan.steps) && plan.steps.length) { const titles = plan.steps.map((x, i) => (i + 1) + '. ' + (x.title || x)).join('\n'); appendMsg('agent-step ai', '🗺️ <b>' + escapeHtml(vi ? 'Kế hoạch' : 'Plan') + '</b><small>' + escapeHtml(titles) + '</small>'); } },
    onStep(s) {
      const icon = (s.action && s.action.type === 'navigate') ? '🌐' : (s.action && s.action.type === 'click') ? '👆' : (s.action && s.action.type === 'type') ? '⌨️' : (s.action && s.action.type === 'read') ? '📄' : '⚙️';
      const line = icon + ' <b>' + (s.n || '') + '.</b> ' + escapeHtml(s.text || '') + (s.thought ? '<small>' + escapeHtml(s.thought) + '</small>' : '');
      appendMsg('agent-step ai', line);
      updateAgentLockProgress((s.n ? ('#' + s.n + ' ') : '') + (s.text || ''));
    },
    onConfirm(t, answer) {
      answerFn = (v) => { answerFn = null; if (confirmBox) confirmBox.hidden = true; answer(v); };
      if (confirmText) confirmText.textContent = (vi ? 'AI muốn: ' : 'AI wants to: ') + t + (vi ? '. Cho phép?' : '. Allow?');
      if (confirmBox) confirmBox.hidden = false;
    },
    onLoginForm(ev) {
      appendMsg('ai', '🔐 ' + escapeHtml((ev && ev.message) || (vi ? 'Điền form trên khung trình duyệt' : 'Fill form in browser frame')));
    }
  }, { history, maxSteps: 200, maxMs: agentTimeLimitMs(), workMemory, resumeTaskId: (agentCtx && agentCtx.taskId && !/^\/new\s+/i.test(text)) ? agentCtx.taskId : null, clarification: (agentCtx && agentCtx.taskId && !agentCtx.continueOnly && !/^\/new\s+/i.test(text)) ? text : null });
  } catch (agentErr) {
    setAgentBusy(false);
    agentUi(false);
    yes?.removeEventListener('click', onYes);
    no?.removeEventListener('click', onNo);
    appendMsg('ai', '⚠️ ' + escapeHtml(String(agentErr && agentErr.message || agentErr || 'agent_failed').slice(0, 300)));
    showContinueBar(true);
    return;
  } finally {
    setAgentBusy(false);
  }

  yes?.removeEventListener('click', onYes);
  no?.removeEventListener('click', onNo);
  if (confirmBox) confirmBox.hidden = true;
  agentUi(false);

  setAgentBusy(false);
  // Save work memory for Continue
  saveWorkMemory({ taskId: out.taskId || (agentCtx && agentCtx.taskId) || null, task, status: out.status || '' });

  const msg = out.message ? formatAgentHtml(out.message) : '';
  if (out.status === 'done') {
    agentCtx = null;
    renderAgentReportCard(out, vi);
    // Also keep a short toast line for history continuity
    if (!out.message || String(out.message).length < 12) {
      appendMsg('ai', '✅ ' + (vi ? 'Đã hoàn tất — xem báo cáo đầy đủ phía trên.' : 'Finished — see full report above.'));
    }
    showContinueBar(false);
  } else if (out.status === 'ask') {
    agentCtx = { task, history: out.history, taskId: out.taskId || (agentCtx && agentCtx.taskId) || null };
    try { localStorage.setItem('solo_agent_context', JSON.stringify(agentCtx)); } catch (_) {}
    appendMsg('ai', '❓ ' + msg);
    showContinueBar(true);
  } else if (out.status === 'stopped') {
    agentCtx = { task, history: out.history, taskId: out.taskId || (agentCtx && agentCtx.taskId) || null };
    appendMsg('ai', '⏹ ' + escapeHtml(vi ? 'Đã dừng theo yêu cầu.' : 'Stopped.'));
    showContinueBar(true);
  } else if (out.status === 'limit') {
    agentCtx = { task, history: out.history, taskId: out.taskId || (agentCtx && agentCtx.taskId) || null };
    try { localStorage.setItem('solo_agent_context', JSON.stringify(agentCtx)); } catch (_) {}
    appendMsg('ai limit', '⏱ ' + msg);
    showContinueBar(true);
  } else if (out.status === 'fail') {
    appendMsg('ai', '⚠️ ' + msg);
    showContinueBar(true);
  } else {
    appendMsg('ai', '⚠️ ' + (msg || escapeHtml(vi ? 'Agent lỗi.' : 'Agent error.')));
  }
  const summary = (out.message || (out.status === 'done' ? (vi ? 'Đã hoàn tất tác vụ.' : 'Task completed.') : out.status));
  await persistTurn(text, String(summary).slice(0, 50000));
}

function showContinueBar(show) {
  let bar = document.getElementById('agent-continue-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'agent-continue-bar';
    bar.className = 'agent-continue-bar';
    bar.innerHTML = '<button type="button" id="btn-agent-continue" class="agent-continue-btn">▶ Continue</button>' +
      '<button type="button" id="btn-agent-clear-mem" class="agent-continue-btn ghost">Clear</button>';
    const host = document.getElementById('agentBar') || document.getElementById('ai-chat') || (typeof aiChat !== 'undefined' ? aiChat : null);
    if (host && host.parentNode) host.parentNode.insertBefore(bar, host.nextSibling);
    else document.body.appendChild(bar);
    document.getElementById('btn-agent-continue')?.addEventListener('click', async () => {
      const mem = loadWorkMemory();
      const taskText = (agentCtx && agentCtx.task) || mem.task || '';
      if (!taskText) return;
      if (window.SoloAgent && window.SoloAgent.isRunning()) {
        appendMsg('ai', escapeHtml(agentLang() === 'vi'
          ? 'Nhiệm vụ vẫn đang chạy — không bắt đầu lại. Đợi tiến trình hoặc bấm Dừng.'
          : 'Task still running — not restarting. Wait for progress or tap Stop.'));
        setAgentBusy(true);
        return;
      }
      if (agentCtx) agentCtx.continueOnly = true;
      showContinueBar(false);
      await runAgentTask(taskText);
    });
    document.getElementById('btn-agent-clear-mem')?.addEventListener('click', () => {
      saveWorkMemory({ notes: [], findings: [], lastUrl: '', progress: '', task: '', history: [] });
      agentCtx = null;
      try { localStorage.removeItem('solo_agent_context'); } catch (_) {}
      showContinueBar(false);
      appendMsg('ai', (agentLang() === 'vi') ? 'Đã xóa bộ nhớ công việc Agent.' : 'Agent work memory cleared.');
    });
  }
  const btn = document.getElementById('btn-agent-continue');
  if (btn) btn.textContent = agentLang() === 'vi' ? '▶ Tiếp tục' : '▶ Continue';
  const clr = document.getElementById('btn-agent-clear-mem');
  if (clr) clr.textContent = agentLang() === 'vi' ? 'Xóa bộ nhớ' : 'Clear memory';
  bar.hidden = !show;
  bar.style.display = show ? 'flex' : 'none';
}

loadAIMemory().catch(() => {});


(function soloLangBootstrap() {
  try {
    const saved = localStorage.getItem('solo_lang');
    const nav = String(navigator.language || '').toLowerCase();
    const vi = saved === 'vi' || (!saved && nav.startsWith('vi'));
    if (vi) document.documentElement.lang = 'vi';
    const input = document.getElementById('chatInput');
    if (input) input.setAttribute('lang', vi ? 'vi' : (document.documentElement.lang || 'en'));
  } catch (_) {}
})();


/* Feedback star rating (Universal module parity) */
(function bindFbStars() {
  let rating = 0;
  const box = document.getElementById('fbStars');
  if (!box || box.dataset.bound === '1') return;
  box.dataset.bound = '1';
  box.querySelectorAll('button[data-r]').forEach((btn) => {
    btn.addEventListener('click', () => {
      rating = Number(btn.getAttribute('data-r')) || 0;
      box.querySelectorAll('button[data-r]').forEach((b) => {
        const on = Number(b.getAttribute('data-r')) <= rating;
        b.style.color = on ? '#fbbf24' : '#6b7280';
      });
      box.dataset.rating = String(rating);
    });
  });
  window.__soloFbRating = () => Number(box.dataset.rating || 0);
})();
