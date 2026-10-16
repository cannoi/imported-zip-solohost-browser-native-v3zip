'use strict';
const RETAILERS = [
  { id: 'fptshop', name: 'FPT Shop', host: 'fptshop.com.vn', searchUrl: (q) => 'https://fptshop.com.vn/tim-kiem/' + encodeURIComponent(q) },
  { id: 'thegioididong', name: 'Thế Giới Di Động', host: 'thegioididong.com', searchUrl: (q) => 'https://www.thegioididong.com/tim-kiem?key=' + encodeURIComponent(q) },
  { id: 'viettelstore', name: 'Viettel Store', host: 'viettelstore.vn', searchUrl: (q) => 'https://viettelstore.vn/tim?q=' + encodeURIComponent(q) },
  { id: 'didongviet', name: 'Di Động Việt', host: 'didongviet.vn', searchUrl: (q) => 'https://didongviet.vn/tim?q=' + encodeURIComponent(q) },
  { id: 'cellphones', name: 'CellphoneS', host: 'cellphones.com.vn', searchUrl: (q) => 'https://cellphones.com.vn/catalogsearch/result/?q=' + encodeURIComponent(q) },
  { id: 'hoanghamobile', name: 'Hoàng Hà Mobile', host: 'hoanghamobile.com', searchUrl: (q) => 'https://hoanghamobile.com/tim-kiem?kwd=' + encodeURIComponent(q) },
  { id: 'viettablet', name: 'Viettablet', host: 'viettablet.com', searchUrl: (q) => 'https://www.viettablet.com/tim?q=' + encodeURIComponent(q) },
  { id: 'apple_vn', name: 'Apple Store VN', host: 'apple.com', searchUrl: (q) => 'https://www.apple.com/vn/search/' + encodeURIComponent(q) + '?src=serp' }
];
function matchRetailersInText(text) {
  const t = String(text || '').toLowerCase();
  return RETAILERS.filter((r) =>
    t.includes(r.id) || t.includes(r.host.split('.')[0]) || t.includes(r.name.toLowerCase()) ||
    (r.id === 'thegioididong' && /thế giới di động|the gioi di dong|tgdd/.test(t)) ||
    (r.id === 'fptshop' && /fpt\s*shop/.test(t)) ||
    (r.id === 'viettelstore' && /viettel/.test(t))
  );
}
function defaultPhoneRetailers() { return RETAILERS.filter((r) => r.id !== 'apple_vn').slice(0, 5); }
function extractProductOffers(html, pageUrl) {
  const offers = [];
  const blocks = String(html || '').match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const b of blocks) {
    try {
      const raw = b.replace(/^[\s\S]*?>/, '').replace(/<\/script>.*/i, '');
      const j = JSON.parse(raw);
      const nodes = Array.isArray(j) ? j : (j['@graph'] ? j['@graph'] : [j]);
      for (const n of nodes) {
        if (!n || typeof n !== 'object') continue;
        const types = [].concat(n['@type'] || []);
        if (!types.some((x) => /Product/i.test(String(x)))) continue;
        const name = n.name || n.title || '';
        let price = null, currency = 'VND', availability = null;
        const list = Array.isArray(n.offers) ? n.offers : (n.offers ? [n.offers] : []);
        for (const o of list) {
          if (!o) continue;
          price = o.price || o.lowPrice || price;
          currency = o.priceCurrency || currency;
          availability = o.availability || availability;
        }
        offers.push({ title: String(name).slice(0, 200), price: price != null ? String(price) : null, currency, availability: availability ? String(availability) : null, url: pageUrl, source: (() => { try { return new URL(pageUrl).hostname.replace(/^www\./, ''); } catch { return ''; } })() });
      }
    } catch (_) {}
  }
  return offers;
}
module.exports = { RETAILERS, matchRetailersInText, defaultPhoneRetailers, extractProductOffers };
