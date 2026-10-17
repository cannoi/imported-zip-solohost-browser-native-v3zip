'use strict';
/**
 * Public-IP geo profile for Chromium locale/timezone alignment.
 * Cached to avoid spamming the lookup API. Failures fall back to env/UTC.
 */
const fs = require('fs');
const path = require('path');
const appLog = require('./app-log');

const CACHE_TTL_MS = Math.max(10 * 60 * 1000, Number(process.env.SOLOHOST_GEO_TTL_MS) || 60 * 60 * 1000);
const DATA_DIR = process.env.SOLOHOST_DATA_DIR || '/app/data';
const CACHE_FILE = path.join(DATA_DIR, 'geo-profile.json');

let mem = null; // { at, timezone, locale, countryCode, query, source }

const COUNTRY_LOCALE = {
  VN: 'vi-VN', US: 'en-US', GB: 'en-GB', AU: 'en-AU', CA: 'en-CA',
  DE: 'de-DE', FR: 'fr-FR', ES: 'es-ES', IT: 'it-IT', PT: 'pt-PT', BR: 'pt-BR',
  JP: 'ja-JP', KR: 'ko-KR', CN: 'zh-CN', TW: 'zh-TW', TH: 'th-TH',
  ID: 'id-ID', MY: 'ms-MY', SG: 'en-SG', PH: 'en-PH', IN: 'en-IN',
  RU: 'ru-RU', UA: 'uk-UA', PL: 'pl-PL', NL: 'nl-NL', TR: 'tr-TR'
};

function acceptLanguageFor(locale) {
  const base = String(locale || 'en-US').split('-')[0] || 'en';
  if (locale === 'vi-VN') return 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7';
  if (base === 'en') return locale + ',en;q=0.9';
  return locale + ',' + base + ';q=0.9,en-US;q=0.8,en;q=0.7';
}

function validTz(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: String(tz || '') }); return String(tz); }
  catch (_) { return ''; }
}

function readDiskCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (!j || !j.at || Date.now() - Number(j.at) > CACHE_TTL_MS) return null;
    if (!validTz(j.timezone)) return null;
    return j;
  } catch (_) { return null; }
}

function writeDiskCache(profile) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(profile), { mode: 0o600 });
  } catch (_) {}
}

function envFallback() {
  const tz = validTz(process.env.SOLOHOST_BROWSER_TIMEZONE || process.env.TZ) || 'UTC';
  const locale = process.env.SOLOHOST_BROWSER_LOCALE || 'en-US';
  return {
    at: Date.now(),
    timezone: tz,
    locale,
    countryCode: '',
    query: '',
    source: 'env',
    acceptLanguage: acceptLanguageFor(locale)
  };
}

async function fetchPublicGeo() {
  const url = process.env.SOLOHOST_GEO_URL || 'http://ip-api.com/json/?fields=status,timezone,countryCode,query';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 4000);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    if (!res.ok) throw new Error('geo_http_' + res.status);
    const j = await res.json();
    if (!j || j.status !== 'success') throw new Error('geo_status');
    const timezone = validTz(j.timezone) || 'UTC';
    const countryCode = String(j.countryCode || '').toUpperCase().slice(0, 2);
    const locale = COUNTRY_LOCALE[countryCode] || process.env.SOLOHOST_BROWSER_LOCALE || 'en-US';
    return {
      at: Date.now(),
      timezone,
      locale,
      countryCode,
      query: String(j.query || '').slice(0, 64),
      source: 'ip-api',
      acceptLanguage: acceptLanguageFor(locale)
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Sync snapshot (cache or env). Safe for context creation. */
function getGeoProfileSync() {
  if (mem && Date.now() - mem.at < CACHE_TTL_MS) return mem;
  const disk = readDiskCache();
  if (disk) {
    mem = { ...disk, acceptLanguage: disk.acceptLanguage || acceptLanguageFor(disk.locale) };
    return mem;
  }
  mem = envFallback();
  return mem;
}

/** Refresh from network when cache cold. */
async function refreshGeoProfile() {
  try {
    const profile = await fetchPublicGeo();
    mem = profile;
    writeDiskCache({
      at: profile.at,
      timezone: profile.timezone,
      locale: profile.locale,
      countryCode: profile.countryCode,
      query: profile.query,
      source: profile.source,
      acceptLanguage: profile.acceptLanguage
    });
    appLog.log('info', 'geo.profile', {
      timezone: profile.timezone,
      locale: profile.locale,
      country: profile.countryCode,
      source: profile.source
    });
    return profile;
  } catch (e) {
    const fb = getGeoProfileSync();
    appLog.log('warn', 'geo.lookup_fail', { error: String(e.message || e).slice(0, 120), fallback: fb.timezone });
    return fb;
  }
}

function startGeoWarm() {
  setTimeout(() => { refreshGeoProfile().catch(() => {}); }, 50);
  setInterval(() => { refreshGeoProfile().catch(() => {}); }, CACHE_TTL_MS).unref?.();
}

module.exports = {
  getGeoProfileSync,
  refreshGeoProfile,
  startGeoWarm,
  acceptLanguageFor
};
