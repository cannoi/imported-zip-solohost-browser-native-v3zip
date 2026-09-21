const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

console.log('Running SoloHost Browser verification...');

const pkg = require('./package.json');
assert.strictEqual(pkg.name, 'solohost-browser-hub');
assert.ok(pkg.version);
console.log('✓ package.json');

['server.js', 'public/index.html', 'public/style.css', 'public/app.js', 'lib/app-manager.js', 'lib/store.js', 'lib/web-gateway.js'].forEach((f) => {
  assert.ok(fs.existsSync(path.join(__dirname, f)), 'missing ' + f);
});
console.log('✓ required files');

const html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'public/style.css'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, 'public/app.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const gw = fs.readFileSync(path.join(__dirname, 'lib/web-gateway.js'), 'utf8');
const readme = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
const compose = fs.readFileSync(path.join(__dirname, 'docker-compose.yml'), 'utf8');

assert.ok(!css.includes('apps-grid'));
assert.ok(!html.includes('app-card'));
assert.ok(html.includes('constellation'));
assert.ok(css.includes('browser-error[hidden]'));
assert.ok(js.includes('sameOriginProxyBase'));
assert.ok(js.includes('/api/net'));
assert.ok(!js.includes('if (navigator.onLine'));
assert.ok(server.includes('/api/proxy'));
assert.ok(server.includes('/api/net'));
assert.ok(gw.includes('http_proxy'));
assert.ok(gw.includes('x-forwarded-proto'));
assert.ok(!server.includes('dockerode'));
assert.ok(compose.includes('18080:8080'));
assert.ok(compose.includes('build: .'), 'docker-compose.yml must build local source, not pull a remote image');
assert.ok(!/^\s*image:\s*\S/m.test(compose), 'docker-compose.yml must not pin a remote image (it would ignore local fixes)');
console.log('✓ contracts');

const webGateway = require('./lib/web-gateway');
assert.strictEqual(
  webGateway.publicOrigin({ headers: { 'x-forwarded-proto': 'https', host: 'app.example' } }),
  'https://app.example'
);
assert.strictEqual(
  webGateway.publicOrigin({ headers: { 'x-forwarded-proto': 'https:', host: 'app.example' } }),
  'https://app.example'
);
assert.strictEqual(
  webGateway.publicOrigin({ headers: { host: '127.0.0.1:8080' } }),
  'http://127.0.0.1:8080'
);
assert.strictEqual(
  webGateway.proxyBaseFromReq({ headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'solo.local', host: '127.0.0.1:8080' } }),
  'https://solo.local/api/proxy'
);
console.log('✓ forwarded origin');

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

if (process.env.SOLOHOST_LIVE_TEST === '1') {
  (async () => {
    const health = await get('http://127.0.0.1:8080/health');
    assert.strictEqual(health.status, 200);
    const origin = await get('http://127.0.0.1:8080/api/proxy-url');
    const parsed = JSON.parse(origin.body);
    assert.ok(parsed.base.includes('/api/proxy'));
    assert.ok(!parsed.base.startsWith('https//'));
    assert.ok(!parsed.base.startsWith('http//'));
    const page = await get('http://127.0.0.1:8080/api/proxy?url=' + encodeURIComponent('https://example.com/'));
    assert.ok(page.status < 500, 'example.com proxy status ' + page.status);
    assert.ok(page.body.includes('Example') || page.body.includes('example') || page.body.includes('Page unavailable'), page.body.slice(0, 180));
    console.log('✓ live gateway');
    console.log('All tests passed successfully.');
  })().catch((err) => {
    console.error('Live test failed:', err);
    process.exit(1);
  });
} else {
  console.log('All static tests passed successfully.');
  process.exit(0);
}
