'use strict';
/**
 * Documented SoloHost Browser configuration (≤20 public knobs).
 * Other process.env reads remain as internal constants with defaults.
 */
function env(name, fallback) {
  const v = process.env[name];
  return v == null || v === '' ? fallback : v;
}
function envBool(name, fallback) {
  const v = String(process.env[name] == null ? '' : process.env[name]).trim().toLowerCase();
  if (!v) return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  PORT: envInt('PORT', 8080),
  HOST: env('HOST', '0.0.0.0'),
  DATA_DIR: env('SOLOHOST_DATA_DIR', env('DATA_DIR', '/app/data')),
  ACCESS_PASSWORD: env('BROWSER_ACCESS_PASSWORD', env('ACCESS_PASSWORD', '')),
  LOG_LEVEL: env('SOLOHOST_LOG_LEVEL', 'info'),
  LOCALE: env('SOLOHOST_BROWSER_LOCALE', 'en-US'),
  TIMEZONE: env('TZ', env('SOLOHOST_BROWSER_TZ', 'UTC')),
  GEO_LOOKUP: envBool('SOLOHOST_GEO_LOOKUP', false),
  PLAYWRIGHT: envBool('SOLOHOST_PLAYWRIGHT', true),
  MOBILE: envBool('SOLOHOST_BROWSER_MOBILE', true),
  PERSIST_SESSIONS: envBool('SOLOHOST_BROWSER_PERSIST_SESSIONS', true),
  WITH_NOVNC: envBool('WITH_NOVNC', false),
  DEFAULT_SEARCH: env('SOLOHOST_DEFAULT_SEARCH', 'google'),
  AGENT_MAX_MS: envInt('SOLOHOST_AGENT_MAX_MS', 60 * 60 * 1000),
  AI_PROVIDER: env('AI_PROVIDER', ''),
  AI_API_KEY: env('AI_API_KEY', ''),
  BRAVE_API_KEY: env('BRAVE_API_KEY', ''),
  LIVE_MODE: env('SOLOHOST_LIVE_MODE', 'off')
};

module.exports = { config, env, envBool, envInt };
