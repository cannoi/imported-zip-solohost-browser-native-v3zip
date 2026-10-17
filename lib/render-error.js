'use strict';
/** Structured fallback page — never return empty HTML to the browser frame. */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * @param {{ title?: string, url?: string, reason?: string, message?: string, actions?: Array<{label:string,href?:string,action?:string}> }} opts
 */
function errorCard(opts) {
  const o = opts || {};
  const title = o.title || 'Page unavailable';
  const url = o.url || '';
  const reason = o.reason || 'empty';
  const message = o.message || 'This page could not be displayed in SoloHost Browser.';
  const actions = Array.isArray(o.actions) && o.actions.length ? o.actions : [
    { label: 'Open externally ↗', href: url, external: true },
    { label: 'Home', href: '/' }
  ];
  const btns = actions.map((a) => {
    if (a.external && a.href) {
      return '<a class="btn primary" href="' + esc(a.href) + '" target="_blank" rel="noopener noreferrer">' + esc(a.label) + '</a>';
    }
    if (a.href) return '<a class="btn" href="' + esc(a.href) + '">' + esc(a.label) + '</a>';
    return '<button type="button" class="btn" data-sh-action="' + esc(a.action || '') + '">' + esc(a.label) + '</button>';
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:system-ui,-apple-system,sans-serif;
background:#0f1115;color:#e8eaef}
.wrap{max-width:520px;margin:0 auto;padding:28px 18px 40px}
h1{font-size:1.15rem;margin:0 0 8px;font-weight:650}
.reason{display:inline-block;font-size:11px;padding:2px 8px;border-radius:999px;background:#2a2f3a;color:#9aa3b2;margin-bottom:12px}
p{line-height:1.5;color:#c5cad3;font-size:14px}
.url{word-break:break-all;font-size:12px;color:#7d8696;margin:12px 0 18px}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.btn{display:inline-flex;align-items:center;padding:10px 14px;border-radius:10px;border:1px solid #3a4150;
background:#1a1f29;color:#e8eaef;text-decoration:none;font-size:13px;font-weight:600;cursor:pointer}
.btn.primary{background:#3b82f6;border-color:#3b82f6;color:#fff}
</style></head><body>
<div class="wrap" data-sh-error-card="1" data-sh-reason="${esc(reason)}">
<span class="reason">${esc(reason)}</span>
<h1>${esc(title)}</h1>
<p>${esc(message)}</p>
${url ? '<div class="url">' + esc(url) + '</div>' : ''}
<div class="actions">${btns}</div>
</div></body></html>`;
}

function hasRenderableText(html) {
  const s = String(html || '');
  if (s.length < 40) return false;
  if (/data-sh-error-card/i.test(s)) return true;
  const text = s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length >= 40;
}

module.exports = { errorCard, hasRenderableText, esc };
