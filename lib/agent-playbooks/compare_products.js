'use strict';
const retail = require('../agent-sources/vn-retail');
function matchCompareIntent(task) {
  const t = String(task || '').toLowerCase();
  // Broad product-price research in VN retail (phones, tablets, laptops)
  if (/so sánh giá|so sanh gia|compare price|nhà bán lẻ|fpt shop|thế giới di động|the gioi di dong|viettel store|tgdd|cellphones|hoàng hà|hoang ha/.test(t)) return true;
  if (/(iphone|samsung|galaxy|pixel|oppo|xiaomi|redmi|realme|vivo|macbook|ipad).{0,80}(giá|gia|rẻ|re|rẻ nhất|re nhat|dưới|duoi|triệu|trieu|cấu hình|cau hinh|mạnh|manh)/.test(t)) return true;
  if (/(giá|gia|rẻ|re).{0,40}(iphone|samsung|galaxy|pixel|điện thoại|dien thoai)/.test(t)) return true;
  if (/điện thoại|dien thoai/.test(t) && /(giá|gia|rẻ|re|triệu|trieu|cấu hình|cau hinh)/.test(t)) return true;
  return false;
}
function buildChecklist(task, lang) {
  const matched = retail.matchRetailersInText(task);
  const sources = (matched.length ? matched : retail.defaultPhoneRetailers()).map((r) => r.host);
  return { kind: 'compare_products', sources, product_hint: String(task || '').slice(0, 200), min_sources_ok: 3, citation_required: true, output_language: lang === 'vi' ? 'vi' : 'en' };
}
function productQuery(task) {
  const m = String(task || '').match(/(?:iphone|samsung\s*galaxy|galaxy|pixel|oppo|xiaomi|redmi|realme|vivo|macbook|ipad|điện thoại|dien thoai)[^,]{0,50}/i);
  return (m ? m[0] : String(task || '').slice(0, 60)).trim();
}
function suggestedActions(task) {
  const matched = retail.matchRetailersInText(task);
  const list = matched.length ? matched : retail.defaultPhoneRetailers();
  const q = productQuery(task);
  return list.slice(0, 4).map((r) => ({ type: 'navigate', url: r.searchUrl(q) }));
}
module.exports = { matchCompareIntent, buildChecklist, suggestedActions, productQuery, retail };
