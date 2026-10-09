'use strict';

/**
 * Dynamic GeoIP for Playwright context (timezone + locale).
 * Avoids Cloudflare/Akamai traps where fixed Asia/Ho_Chi_Minh mismatches egress IP.
 *
 * Primary:  http://ip-api.com/json/?fields=status,timezone,countryCode  (no key, rate-limited)
 * Fallback: UTC + en-US on any network error.
 * Cache: 1 hour in-process.
 */

const http = require('http');
const https = require('https');

const CACHE_TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 4000;
const FALLBACK = Object.freeze({
  timezoneId: 'UTC',
  locale: 'en-US',
  countryCode: null,
  source: 'fallback'
});

/** Map ISO country → primary BCP-47 locale for Accept-Language / Playwright locale. */
const COUNTRY_LOCALE = Object.freeze({
  VN: 'vi-VN', US: 'en-US', GB: 'en-GB', AU: 'en-AU', CA: 'en-CA',
  DE: 'de-DE', FR: 'fr-FR', JP: 'ja-JP', KR: 'ko-KR', CN: 'zh-CN',
  TW: 'zh-TW', TH: 'th-TH', ID: 'id-ID', MY: 'ms-MY', SG: 'en-SG',
  PH: 'en-PH', IN: 'en-IN', BR: 'pt-BR', PT: 'pt-PT', ES: 'es-ES',
  MX: 'es-MX', IT: 'it-IT', RU: 'ru-RU', UA: 'uk-UA', PL: 'pl-PL',
  NL: 'nl-NL', SE: 'sv-SE', NO: 'nb-NO', FI: 'fi-FI', TR: 'tr-TR',
  SA: 'ar-SA', AE: 'ar-AE', IL: 'he-IL', EG: 'ar-EG'
});

let cache = { at: 0, data: null };
let inflight = null;

function fetchJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchJson(res.headers.location, timeoutMs).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('geoip http ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('geoip timeout'));
    });
  });
}

function normalize(payload) {
  if (!payload || payload.status !== 'success') return { ...FALLBACK };
  const timezoneId = String(payload.timezone || '').trim() || 'UTC';
  const cc = String(payload.countryCode || '').toUpperCase() || null;
  const locale = (cc && COUNTRY_LOCALE[cc]) || 'en-US';
  return {
    timezoneId,
    locale,
    countryCode: cc,
    source: 'ip-api'
  };
}

/**
 * @returns {Promise<{ timezoneId: string, locale: string, countryCode: string|null, source: string }>}
 */
async function getPublicIpGeoData() {
  const now = Date.now();
  if (cache.data && now - cache.at < CACHE_TTL_MS) {
    return { ...cache.data, cached: true };
  }
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      // Allow override for tests / air-gapped hosts
      if (process.env.SOLOHOST_GEO_TIMEZONE || process.env.SOLOHOST_GEO_LOCALE) {
        const data = {
          timezoneId: process.env.SOLOHOST_GEO_TIMEZONE || 'UTC',
          locale: process.env.SOLOHOST_GEO_LOCALE || 'en-US',
          countryCode: process.env.SOLOHOST_GEO_COUNTRY || null,
          source: 'env'
        };
        cache = { at: Date.now(), data };
        return { ...data, cached: false };
      }
      const json = await fetchJson(
        'http://ip-api.com/json/?fields=status,timezone,countryCode',
        REQUEST_TIMEOUT_MS
      );
      const data = normalize(json);
      cache = { at: Date.now(), data };
      return { ...data, cached: false };
    } catch {
      // Do not cache failures for long — retry next call, but return stable fallback now
      return { ...FALLBACK, cached: false };
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

function clearGeoCache() {
  cache = { at: 0, data: null };
}

function acceptLanguageFor(locale) {
  const primary = String(locale || 'en-US');
  const base = primary.split('-')[0] || 'en';
  if (base === 'en') return 'en-US,en;q=0.9';
  return primary + ',' + base + ';q=0.9,en-US;q=0.8,en;q=0.7';
}

module.exports = {
  getPublicIpGeoData,
  clearGeoCache,
  acceptLanguageFor,
  FALLBACK,
  COUNTRY_LOCALE
};
