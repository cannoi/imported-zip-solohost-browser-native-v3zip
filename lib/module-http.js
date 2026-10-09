'use strict';

/**
 * Minimal Express-like router so universal AI/Feedback modules can mount
 * onto SoloHost Browser's raw Node HTTP server.
 */

function createMountApp() {
  const routes = [];

  function add(method, path, handler) {
    const keys = [];
    const pattern = path.replace(/:([A-Za-z0-9_]+)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    });
    routes.push({
      method: method.toUpperCase(),
      path,
      keys,
      re: new RegExp('^' + pattern + '$'),
      handler
    });
  }

  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    delete: (p, h) => add('DELETE', p, h),
    put: (p, h) => add('PUT', p, h),
    routes,
    async dispatch(req, res, { method, pathname, query, body }) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = pathname.match(r.re);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        const fakeReq = {
          method,
          url: req.url,
          headers: req.headers,
          body: body || {},
          query: query || {},
          params
        };
        const fakeRes = {
          statusCode: 200,
          headers: {},
          status(code) { this.statusCode = code; return this; },
          json(obj) {
            const data = Buffer.from(JSON.stringify(obj));
            if (!res.headersSent) {
              res.writeHead(this.statusCode || 200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': data.length,
                'Cache-Control': 'no-store'
              });
            }
            res.end(data);
          },
          end(s) {
            if (!res.headersSent) res.writeHead(this.statusCode || 200);
            res.end(s);
          }
        };
        await r.handler(fakeReq, fakeRes);
        return true;
      }
      return false;
    }
  };
}

module.exports = { createMountApp };
