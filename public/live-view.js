/* SoloHost Live View — CDP screencast client (feature: SOLOHOST_LIVE_MODE) */
(function (global) {
  function LiveView(opts) {
    this.canvas = opts.canvas;
    this.ctx = this.canvas && this.canvas.getContext && this.canvas.getContext('2d');
    this.sessionId = opts.sessionId;
    this.token = opts.token;
    this.ws = null;
    this.connected = false;
  }
  LiveView.prototype.connect = function () {
    var self = this;
    if (!this.sessionId || !this.token) return;
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var u = proto + '//' + location.host + '/api/browser/live?sessionId=' +
      encodeURIComponent(this.sessionId) + '&token=' + encodeURIComponent(this.token);
    try {
      this.ws = new WebSocket(u);
      this.ws.binaryType = 'arraybuffer';
      this.ws.onopen = function () { self.connected = true; };
      this.ws.onclose = function () { self.connected = false; };
      this.ws.onmessage = function (ev) {
        if (typeof ev.data === 'string') return;
        if (!self.ctx) return;
        var blob = new Blob([ev.data], { type: 'image/jpeg' });
        createImageBitmap(blob).then(function (bmp) {
          self.canvas.width = bmp.width;
          self.canvas.height = bmp.height;
          self.ctx.drawImage(bmp, 0, 0);
          bmp.close && bmp.close();
        }).catch(function () {});
      };
    } catch (e) {}
  };
  LiveView.prototype.send = function (msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  };
  LiveView.prototype.clickAt = function (x, y) {
    this.send({ type: 'mouse', eventType: 'mousePressed', x: x, y: y, button: 'left', clickCount: 1 });
    this.send({ type: 'mouse', eventType: 'mouseReleased', x: x, y: y, button: 'left', clickCount: 1 });
  };
  LiveView.prototype.wheel = function (x, y, dy) {
    this.send({ type: 'wheel', x: x, y: y, deltaX: 0, deltaY: dy });
  };
  LiveView.prototype.close = function () {
    try { this.ws && this.ws.close(); } catch (e) {}
  };
  global.SoloHostLiveView = LiveView;
})(typeof window !== 'undefined' ? window : global);
