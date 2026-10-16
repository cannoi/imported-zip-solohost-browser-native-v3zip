'use strict';
const retail = require('../agent-sources/vn-retail');
function matchCompareIntent(task) {
  const t = String(task || '').toLowerCase();
  return /so sánh giá|so sanh gia|compare price|giá.*iphone|iphone.*giá|price of|nhà bán lẻ|fpt shop|thế giới di động|viettel store|tgdd/.test(t);
}
function buildChecklist(task, lang) {
  const matched = retail.matchRetailersInText(task);
  const sources = (matched.length ? matched : retail.defaultPhoneRetailers()).map((r) => r.host);
  return { kind: 'compare_products', sources, product_hint: String(task || '').slice(0, 200), min_sources_ok: 3, citation_required: true, output_language: lang === 'vi' ? 'vi' : 'en' };
}
function suggestedActions(task) {
  const matched = retail.matchRetailersInText(task);
  const list = matched.length ? matched : retail.defaultPhoneRetailers();
  const q = (String(task || '').match(/iphone[^,]{0,40}/i) || ['iphone'])[0].trim();
  return list.slice(0, 4).map((r) => ({ type: 'navigate', url: r.searchUrl(q) }));
}
module.exports = { matchCompareIntent, buildChecklist, suggestedActions, retail };
