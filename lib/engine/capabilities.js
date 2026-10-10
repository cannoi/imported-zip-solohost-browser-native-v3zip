'use strict';

function detect() {
  const env = process.env.SOLOHOST_ENGINE || 'proxy';
  const hasDisplay = !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  const webkitFlag = process.env.SOLOHOST_WEBKIT !== '0';

  return {
    version: '10.1.0',
    requested: env,
    mode: 'hybrid-proxy',
    display: {
      hasContainerDisplay: hasDisplay,
      nativeDisplayBridge: false,
      note: 'WebKitGTK worker uses private Xvfb for headless rendering only. UI viewport remains iframe+proxy until a non-VNC interactive bridge exists.'
    },
    features: {
      proxyHtml: true,
      directIframe: true,
      externalOpen: true,
      webkitGtkWorker: webkitFlag,
      webkitGtkDisplay: false,
      vnc: false,
      cdpScreencast: false
    },
    limits: [
      'Interactive viewport is still hybrid-proxy (iframe).',
      'WebKit worker is backend-only (status/navigate/state via /api/engine/*).',
      'Sites may still need Open ↗ for full SPA/DRM.'
    ]
  };
}

module.exports = { detect };
