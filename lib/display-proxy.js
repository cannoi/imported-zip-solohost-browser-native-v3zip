'use strict';

const http = require('http');
const net = require('net');

const HOST = process.env.DISPLAY_HOST || '127.0.0.1';
const PORT = Number(process.env.DISPLAY_PORT || 6080);

function destPath(urlPath) {
  let dest = (urlPath || '').replace(/^\/view/, '') || '/';
  if (dest === '/') dest = '/vnc.html';
  return dest;
}

// Inline hide-rules injected server-side into the noVNC HTML itself, before the
// browser ever paints it. This removes the brief flash of noVNC's own connect
// dialog / toolbar / cursor that used to show for a moment before app.js could
// reach in and hide it after the iframe's `load` event fired.
const NOVNC_HIDE_SNIPPET = `<style id="solohost-novnc-hide">
#noVNC_control_bar,#noVNC_control_bar_anchor,#noVNC_control_bar_handle,#noVNC_status,
#noVNC_hint,#noVNC_hint_anchor,#noVNC_transition,#noVNC_connect_dlg,#noVNC_buttons,
#noVNC_settings,#noVNC_clipboard,#noVNC_power,#noVNC_extras,.noVNC_panel,
#noVNC_fallback_error,#noVNC_keyboard_button,#noVNC_toggle_color_mode_button,
#noVNC_credentials_dlg,#noVNC_verify_server_dlg{
  display:none!important;visibility:hidden!important;pointer-events:none!important;opacity:0!important;
}
html,body,#noVNC_container,canvas{cursor:none!important}
</style>
<script>
(function(){
  // Defensive fallback: if any confirm/connect dialog still appears for any
  // reason, auto-dismiss it immediately instead of waiting for a person to
  // find the tiny button.
  function autoAdvance(){
    try{
      var btn = document.getElementById('noVNC_connect_button');
      if (btn) btn.click();
      if (window.UI && typeof window.UI.hideControlbar === 'function') window.UI.hideControlbar();
      if (window.UI && typeof window.UI.closeConnectPanel === 'function') window.UI.closeConnectPanel();
    }catch(e){}
  }
  document.addEventListener('DOMContentLoaded', autoAdvance);
  window.addEventListener('load', autoAdvance);
  setTimeout(autoAdvance, 50);
  setTimeout(autoAdvance, 300);
})();
</script>`;

function isHtmlRequest(pathOnly) {
  return pathOnly === '/' || pathOnly.toLowerCase().endsWith('.html');
}

function handleHttp(req, res) {
  const pathOnly = req.url.split('?')[0];
  const q = req.url.includes('?') ? '?' + req.url.split('?')[1] : '';
  const dest = destPath(pathOnly) + q;
  const rewriteHtml = isHtmlRequest(destPath(pathOnly));
  const headers = { ...req.headers, host: `${HOST}:${PORT}` };
  if (rewriteHtml) delete headers['accept-encoding']; // keep the response plain-text so we can safely inject into it

  const up = http.request({ hostname: HOST, port: PORT, path: dest, method: req.method, headers }, (r) => {
    if (!rewriteHtml) {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
      return;
    }
    const chunks = [];
    r.on('data', (c) => chunks.push(c));
    r.on('end', () => {
      let body = Buffer.concat(chunks).toString('utf8');
      if (/<head[^>]*>/i.test(body)) {
        body = body.replace(/<head[^>]*>/i, (m) => m + NOVNC_HIDE_SNIPPET);
      } else {
        body = NOVNC_HIDE_SNIPPET + body;
      }
      const outHeaders = { ...r.headers };
      delete outHeaders['content-encoding'];
      delete outHeaders['transfer-encoding'];
      outHeaders['content-length'] = Buffer.byteLength(body);
      res.writeHead(r.statusCode || 502, outHeaders);
      res.end(body);
    });
  });
  up.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Display starting');
    }
  });
  req.pipe(up);
}

function handleUpgrade(req, socket, head) {
  const dest = destPath(req.url);
  const lines = [`${req.method} ${dest} HTTP/1.1`];
  for (const [k, v] of Object.entries(req.headers)) {
    if (v) lines.push(`${k}: ${v}`);
  }
  const remote = net.connect(PORT, HOST, () => {
    remote.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) remote.write(head);
    remote.pipe(socket);
    socket.pipe(remote);
  });
  remote.on('error', () => { try { socket.end(); } catch { /* ignore */ } });
  socket.on('error', () => remote.destroy());
}

module.exports = { handleHttp, handleUpgrade };
