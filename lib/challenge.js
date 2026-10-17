'use strict';
/**
 * Unified blocked/verification page detector (visible text + URL only).
 */
function visibleText(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000);
}

function hostOf(url) {
  try { return new URL(String(url || '')).hostname.toLowerCase().replace(/^www\./, ''); }
  catch (_) { return ''; }
}

function detectChallenge(opts) {
  opts = opts || {};
  const u = String(opts.url || '');
  const t = String(opts.title || '');
  const text = visibleText(opts.html);
  const host = hostOf(u);

  if (/\/sorry(?:\/|$)/i.test(u) || /unusual traffic from your computer network|our systems have detected unusual traffic/i.test(text)) {
    return { blocked: true, kind: 'sorry', evidence: 'google_sorry' };
  }
  if (host === 'bing.com' && /captcha|challenge|verify|pow|press and hold|robot/i.test(u + ' ' + text + ' ' + t)) {
    return { blocked: true, kind: 'bing_verify', evidence: 'bing_challenge' };
  }
  if (/\/signin\/rejected/i.test(u)) {
    return { blocked: true, kind: 'login', evidence: 'google_signin_rejected' };
  }
  if (/\b(i.?m not a robot|complete the security check|attention required|cf-challenge|just a moment)\b/i.test(text)) {
    return { blocked: true, kind: 'captcha', evidence: 'visible_captcha' };
  }
  if (/\b(cookie consent|accept all cookies|consent management)\b/i.test(text) && text.length < 400) {
    return { blocked: true, kind: 'consent', evidence: 'consent_wall' };
  }
  return { blocked: false, kind: '', evidence: '' };
}

module.exports = { detectChallenge, visibleText };
