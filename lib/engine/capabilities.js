
'use strict';
function detect() {
  return {
    version: '10.16.0',
    mode: 'youtube-player-handoff-compliant-media-search-settings',
    features: {
      playwrightChromium: process.env.SOLOHOST_PLAYWRIGHT !== '0',
      playwrightFirefoxFallback: process.env.SOLOHOST_PLAYWRIGHT !== '0',
      playwrightWebKitFallback: process.env.SOLOHOST_PLAYWRIGHT !== '0',
      mobileFirstBridge: process.env.SOLOHOST_BROWSER_MOBILE !== '0',
      sessionRecovery: true,
      persistentBrowserSessions: String(process.env.SOLOHOST_BROWSER_PERSIST_SESSIONS || '1') !== '0',
      adaptiveLayoutMode: String(process.env.SOLOHOST_BROWSER_CONTENT_MODE || 'adaptive') !== 'focused',
      focusedContentMode: String(process.env.SOLOHOST_BROWSER_CONTENT_MODE || 'adaptive') === 'focused',
      adTrackerFiltering: String(process.env.SOLOHOST_BROWSER_BLOCK_ADS || '1') !== '0',
      reducedMotion: true,
      popupTracking: true,
      sitePolicyAwareAuth: true,
      youtubeHomePreserved: true,
      googleVerificationFallback: true,
      bingVerificationHandoff: true,
      serializedBridgeEvents: true,
      checkboxRadioSelectSupport: true,
      roleAndLabelInteractions: true,
      duplicateAuditSuppression: true,
      operaStyleContextMenu: true,
      touchLongPressContextMenu: true,
      privateTabsWithoutPersistentStorage: true,
      tabViewRestoreWithoutSiteReload: true,
      maxVisibleTabs: 12,
      bingDefaultSearch: true,
      configurableSearchEngine: true,
      customSearchUrlTemplate: true,
      youtubeEmbedSupport: true,
      youtubeVideoClickHandoff: true,
      sitePolicyCompliantNavigation: true,
      tiktokEmbedSupport: true,
      multimediaCspAllowlist: true,
      bingMobileBridgeStyles: true,
      webkitGtkWorker: process.env.SOLOHOST_WEBKIT_BRIDGE === '1',
      proxyHtml: true,
      domBridge: true,
      cookiesInEngine: true,
      fullJavascriptInEngine: true,
      vnc: false,
      cdpScreencastPrimary: false
    },
    display: {
      note: 'Interactive viewport uses DOM Bridge snapshots from Playwright (scripts already executed in Chromium). Not VNC. Login passwords typed via bridge events stay in engine context and are not logged.'
    },
    limits: [
      'DRM/Widevine not claimed',
      'YouTube watch/Shorts/live clicks route to a local player shell that embeds the official YouTube player; playback still depends on YouTube embed permissions, account/age/geo policy, codec and network',
      'Native HTML5 audio/video and allowlisted YouTube/TikTok/Vimeo/Spotify/Twitch/Dailymotion embeds work when source and site policy permit; DRM and cross-origin player controls remain site-dependent',
      'Adaptive DOM snapshot preserves site styles/classes where safe; complex SPA UI may still differ; use Open ↗ for full original interface',
      'Known third-party ad/analytics domains are blocked by default; first-party ads and ads sharing core site APIs may remain',
      'Only allowlisted HTTPS media embeds are retained in Bridge snapshots; full media/login behavior may require Open ↗',
      'Google/Bing verification challenges are not bypassed; Bing challenge pages hand off to the system browser for normal user completion',
      'Firefox/WebKit are launch-time fallback engines; site anti-bot blocks are not fixed by engine switching',
      'Google account sign-in and known Facebook/TikTok login routes are handed to the system browser to respect site auth policy',
      'Persistent storage saves cookies and local storage in /app/data/browser-state; disable with SOLOHOST_BROWSER_PERSIST_SESSIONS=0',
      'EXTERNAL still used for Meta/Netflix policy hosts'
    ]
  };
}
module.exports = { detect };
