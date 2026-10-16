'use strict';
function clip(s, n) {
  s = String(s == null ? '' : s);
  n = n || 200;
  return s.length <= n ? s : s.slice(0, n);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));
}
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
module.exports = { clip, sleep, escapeHtml };
