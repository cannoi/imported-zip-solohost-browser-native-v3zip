'use strict';

/**
 * Responsive Bridge layout templates by pageType.
 * Goal: turn dynamic site HTML into a readable static-like view on mobile + desktop.
 * Applied only to sanitized display HTML (not the live Chromium page).
 */

const PAGE_TYPES = ['generic', 'search', 'video', 'commerce', 'article', 'social', 'docs', 'form', 'login'];

function normalizePageType(t) {
  const v = String(t || 'generic').toLowerCase();
  return PAGE_TYPES.includes(v) ? v : 'generic';
}

/** Kill fixed desktop layouts that cause horizontal overflow on phones. */
function baseCss() {
  return [
    'html{max-width:100%!important;width:100%!important;min-width:0!important;overflow-x:hidden!important;',
    '-webkit-text-size-adjust:100%!important;text-size-adjust:100%!important}',
    'body{max-width:100%!important;width:100%!important;min-width:0!important;margin:0!important;',
    'padding:12px!important;overflow-x:hidden!important;overflow-wrap:anywhere!important;word-break:break-word!important;',
    'box-sizing:border-box!important;line-height:1.55!important;font-size:16px!important}',
    '*,*:before,*:after{box-sizing:border-box!important;max-width:100%!important}',
    /* Break common desktop shells */
    'div,section,main,header,footer,nav,aside,article,ul,ol,li,table,tr,td,th,figure,form,fieldset{',
    'min-width:0!important;max-width:100%!important}',
    'img,video,svg,canvas,object,embed{max-width:100%!important;height:auto!important}',
    'table{display:block!important;overflow-x:auto!important;width:100%!important}',
    'iframe,iframe[data-sh-safe-media]{width:100%!important;max-width:100%!important;aspect-ratio:16/9;border:0;display:block}',
    'input,select,textarea,button{max-width:100%!important;font-size:16px!important;min-height:40px}',
    'pre,code{white-space:pre-wrap!important;word-break:break-word!important;max-width:100%!important;overflow-x:auto!important}',
    '[data-sh-id]{cursor:pointer}',
    /* Hide sticky/fixed sidebars that cover content on small screens */
    '@media (max-width:900px){',
    '[style*="position:fixed"],[style*="position: fixed"],.sticky,header[style*="fixed"]{position:relative!important;top:auto!important;left:auto!important;right:auto!important;width:100%!important}',
    'aside,[role=complementary],[class*="sidebar" i],[id*="sidebar" i],[class*="aside" i]{',
    'float:none!important;width:100%!important;max-width:100%!important;position:static!important}',
    '[class*="wrapper" i],[class*="container" i],[id*="wrapper" i],[id*="container" i],[class*="layout" i]{',
    'width:100%!important;min-width:0!important;max-width:100%!important;margin:0!important;padding-left:0!important;padding-right:0!important}',
    '}',
    /* Portrait phone */
    '@media (max-width:700px) and (orientation:portrait){',
    'body{padding:10px 12px!important;font-size:16px!important;line-height:1.55!important}',
    'h1{font-size:1.35rem!important;line-height:1.3!important}h2{font-size:1.2rem!important}',
    'h3{font-size:1.05rem!important}',
    '}',
    /* Landscape phone */
    '@media (max-width:900px) and (orientation:landscape){',
    'body{padding:8px 14px!important;font-size:15px!important;line-height:1.45!important}',
    '}',
    /* Desktop readable column */
    '@media (min-width:901px){',
    'body{max-width:720px!important;margin-left:auto!important;margin-right:auto!important;padding:16px 24px!important}',
    '[data-sh-page-type=search] body,[data-sh-page-type=commerce] body,[data-sh-page-type=social] body{max-width:960px!important}',
    '}'
  ].join('');
}

function typeCss(pageType) {
  switch (pageType) {
    case 'search':
      return [
        '[data-sh-page-type=search] a{overflow-wrap:anywhere}',
        '[data-sh-page-type=search] main,[data-sh-page-type=search] #b_content,',
        '[data-sh-page-type=search] #search,[data-sh-page-type=search] #center_col,',
        '[data-sh-page-type=search] #rso,[data-sh-page-type=search] #searchform{min-width:0!important;max-width:100%!important;width:100%!important}',
        '[data-sh-page-type=search] li,[data-sh-page-type=search] .g,[data-sh-page-type=search] .b_algo{',
        'padding:14px 0!important;margin:0!important;border-bottom:1px solid rgba(128,128,128,.22);display:block!important}',
        '[data-sh-page-type=search] img{max-height:100px!important;width:auto!important}',
        '@media (max-width:700px){[data-sh-page-type=search] #b_context,[data-sh-page-type=search] aside,[data-sh-page-type=search] #rhs{display:none!important}}'
      ].join('');
    case 'article':
      return [
        '[data-sh-page-type=article] article,[data-sh-page-type=article] [itemprop=articleBody],',
        '[data-sh-page-type=article] .content,[data-sh-page-type=article] main,[data-sh-page-type=article] .detail,',
        '[data-sh-page-type=article] .article,[data-sh-page-type=article] #article,[data-sh-page-type=article] .post{',
        'max-width:40rem!important;width:100%!important;margin:0 auto!important;line-height:1.7!important;',
        'font-size:1.05rem!important;overflow-wrap:anywhere;float:none!important}',
        '[data-sh-page-type=article] article img,[data-sh-page-type=article] main img{',
        'height:auto!important;margin:12px 0!important;border-radius:8px;display:block}',
        '[data-sh-page-type=article] h1{line-height:1.3!important;margin:0.5em 0!important;font-size:1.4rem!important}',
        '[data-sh-page-type=article] p{margin:0.75em 0!important}',
        '@media (max-width:700px){[data-sh-page-type=article] aside,[data-sh-page-type=article] [class*=related i],',
        '[data-sh-page-type=article] [class*=recommend i],[data-sh-page-type=article] [class*=ads i]{display:none!important}}'
      ].join('');
    case 'video':
      return [
        '[data-sh-page-type=video] video{max-height:min(70vh,640px)!important;width:100%!important}',
        '[data-sh-page-type=video] iframe[data-sh-safe-media]{width:100%!important;max-height:70vh;aspect-ratio:16/9}',
        '@media (orientation:portrait){[data-sh-page-type=video] iframe[data-sh-safe-media]{max-height:45vh}}',
        '@media (orientation:landscape){[data-sh-page-type=video] iframe[data-sh-safe-media]{max-height:80vh}}'
      ].join('');
    case 'commerce':
      return [
        '[data-sh-page-type=commerce] img{object-fit:contain!important}',
        '[data-sh-page-type=commerce] button,[data-sh-page-type=commerce] input{touch-action:manipulation}',
        '@media (max-width:700px){[data-sh-page-type=commerce] [class*=sidebar i],[data-sh-page-type=commerce] aside{display:none!important}}'
      ].join('');
    case 'social':
      return [
        '[data-sh-page-type=social] img,[data-sh-page-type=social] video{object-fit:contain!important;max-height:65vh!important}',
        '[data-sh-page-type=social] [role=feed],[data-sh-page-type=social] article{max-width:640px!important;margin:0 auto!important}'
      ].join('');
    case 'docs':
      return [
        '[data-sh-page-type=docs] pre{max-width:100%!important;overflow:auto!important;padding:12px!important;border-radius:8px}',
        '[data-sh-page-type=docs] main,[data-sh-page-type=docs] article{max-width:48rem!important;margin:0 auto!important}'
      ].join('');
    case 'form':
    case 'login':
      return [
        '[data-sh-page-type=form] input,[data-sh-page-type=login] input,',
        '[data-sh-page-type=form] textarea,[data-sh-page-type=login] textarea,',
        '[data-sh-page-type=form] select,[data-sh-page-type=login] select{font-size:16px!important;max-width:100%!important;min-height:44px}',
        '[data-sh-page-type=login] form,[data-sh-page-type=form] form{max-width:420px!important;margin:24px auto!important;padding:16px!important}'
      ].join('');
    default:
      return [
        '[data-sh-page-type=generic] main,[data-sh-page-type=generic] article{max-width:40rem!important;margin:0 auto!important}',
        '[data-sh-page-type=generic] p{line-height:1.6!important}'
      ].join('');
  }
}

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
