'use strict';

/**
 * Reader view — serves the extracted page inside the existing #browser-view iframe.
 *
 * The shell (public/app.js) still points its iframe at /view/..., which used to be the
 * noVNC pixel stream. In Phase 1 that URL renders the clean article produced by the
 * Chromium engine instead, so the unchanged frontend keeps working end to end.
 *
 * Security: article HTML is already sanitised by ContentExtractor; on top of that the page
 * is served with a strict CSP (only one nonce'd inline script that we control).
 */

const crypto = require('crypto');

const T = {
  en: {
    empty: 'Enter an address in the bar above to start reading.',
    loading: 'Loading page…',
    errorTitle: 'Page unavailable',
    minRead: 'min read',
    words: 'words',
    media: 'Media streams detected',
    noText: 'This address is a file, not a web page. Reader mode has nothing to show.',
    notReadable: 'No clear article was found; showing the page text instead.',
    open: 'Source'
  },
  vi: {
    empty: 'Nhập địa chỉ ở thanh phía trên để bắt đầu đọc.',
    loading: 'Đang tải trang…',
    errorTitle: 'Không thể mở trang',
    minRead: 'phút đọc',
    words: 'từ',
    media: 'Phát hiện luồng media',
    noText: 'Địa chỉ này là một tệp, không phải trang web. Chế độ đọc không có nội dung để hiển thị.',
    notReadable: 'Không tìm thấy bài viết rõ ràng; đang hiển thị văn bản của trang.',
    open: 'Nguồn'
  }
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function httpUrl(raw) {
  try {
    const u = new URL(String(raw));
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch { return ''; }
}

const CSS = `
:root{color-scheme:dark}*{box-sizing:border-box}
html,body{margin:0;background:#0c0d10;color:#eceae6;font:17px/1.7 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:28px 20px 80px}
h1.t{font-size:1.75rem;line-height:1.25;margin:.2em 0 .4em;font-weight:600}
.meta{display:flex;flex-wrap:wrap;gap:6px 14px;color:#9a9790;font-size:.82rem;margin-bottom:22px;align-items:center}
.meta img{width:16px;height:16px;border-radius:3px;vertical-align:-3px;margin-right:4px}
.meta a{color:#a9c7ff;text-decoration:none}
.note,.state{color:#9a9790;font-size:.9rem}
.state{text-align:center;margin-top:18vh;font-size:1rem}.state .i{font-size:2.2rem;display:block;margin-bottom:10px}
.err{color:#ffb4a9}
article{overflow-wrap:anywhere}article img,article video{max-width:100%;height:auto;border-radius:6px}
article a{color:#a9c7ff}article pre{overflow:auto;background:#15171c;padding:12px;border-radius:8px}
article table{display:block;overflow:auto;border-collapse:collapse}article td,article th{border:1px solid #2a2d35;padding:6px 10px}
article blockquote{margin:1em 0;padding:.2em 1em;border-left:3px solid #3a3d46;color:#c8c4bc}
.media{margin-top:28px;padding:14px;border:1px solid #2a2d35;border-radius:10px;font-size:.82rem}
.media h2{font-size:.85rem;margin:0 0 8px;color:#c8c4bc}.media code{display:block;overflow-wrap:anywhere;color:#9a9790;margin:4px 0}
`;

const SCRIPT = `
(function(){
  var rev=__REV__;
  document.addEventListener('click',function(e){
    var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;
    if(!a)return;
    var h=a.href||'';
    if(/^https?:/i.test(h)&&window.parent&&typeof window.parent.openUrl==='function'){e.preventDefault();window.parent.openUrl(h);}
  },true);
  setInterval(function(){
    fetch('/api/browser/content?summary=1',{cache:'no-store'}).then(function(r){return r.json();}).then(function(j){
      if(j&&typeof j.rev==='number'&&j.rev!==rev){location.reload();}
    }).catch(function(){});
  },1500);
})();
`;

function render(view, lang) {
  const t = T[lang];
  const { tab, content, loading, error, rev } = view;
  let body;

  if (error && !loading) {
    body = `<div class="state err"><span class="i">⚠️</span><strong>${esc(t.errorTitle)}</strong><p>${esc(error.message)}</p></div>`;
  } else if (loading && !content) {
    body = `<div class="state"><span class="i">⏳</span>${esc(t.loading)}</div>`;
  } else if (!tab || !content) {
    body = `<div class="state"><span class="i">🌐</span>${esc(t.empty)}</div>`;
  } else {
    const c = content;
    const src = httpUrl(c.final_url);
    const favicon = httpUrl(c.favicon);
    const bits = [];
    if (c.site_name) bits.push(`<span>${favicon ? `<img src="${esc(favicon)}" alt="">` : '🌐 '}${esc(c.site_name)}</span>`);
    if (c.author) bits.push(`<span>✍️ ${esc(c.author)}</span>`);
    if (c.published_at) bits.push(`<span>🗓️ ${esc(String(c.published_at).slice(0, 10))}</span>`);
    if (c.reading_minutes) bits.push(`<span>⏱️ ${c.reading_minutes} ${esc(t.minRead)} · ${c.word_count} ${esc(t.words)}</span>`);
    if (src) bits.push(`<a href="${esc(src)}">🔗 ${esc(t.open)}</a>`);

    let main;
    if (c.kind && c.kind !== 'html') main = `<p class="note">📄 ${esc(t.noText)}</p>`;
    else main = (c.readable ? '' : `<p class="note">ℹ️ ${esc(t.notReadable)}</p>`) + `<article>${c.clean_html || ''}</article>`;

    const media = Array.isArray(c.media) && c.media.length
      ? `<section class="media"><h2>🎞️ ${esc(t.media)} (${c.media.length})</h2>${c.media.slice(0, 20).map(m => `<code>${esc(String(m.type).toUpperCase())} · ${esc(m.url)}</code>`).join('')}</section>`
      : '';

    body = `<h1 class="t">${esc(c.title || c.site_name || c.final_url)}</h1><div class="meta">${bits.join('')}</div>${main}${media}`;
  }

  return { rev, body };
}

function handle(req, res, engine) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Method not allowed');
  }
  const accept = String(req.headers['accept-language'] || 'en').toLowerCase();
  const lang = accept.startsWith('vi') ? 'vi' : 'en';
  const nonce = crypto.randomBytes(16).toString('base64');
  const view = engine.getContent();
  const { rev, body } = render(view, lang);

  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>SoloHost Reader</title><style>${CSS}</style></head><body><main>${body}</main><script nonce="${nonce}">${SCRIPT.replace('__REV__', String(rev))}</script></body></html>`;
  const payload = Buffer.from(html, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`
  });
  if (req.method === 'HEAD') return res.end();
  return res.end(payload);
}

module.exports = { handle, render, esc };
