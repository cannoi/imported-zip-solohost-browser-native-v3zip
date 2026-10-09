'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const { ExtractorError, ContentExtractor } = require(path.join(root, 'lib/content-extractor'));

for (const route of ["p === '/downloads'", "p === '/api/files/downloads'", "p.startsWith('/api/files/downloads/')", "Content-Disposition", "application/octet-stream"]) assert.ok(server.includes(route), `missing safe file route: ${route}`);
assert.ok(html.includes('btn-downloads') && html.includes('/downloads'));
assert.ok(app.includes('if(/^[a-z][a-z0-9+.-]*:/i.test(u))return u;'), 'address bar should preserve explicit schemes for policy validation');

// The extractor only reads http(s); every other scheme is rejected before Chromium is touched.
(async () => {
  const ex = new ContentExtractor({ deps: { chromium: { launch() { throw new Error('must not launch'); } } } });
  for (const [url, code] of [
    ['javascript:alert(1)', 'INVALID_URL'],
    ['ftp://example.com/', 'INVALID_URL'],
    ['file:///etc/passwd', 'BLOCKED'],
    ['http://127.0.0.1/', 'BLOCKED'],
    ['about:blank', 'UNSUPPORTED_SCHEME'],
    ['data:text/html,hi', 'UNSUPPORTED_SCHEME']
  ]) {
    await assert.rejects(() => ex.extract(url), err => err instanceof ExtractorError && err.code === code, `${url} should fail with ${code}`);
  }
  console.log('PASS file/download and protocol policy contract');
})().catch(e => { console.error(e); process.exit(1); });
