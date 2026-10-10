'use strict';

/**
 * Honest engine capability report for SoloHost Browser V10.
 * Never claims native WebKit display unless a real bridge exists.
 */

function detect() {
  const env = process.env.SOLOHOST_ENGINE || 'proxy';
  const hasDisplay = !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  const broadway = process.env.GDK_BACKEND === 'broadway';
  // Native GTK surface is not available to remote HTTP clients on SoloHost.
  const nativeDisplayBridge = false;

  return {
    version: '10.0.0',
    requested: env,
    mode: 'hybrid-proxy',
    display: {
      hasContainerDisplay: hasDisplay,
      broadway,
      nativeDisplayBridge,
      note: 'SoloHost serves this app over HTTP to a remote browser. Native WebKitGTK windows cannot appear inside that remote page without a display transport (VNC/Broadway/etc.), which is not the default architecture.'
    },
    features: {
      proxyHtml: true,
      directIframe: true,
      externalOpen: true,
      webkitGtkDisplay: false,
      vnc: false,
      cdpScreencast: false
    },
    limits: [
      'Sites that send X-Frame-Options / CSP frame-ancestors may need EXTERNAL open (↗).',
      'Google/Facebook SPAs and DRM video are partial or external-only in proxy mode.',
      '127.0.0.1 inside the container is the container itself, not the SoloHost host PC.'
    ]
  };
}

module.exports = { detect };
