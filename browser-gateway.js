'use strict';
/** DISABLED_IN_V9 */
module.exports = {
  install() {},
  status: () => ({ mode: 'client-webview' }),
  parseUrl: async (url) => ({ success: true, mode: 'WEBVIEW', url, data: { client_side: true } }),
  chromiumHealth: async () => ({ status: 'ok', engine: { name: 'client-webview', ready: true } })
};
