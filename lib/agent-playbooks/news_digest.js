'use strict';
/**
 * news_digest playbook — preferred stages for VN news tasks (feed → filter → read → report).
 * Router may inject checklist + suggested first actions; LLM still drives when free-form.
 */
const DEFAULT_VN_SOURCES = [
  { name: 'VnExpress', host: 'vnexpress.net', feed: 'https://vnexpress.net/rss/tin-moi-nhat.rss' },
  { name: 'Tuoi Tre', host: 'tuoitre.vn', feed: 'https://tuoitre.vn/rss/tin-moi-nhat.rss' },
  { name: 'Thanh Nien', host: 'thanhnien.vn', feed: 'https://thanhnien.vn/rss/home.rss' },
  { name: 'Dan Tri', host: 'dantri.com.vn', feed: 'https://dantri.com.vn/rss/home.rss' },
  { name: 'VietnamNet', host: 'vietnamnet.vn', feed: 'https://vietnamnet.vn/rss/tin-moi-nhat.rss' }
];

function matchNewsIntent(task) {
  const t = String(task || '').toLowerCase();
  return /tin t[uứ]c|news digest|24h|24 giờ|bao chi|báo chí|vnexpress|tuổi trẻ|tuoi tre|thanh niên|dân trí|vietnamnet/.test(t);
}

function buildChecklist(task, lang) {
  return {
    sources: DEFAULT_VN_SOURCES.map((s) => s.host),
    time_window: '24h',
    min_items: 8,
    min_items_per_section: 1,
    sections: ['Chính trị', 'Kinh tế', 'Xã hội', 'Thế giới', 'Công nghệ'],
    output_language: lang === 'vi' ? 'vi' : 'en',
    citation_required: true
  };
}

function suggestedFirstActions() {
  // Non-LLM bootstrapping: fetch feeds first
  return DEFAULT_VN_SOURCES.slice(0, 3).map((s) => ({ type: 'fetch_feed', url: s.feed }));
}

module.exports = { matchNewsIntent, buildChecklist, suggestedFirstActions, DEFAULT_VN_SOURCES };
