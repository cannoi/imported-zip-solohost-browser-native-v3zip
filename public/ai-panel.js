(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const chat = $('aiChat');
  const input = $('aiInput');
  const send = $('aiSend');
  const statusBar = $('aiStatusBar');

  function appendMsg(role, text) {
    if (!chat) return;
    const div = document.createElement('div');
    div.className = `ai-msg ai-${role}`;
    div.textContent = text;
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
  }

  async function callAiAction(action, promptText) {
    appendMsg('user', `[${action}]`);
    appendMsg('assistant', 'Đang xử lý với AI...');
    try {
      const lastPayload = window.lastPayload || null;
      const content = lastPayload && lastPayload.content ? lastPayload.content : {};
      const rawText = content.raw_text || '';
      const cleanHtml = content.clean_html || '';

      const res = await fetch('/api/ai/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, rawText, cleanHtml, prompt: promptText })
      });
      const data = await res.json();
      if (data && data.success) {
        // Replace loading message
        if (chat && chat.lastChild) chat.lastChild.textContent = data.result || 'Hoàn tất.';
      } else {
        if (chat && chat.lastChild) chat.lastChild.textContent = 'Lỗi: ' + (data.error || 'AI không phản hồi');
      }
    } catch (err) {
      if (chat && chat.lastChild) chat.lastChild.textContent = 'Lỗi kết nối: ' + err.message;
    }
  }

  // Add quick action buttons to AI panel if container exists
  document.addEventListener('DOMContentLoaded', () => {
    const panelBody = document.querySelector('.panel-body');
    if (panelBody && !$('quickActionButtons')) {
      const bar = document.createElement('div');
      bar.id = 'quickActionButtons';
      bar.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;padding:8px 0;border-bottom:1px solid var(--line);margin-bottom:8px;';
      
      const btnSum = document.createElement('button');
      btnSum.className = 'ws-btn';
      btnSum.textContent = 'Tóm tắt nhanh';
      btnSum.onclick = () => callAiAction('summarize', 'Tóm tắt bài viết');

      const btnTrans = document.createElement('button');
      btnTrans.className = 'ws-btn';
      btnTrans.textContent = 'Dịch sang Tiếng Việt';
      btnTrans.onclick = () => callAiAction('translate', 'Dịch sang Tiếng Việt');

      const btnAna = document.createElement('button');
      btnAna.className = 'ws-btn';
      btnAna.textContent = 'Phân tích bài viết';
      btnAna.onclick = () => callAiAction('analyze', 'Phân tích bài viết');

      bar.appendChild(btnSum);
      bar.appendChild(btnTrans);
      bar.appendChild(btnAna);

      panelBody.insertBefore(bar, panelBody.firstChild);
    }
  });

  if (send && input) {
    send.onclick = async () => {
      const q = input.value.trim();
      if (!q) return;
      input.value = '';
      appendMsg('user', q);
      await callAiAction('ask', q);
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') send.click();
    };
  }

  if (statusBar) statusBar.textContent = 'AI: Sẵn sàng';
})();
