'use strict';
/**
 * YouTube specialized adapter — never show blank SPA shell.
 * Search results from ytInitialData; player uses youtube-nocookie + fallback card.
 */
const { URL } = require('url');
const { errorCard, esc } = require('../render-error');

function videoIdFromUrl(u) {
  try {
    const url = new URL(u);
    const h = url.hostname.replace(/^www\./, '').toLowerCase();
    if (h === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || '';
    if (h === 'youtube.com' || h === 'm.youtube.com' || h === 'youtube-nocookie.com') {
      if (url.pathname === '/watch') return url.searchParams.get('v') || '';
      const m = url.pathname.match(/\/(?:embed|shorts|live)\/([\w-]{6,})/);
      if (m) return m[1];
    }
  } catch (_) {}
  return '';
}

function isYouTubeHost(u) {
  try {
    const h = new URL(u).hostname.replace(/^www\./, '').toLowerCase();
    return h === 'youtube.com' || h === 'm.youtube.com' || h === 'youtu.be' || h === 'youtube-nocookie.com';
  } catch (_) { return false; }
}

function classifyYouTube(u) {
  try {
    const url = new URL(u);
    const id = videoIdFromUrl(u);
    if (id && (/\/watch|youtu\.be|\/embed\/|\/shorts\//i.test(url.href))) return { kind: 'watch', id };
    if (/\/results/i.test(url.pathname) || url.searchParams.has('search_query')) {
      return { kind: 'search', q: url.searchParams.get('search_query') || url.searchParams.get('q') || '' };
    }
    if (url.pathname === '/' || url.pathname === '') return { kind: 'home' };
    if (/^\/@/.test(url.pathname) || /\/channel\//.test(url.pathname) || /\/c\//.test(url.pathname)) return { kind: 'channel' };
    if (/\/playlist/.test(url.pathname)) return { kind: 'playlist' };
    return { kind: 'other' };
  } catch (_) {
    return { kind: 'other' };
  }
}

function decodeYtEscapedPayload(raw) {
  let json = '';
  const s = String(raw || '');
  for (let p = 0; p < s.length; p++) {
    if (s[p] === '\\' && p + 1 < s.length) {
      const n = s[p + 1];
      if (n === 'x' && p + 3 < s.length) {
        json += String.fromCharCode(parseInt(s.slice(p + 2, p + 4), 16));
        p += 3;
      } else if (n === 'u' && p + 5 < s.length) {
        json += String.fromCharCode(parseInt(s.slice(p + 2, p + 6), 16));
        p += 5;
      } else if (n === 'n') { json += '\n'; p++; }
      else if (n === 'r') { json += '\r'; p++; }
      else if (n === 't') { json += '\t'; p++; }
      else if (n === "'" || n === '"' || n === '\\' || n === '/') { json += n; p++; }
      else { json += s[p]; }
    } else json += s[p];
  }
  return json;
}

function extractYtInitialData(html) {
  const s = String(html || '');
  // Mobile YouTube: ytInitialData = '\x7b\x22...';
  const markerSingle = 'ytInitialData = \'';
  const markerAlt = 'ytInitialData=\'';
  let start = s.indexOf(markerSingle);
  let markerLen = markerSingle.length;
  if (start < 0) {
    start = s.indexOf(markerAlt);
    markerLen = markerAlt.length;
  }
  if (start >= 0) {
    const i = start + markerLen;
    let end = -1;
    for (let j = i; j < s.length; j++) {
      if (s[j] === "'" && s[j - 1] !== '\\') {
        let k = j + 1;
        while (k < s.length && /\s/.test(s[k])) k++;
        if (s[k] === ';') { end = j; break; }
      }
    }
    if (end > i) {
      try {
        return JSON.parse(decodeYtEscapedPayload(s.slice(i, end)));
      } catch (_) {}
    }
  }
  // Desktop: raw object
  const patterns = [
    /var\s+ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/,
    /window\["ytInitialData"\]\s*=\s*(\{[\s\S]*?\});\s*<\/script>/,
    /ytInitialData\s*=\s*(\{[\s\S]*?\});\s*(?:var|window|<\/script>)/
  ];
  for (const re of patterns) {
    const mm = s.match(re);
    if (!mm) continue;
    try { return JSON.parse(mm[1]); } catch (_) {}
  }
  return null;
}


function pushVideo(out, videoId, title, channel, views, duration) {
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) return;
  if (out.find((x) => x.videoId === videoId)) return;
  out.push({
    videoId,
    title: String(title || 'Video').slice(0, 200),
    channel: String(channel || '').slice(0, 120),
    views: String(views || '').slice(0, 80),
    duration: String(duration || '').slice(0, 20),
    thumb: 'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg'
  });
}

function textFrom(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  if (obj.simpleText) return obj.simpleText;
  if (Array.isArray(obj.runs)) return obj.runs.map((r) => r.text || '').join('');
  if (obj.content) return String(obj.content);
  return '';
}

function walkVideos(node, out, depth) {
  if (!node || depth > 30 || out.length >= 40) return;
  if (Array.isArray(node)) {
    for (const x of node) walkVideos(x, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;

  const vr = node.videoRenderer || node.gridVideoRenderer || node.compactVideoRenderer
    || node.videoWithContextRenderer || node.playlistVideoRenderer;
  if (vr) {
    const videoId = vr.videoId
      || (vr.navigationEndpoint && vr.navigationEndpoint.watchEndpoint && vr.navigationEndpoint.watchEndpoint.videoId)
      || (vr.onTap && vr.onTap.innertubeCommand && vr.onTap.innertubeCommand.watchEndpoint && vr.onTap.innertubeCommand.watchEndpoint.videoId)
      || '';
    const title = textFrom(vr.title) || textFrom(vr.headline);
    const channel = textFrom(vr.ownerText) || textFrom(vr.shortBylineText) || textFrom(vr.longBylineText);
    const views = textFrom(vr.viewCountText) || textFrom(vr.shortViewCountText);
    const duration = textFrom(vr.lengthText);
    pushVideo(out, videoId, title, channel, views, duration);
  }
  if (node.videoId && (node.title || node.overlayMetadata || node.thumbnail)) {
    pushVideo(out, node.videoId, textFrom(node.title) || textFrom(node.overlayMetadata && node.overlayMetadata.primaryText), '', '', '');
  }
  for (const k of Object.keys(node)) {
    if (k === 'loggingDirectives' || k === 'trackingParams') continue;
    walkVideos(node[k], out, depth + 1);
  }
}

function parseSearchResults(html) {
  const data = extractYtInitialData(html);
  if (!data) return [];
  const out = [];
  walkVideos(data, out, 0);
  return out;
}

function isConsentOrBlocked(html) {
  const s = String(html || '').slice(0, 12000).toLowerCase();
  return /consent\.youtube|before you continue|agree to the|captcha|unusual traffic|sorry, something went wrong/.test(s);
}

function mobileCss() {
  return `*{box-sizing:border-box}html,body{margin:0;max-width:100%;min-width:0;overflow-x:hidden;font-family:system-ui,-apple-system,sans-serif;background:#0f0f0f;color:#f1f1f1}
img,video,iframe{max-width:100%;height:auto}a{color:#3ea6ff;text-decoration:none}
.bar{padding:12px 14px;background:#212121;border-bottom:1px solid #333;position:sticky;top:0;z-index:2}
.bar form{display:flex;gap:8px;margin-top:8px}
.bar input{flex:1;min-width:0;padding:10px 12px;border-radius:20px;border:0;background:#121212;color:#fff;font-size:15px}
.bar button{padding:10px 14px;border-radius:20px;border:0;background:#3ea6ff;color:#0f0f0f;font-weight:700}
.list{padding:8px 12px 24px;display:flex;flex-direction:column;gap:12px}
.card{display:flex;gap:12px;align-items:flex-start;padding:8px;border-radius:12px;background:#181818}
.card img{width:42%;max-width:180px;border-radius:10px;aspect-ratio:16/9;object-fit:cover;background:#333}
.meta{flex:1;min-width:0}
.meta .t{font-size:14px;font-weight:600;line-height:1.35;margin:0 0 4px}
.meta .s{font-size:12px;color:#aaa;line-height:1.3}
.player-wrap{max-width:900px;margin:0 auto;padding:12px}
.player-wrap iframe{width:100%;aspect-ratio:16/9;border:0;border-radius:12px;background:#000}
.fallback{display:none;padding:16px;text-align:center}
.fallback img{width:100%;max-width:480px;border-radius:12px}
`;
}


function navInterceptScript() {
  return `<script>(function(){
  function targetUrl(href){
    try{
      var u=new URL(href, location.href);
      if(u.pathname==='/api/proxy' && u.searchParams.get('url')) return u.searchParams.get('url');
      if(/^https?:$/i.test(u.protocol)) return u.href;
    }catch(e){}
    return null;
  }
  document.addEventListener('click', function(e){
    var a=e.target && e.target.closest && e.target.closest('a[href]');
    if(!a) return;
    var href=a.getAttribute('href')||'';
    if(!href || href.charAt(0)==='#' || /^javascript:/i.test(href) || a.target==='_blank') return;
    var next=targetUrl(href);
    if(!next) return;
    e.preventDefault();
    e.stopPropagation();
    try{ parent.postMessage({type:'solohost-navigate', url:next}, '*'); }catch(_){}
  }, true);
})();</script>`;
}

function homePage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>YouTube</title><style>${mobileCss()}</style></head><body>
<div class="bar">
  <div style="font-weight:700">YouTube</div>
  <form method="GET" action="/api/proxy">
    <input type="hidden" name="url" id="u" value=""/>
    <input name="q" id="q" placeholder="Search YouTube" autocomplete="off"/>
    <button type="submit">Search</button>
  </form>
</div>
<script>
(function(){
  var f=document.querySelector('form'); var q=document.getElementById('q'); var u=document.getElementById('u');
  f.addEventListener('submit', function(e){
    var v=(q.value||'').trim();
    if(!v){ e.preventDefault(); return; }
    u.value='https://www.youtube.com/results?search_query='+encodeURIComponent(v);
  });
})();
</script>
<div class="list"><p style="color:#aaa;padding:8px">Type a query and press Search. Results open as a simple list (no blank SPA).</p></div>
${navInterceptScript()}</body></html>`;
}

function searchResultsPage(query, items, sourceUrl) {
  const q = String(query || '');
  if (!items || !items.length) {
    return errorCard({
      title: 'No YouTube results',
      url: sourceUrl || '',
      reason: 'empty_or_blocked',
      message: q ? ('No extractable results for “' + q + '”. YouTube may require consent or the page was blocked.') : 'Empty search.',
      actions: [
        { label: 'Open on YouTube ↗', href: sourceUrl || ('https://www.youtube.com/results?search_query=' + encodeURIComponent(q)), external: true },
        { label: 'Search again', href: '/api/proxy?url=' + encodeURIComponent('https://www.youtube.com/') }
      ]
    });
  }
  const cards = items.map((it) => {
    const href = '/api/proxy?url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + it.videoId);
    return `<a class="card" href="${esc(href)}">
<img src="${esc(it.thumb)}" alt="" loading="lazy"/>
<div class="meta"><div class="t">${esc(it.title)}</div>
<div class="s">${esc(it.channel)}${it.duration ? ' · ' + esc(it.duration) : ''}${it.views ? ' · ' + esc(it.views) : ''}</div></div></a>`;
  }).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(q || 'YouTube')} — Search</title><style>${mobileCss()}</style></head><body>
<div class="bar">
  <div style="font-weight:700">${esc(items.length)} results · ${esc(q)}</div>
  <form method="GET" action="/api/proxy">
    <input type="hidden" name="url" id="u" value=""/>
    <input name="q" id="q" value="${esc(q)}" placeholder="Search YouTube"/>
    <button type="submit">Search</button>
  </form>
</div>
<script>
(function(){
  var f=document.querySelector('form'); var q=document.getElementById('q'); var u=document.getElementById('u');
  f.addEventListener('submit', function(e){
    var v=(q.value||'').trim(); if(!v){e.preventDefault();return;}
    u.value='https://www.youtube.com/results?search_query='+encodeURIComponent(v);
  });
})();
</script>
<div class="list">${cards}</div>
${navInterceptScript()}</body></html>`;
}

function playerPage(videoId, title, origin) {
  const id = String(videoId || '').replace(/[^\w-]/g, '');
  const watch = 'https://www.youtube.com/watch?v=' + id;
  const embOrigin = origin ? '&origin=' + encodeURIComponent(origin) : '';
  // autoplay muted helps mobile embed start; user can unmute
  const embed = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(id)
    + '?playsinline=1&rel=0&modestbranding=1&fs=1' + embOrigin;
  const thumb = 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title || 'YouTube')}</title><style>${mobileCss()}
.player-wrap{position:relative}
.player-wrap iframe{position:relative;z-index:2;width:100%;aspect-ratio:16/9;border:0;border-radius:12px;background:#000;display:block}
.fallback{display:none;margin-top:12px;padding:12px;text-align:center;position:relative;z-index:1}
.fallback img{width:100%;max-width:480px;border-radius:12px;opacity:.9}
</style></head><body>
<div class="bar"><strong>${esc(title || 'YouTube video')}</strong>
 · <a href="${esc(watch)}" target="_blank" rel="noopener">Open ↗</a></div>
<div class="player-wrap">
<iframe id="ytp" src="${esc(embed)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
 referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
</div>
<div class="fallback" id="yt-fallback">
  <img src="${esc(thumb)}" alt=""/>
  <p style="margin:12px 0;color:#ccc">If the player is blank, open the video on YouTube.</p>
  <p><a class="btn primary" style="display:inline-block;padding:10px 16px;background:#3ea6ff;color:#000;border-radius:10px;font-weight:700"
    href="${esc(watch)}" target="_blank" rel="noopener">Open on YouTube ↗</a></p>
</div>
<script>
(function(){
  // Never hide the iframe to show a thumbnail on top — that was covering playback.
  // Only reveal the fallback link block BELOW the player after a long delay if still useful.
  var f=document.getElementById('yt-fallback');
  setTimeout(function(){ if(f) f.style.display='block'; }, 12000);
})();
</script>
${navInterceptScript()}</body></html>`;
}

/**
 * Build HTML for a YouTube URL. If htmlBody is provided (from fetch), parse it.
 */
function renderYouTube(url, htmlBody, opts) {
  const o = opts || {};
  const kind = classifyYouTube(url);
  if (kind.kind === 'watch' && kind.id) {
    return { html: playerPage(kind.id, o.title || 'YouTube', o.origin || ''), tier: 'yt-player', kind: 'watch' };
  }
  if (kind.kind === 'home') {
    return { html: homePage(), tier: 'yt-home', kind: 'home' };
  }
  if (kind.kind === 'search') {
    if (htmlBody && isConsentOrBlocked(htmlBody)) {
      return {
        html: errorCard({
          title: 'YouTube verification required',
          url,
          reason: 'consent_or_blocked',
          message: 'YouTube asked for consent or blocked automated access. Open YouTube externally, or try another query.',
          actions: [
            { label: 'Open YouTube ↗', href: url, external: true },
            { label: 'YouTube home', href: '/api/proxy?url=' + encodeURIComponent('https://www.youtube.com/') }
          ]
        }),
        tier: 'yt-blocked',
        kind: 'search'
      };
    }
    const items = htmlBody ? parseSearchResults(htmlBody) : [];
    return {
      html: searchResultsPage(kind.q, items, url),
      tier: 'yt-search',
      kind: 'search',
      count: items.length
    };
  }
  // channel / playlist / other — try parse videos, else info card
  if (htmlBody && !isConsentOrBlocked(htmlBody)) {
    const items = parseSearchResults(htmlBody);
    if (items.length) {
      return { html: searchResultsPage(kind.kind, items, url), tier: 'yt-list', kind: kind.kind, count: items.length };
    }
  }
  return {
    html: errorCard({
      title: 'YouTube page',
      url,
      reason: 'needs_external',
      message: 'This YouTube view works best in an external browser. Search and watch links still work inside SoloHost.',
      actions: [
        { label: 'Open ↗', href: url, external: true },
        { label: 'Search YouTube', href: '/api/proxy?url=' + encodeURIComponent('https://www.youtube.com/') }
      ]
    }),
    tier: 'yt-info',
    kind: kind.kind
  };
}

module.exports = {
  videoIdFromUrl,
  isYouTubeHost,
  classifyYouTube,
  extractYtInitialData,
  parseSearchResults,
  renderYouTube,
  playerPage,
  homePage,
  searchResultsPage
};
