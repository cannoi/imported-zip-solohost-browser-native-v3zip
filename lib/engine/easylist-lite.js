'use strict';
/**
 * Compact tracker/ad host blocklist inspired by EasyList categories (not full EasyList).
 * Used by Playwright request interception. Keep small for RAM/CPU.
 */
const HOSTS = [
  // Ads
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.com',
  'pagead2.googlesyndication.com', 'tpc.googlesyndication.com', 'fundingchoicesmessages.google.com',
  'adnxs.com', 'adsrvr.org', 'criteo.com', 'taboola.com', 'outbrain.com', 'adroll.com',
  'pubmatic.com', 'openx.net', 'rubiconproject.com', 'casalemedia.com', 'bidswitch.net',
  'amazon-adsystem.com', 'aax.amazon-adsystem.com', 'media.net', 'yieldmo.com',
  'moatads.com', 'ads-twitter.com', 'ads.linkedin.com', 'an.facebook.com',
  'advertising.com', 'adsafeprotected.com', 'adform.net', 'smartadserver.com',
  'liadm.com', '3lift.com', 'sharethrough.com', 'sovrn.com', 'gumgum.com',
  // Analytics / trackers
  'google-analytics.com', 'googletagmanager.com', 'googletagservices.com',
  'scorecardresearch.com', 'quantserve.com', 'hotjar.com', 'fullstory.com',
  'mixpanel.com', 'segment.io', 'segment.com', 'amplitude.com', 'newrelic.com',
  'nr-data.net', 'sentry.io', 'clarity.ms', 'mouseflow.com', 'crazyegg.com',
  'optimizely.com', 'chartbeat.com', 'parsely.com', 'pingdom.net',
  // Social pixels
  'connect.facebook.net', 'static.ads-twitter.com', 'analytics.tiktok.com',
  'analytics.twitter.com', 'px.ads.linkedin.com', 'bat.bing.com',
  'snap.licdn.com', 'sc-static.net',
  // Other common trackers
  'branch.io', 'appsflyer.com', 'adjust.com', 'kochava.com', 'doubleverify.com',
  'iasds01.com', 'ml314.com', 'bluekai.com', 'exelator.com', 'krxd.net',
  'rlcdn.com', 'agkn.com', 'mathtag.com', 'turn.com', 'demdex.net',
  'omtrdc.net', 'everesttech.net', '2mdn.net', 'adobedtm.com'
];

const HOST_SET = new Set(HOSTS.map((h) => h.toLowerCase()));

function isBlockedHost(hostname) {
  if (!hostname) return false;
  let h = String(hostname).toLowerCase().replace(/^www\./, '');
  if (HOST_SET.has(h)) return true;
  for (const domain of HOST_SET) {
    if (h === domain || h.endsWith('.' + domain)) return true;
  }
  return false;
}

function isBlockedUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return isBlockedHost(u.hostname);
  } catch (_) {
    return false;
  }
}

module.exports = { HOSTS, isBlockedHost, isBlockedUrl };
