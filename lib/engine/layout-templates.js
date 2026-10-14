'use strict';

/**
 * Responsive Bridge layout templates by pageType.
 * Applied only to the sanitized display HTML (not the live Chromium page).
 * Portrait + landscape friendly; keeps sites readable without forcing a card grid.
 */

const PAGE_TYPES = ['generic', 'search', 'video', 'commerce', 'article', 'social', 'docs', 'form', 'login'];

function normalizePageType(t) {
  const v = String(t || 'generic').toLowerCase();
  return PAGE_TYPES.includes(v) ? v : 'generic';
}

/** Shared base for every page — readable on phone and desktop. */
function baseCss() {
  return [
    'html,body{max-width:100%!important;width:100%!important;min-width:0!important;box-sizing:border-box!important;',
    '-webkit-text-size-adjust:100%;overflow-x:auto!important;overflow-wrap:anywhere;word-break:break-word}',
    '*,*:before,*:after{box-sizing:border-box}',
    'img,video,svg,canvas{max-width:100%!important;height:auto!important}',
    'table{max-width:100%!important;display:block;overflow-x:auto}',
    'iframe[data-sh-safe-media]{width:100%!important;max-width:100%!important;aspect-ratio:16/9;border:0;display:block}',
    'input,select,textarea,button{max-width:100%!important;font-size:16px!important}',
    'pre,code{white-space:pre-wrap!important;word-break:break-word!important;max-width:100%!important}',
    '[data-sh-id]{cursor:pointer}',
    /* Portrait phones */
    '@media (max-width:700px) and (orientation:portrait){',
    'body{padding:0 10px!important;font-size:16px!important;line-height:1.5!important}',
    'h1{font-size:1.45rem!important}h2{font-size:1.25rem!important}',
    'nav,aside,[role=complementary]{max-width:100%!important}',
    '}',
    /* Landscape phones / small tablets */
    '@media (max-width:900px) and (orientation:landscape){',
    'body{padding:0 12px!important;font-size:15px!important;line-height:1.45!important}',
    '}',
    /* Desktop / wide */
    '@media (min-width:901px){',
    'body{max-width:1100px!important;margin-left:auto!important;margin-right:auto!important;padding:0 20px!important}',
    '}'
  ].join('');
}

function typeCss(pageType) {
  switch (pageType) {
    case 'search':
      return [
        '[data-sh-page-type=search] a{overflow-wrap:anywhere}',
        '[data-sh-page-type=search] main,[data-sh-page-type=search] #b_content,',
        '[data-sh-page-type=search] #search,[data-sh-page-type=search] #center_col{min-width:0!important;max-width:100%!important}',
        '[data-sh-page-type=search] li,[data-sh-page-type=search] .g,[data-sh-page-type=search] .b_algo{padding:12px 0!important;border-bottom:1px solid rgba(128,128,128,.25)}',
        '[data-sh-page-type=search] img{max-height:120px!important;width:auto!important}',
        '@media (max-width:700px){[data-sh-page-type=search] #b_context,[data-sh-page-type=search] aside{display:none!important}}'
      ].join('');
    case 'article':
      return [
        '[data-sh-page-type=article] article,[data-sh-page-type=article] [itemprop=articleBody],',
        '[data-sh-page-type=article] .content,[data-sh-page-type=article] main{max-width:42rem!important;margin:0 auto!important;',
        'line-height:1.65!important;font-size:1.05rem!important;overflow-wrap:anywhere}',
        '[data-sh-page-type=article] article img{height:auto!important;margin:12px 0!important;border-radius:6px}',
        '[data-sh-page-type=article] h1{line-height:1.3!important;margin:0.6em 0!important}',
        '@media (orientation:landscape) and (max-height:500px){[data-sh-page-type=article] article{font-size:0.95rem!important;line-height:1.5!important}}'
      ].join('');
    case 'video':
      return [
        '[data-sh-page-type=video] video{max-height:min(75vh,720px)!important;width:100%!important}',
        '[data-sh-page-type=video] iframe[data-sh-safe-media]{width:100%!important;max-height:75vh;aspect-ratio:16/9}',
        '@media (orientation:portrait){[data-sh-page-type=video] iframe[data-sh-safe-media]{max-height:50vh}}',
        '@media (orientation:landscape){[data-sh-page-type=video] iframe[data-sh-safe-media]{max-height:85vh}}'
      ].join('');
    case 'commerce':
      return [
        '[data-sh-page-type=commerce] img{object-fit:contain!important}',
        '[data-sh-page-type=commerce] button,[data-sh-page-type=commerce] input{touch-action:manipulation}',
        '[data-sh-page-type=commerce] [class*=price i],[data-sh-page-type=commerce] [itemprop=price]{font-weight:600}',
        '@media (max-width:700px){[data-sh-page-type=commerce] [class*=sidebar i]{display:none!important}}'
      ].join('');
    case 'social':
      return [
        '[data-sh-page-type=social] img,[data-sh-page-type=social] video{object-fit:contain!important;max-height:70vh!important}',
        '[data-sh-page-type=social] input,[data-sh-page-type=social] textarea{font-size:16px!important}',
        '[data-sh-page-type=social] [role=feed],[data-sh-page-type=social] article{max-width:640px!important;margin:0 auto!important}'
      ].join('');
    case 'docs':
      return [
        '[data-sh-page-type=docs] pre{max-width:100%!important;overflow:auto!important;padding:12px!important;border-radius:8px}',
        '[data-sh-page-type=docs] code{overflow-wrap:anywhere}',
        '[data-sh-page-type=docs] main,[data-sh-page-type=docs] article{max-width:52rem!important;margin:0 auto!important}'
      ].join('');
    case 'form':
    case 'login':
      return [
        '[data-sh-page-type=form] input,[data-sh-page-type=login] input,',
        '[data-sh-page-type=form] textarea,[data-sh-page-type=login] textarea,',
        '[data-sh-page-type=form] select,[data-sh-page-type=login] select{font-size:16px!important;max-width:100%!important;min-height:44px}',
        '[data-sh-page-type=login] form,[data-sh-page-type=form] form{max-width:420px!important;margin:24px auto!important;padding:16px!important}'
      ].join('');
    default: /* generic */
      return [
        '[data-sh-page-type=generic] main,[data-sh-page-type=generic] article{max-width:48rem!important;margin:0 auto!important}',
        '[data-sh-page-type=generic] p{line-height:1.55!important}'
      ].join('');
  }
}

/**
 * Full CSS block for Bridge sanitizeHtml injection.
 * @param {string} pageType
 * @returns {string} <style>...</style>
 */
function bridgeStyleTag(pageType) {
  const preferred = normalizePageType(pageType);
  let body = baseCss() + typeCss(preferred);
  for (const t of PAGE_TYPES) {
    if (t === preferred) continue;
    body += typeCss(t);
  }
  return (
    '<style id="sh-bridge-css" data-sh-layout="' + preferred + '">' +
    body +
    '</style>'
  );
}

/**
 * Inline CSS for Playwright snapshot — include ALL pageType rules so DOM
 * reclassification (generic → article) still matches [data-sh-page-type=…].
 */
function engineInlineCss(pageType) {
  const preferred = normalizePageType(pageType);
  let css = baseCss() + typeCss(preferred);
  for (const t of PAGE_TYPES) {
    if (t === preferred) continue;
    css += typeCss(t);
  }
  return css;
}

module.exports = {
  PAGE_TYPES,
  normalizePageType,
  bridgeStyleTag,
  engineInlineCss,
  baseCss,
  typeCss
};
