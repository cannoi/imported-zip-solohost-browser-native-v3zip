'use strict';
const assert = require('assert');
// Mirror client normalizeChatText logic for regression
function normalizeChatText(s) {
  let t = String(s == null ? '' : s);
  try { t = t.normalize('NFC'); } catch (_) {}
  t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '');
  return t.trim();
}
function looksVietnamese(s) {
  return /[ăâêôơưđĂÂÊÔƠƯĐáàảãạắằẳẵặấầẩẫậéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i.test(String(s || ''));
}
// NFD form of "Quảng Trị"
const nfd = 'Qua\u0309ng Tri\u0323';
const nfc = normalizeChatText(nfd);
assert.strictEqual(nfc, 'Quảng Trị');
assert.ok(looksVietnamese(nfc));
assert.ok(looksVietnamese('điểm chuẩn đại học 2025'));
assert.strictEqual(normalizeChatText('  hello\u200B  '), 'hello');
console.log('[PASS] vietnamese-input');
