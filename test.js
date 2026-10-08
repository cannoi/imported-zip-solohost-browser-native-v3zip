const assert = require('assert');
const fs = require('fs');
const path = require('path');
console.log('Running SoloHost Browser verification...');
const pkg = require('./package.json');
assert.strictEqual(pkg.name, 'solohost-browser-hub');
assert.ok(pkg.version);
console.log('✓ package.json');
[
  'server.js', 'start.sh', 'public/index.html', 'public/style.css', 'public/app.js',
  'lib/app-manager.js', 'lib/store.js', 'lib/net-probe.js', 'lib/net-status.js', 'lib/engine-adapter.js',
  'lib/display-proxy.js', 'lib/performance-monitor.js', 'lib/webkit-control.js', 'lib/webkit-engine-manager.js', 'lib/ai-agent.js', 'browser-gateway.js',
  'native/webkit-engine/main.cpp', 'native/webkit-engine/CMakeLists.txt', 'tests/browser/media-engine.test.js', 'tests/browser/security-policy.test.js', 'lib/security-policy.js', 'public/security.html'
].forEach((f) => {
  assert.ok(fs.existsSync(path.join(__dirname, f)), 'missing ' + f);
});
assert.ok(!fs.existsSync(path.join(__dirname, 'lib/web-gateway.js')));
console.log('✓ required files');
const html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, 'public/app.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const compose = fs.readFileSync(path.join(__dirname, 'docker-compose.yml'), 'utf8');
const dockerfile = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8');
const gateway = fs.readFileSync(path.join(__dirname, 'browser-gateway.js'), 'utf8');
assert.ok(html.includes('constellation'));
assert.ok(html.includes('/security'));
assert.ok(server.includes('/api/security/settings'));
assert.ok(server.includes('/api/security/validate'));
assert.ok(html.includes('browser-view'));
assert.ok(js.includes('/view/'));
assert.ok(server.includes("listen(PORT, '0.0.0.0'"));
assert.ok(server.includes('/ready'));
assert.ok(server.includes('/api/network/status'));
assert.ok(server.includes('engineManager.start()'));
assert.ok(!server.includes("require('./lib/web-gateway')"));
assert.ok(compose.includes('build: .'));
assert.ok(!/^\s*image:\s*\S/m.test(compose));
assert.ok(!dockerfile.includes('CEF_URL'));
assert.ok(!dockerfile.includes('chromium'));
assert.ok(!dockerfile.includes('CHROME_PATH'));
assert.ok(!server.includes('cdp-control'));
assert.ok(!dockerfile.match(/^\s*chromium\s*\\$/m));
assert.ok(dockerfile.includes('libwebkit2gtk-4.1'));
assert.ok(dockerfile.includes('solohost-webkit-engine'));
assert.ok(dockerfile.includes('novnc'));
assert.ok(dockerfile.includes('gstreamer1.0-libav'));
assert.ok(dockerfile.includes('gstreamer1.0-plugins-ugly'));
assert.ok(dockerfile.includes('gst-inspect-1.0'));
assert.ok(js.includes('media-volume'));
assert.ok(!gateway.includes('Page.startScreencast'));
console.log('✓ contracts');
console.log('All static tests passed successfully.');
