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
  'lib/engine-control.js', 'lib/chromium-engine.js', 'lib/content-extractor.js', 'lib/reader-view.js',
  'lib/performance-monitor.js', 'lib/ai-agent.js', 'browser-gateway.js', 'scripts/smoke-extract.js',
  'tests/browser/media-engine.test.js', 'tests/browser/security-policy.test.js', 'tests/browser/content-extractor.test.js',
  'lib/security-policy.js', 'public/security.html'
].forEach((f) => {
  assert.ok(fs.existsSync(path.join(__dirname, f)), 'missing ' + f);
});
assert.ok(!fs.existsSync(path.join(__dirname, 'lib/web-gateway.js')));
// Phase 1: legacy WebKit / VNC pipeline must be gone.
['native/webkit-engine', 'lib/webkit-engine-manager.js', 'lib/display-manager.js', 'lib/display-proxy.js', 'lib/webkit-control.js'].forEach((f) => {
  assert.ok(!fs.existsSync(path.join(__dirname, f)), 'legacy file still present: ' + f);
});
console.log('✓ required files');
const html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, 'public/app.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const compose = fs.readFileSync(path.join(__dirname, 'docker-compose.yml'), 'utf8');
const dockerfile = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8');
const gateway = fs.readFileSync(path.join(__dirname, 'browser-gateway.js'), 'utf8');
assert.ok(html.includes('reader-view'));
assert.ok(html.includes('/security'));
assert.ok(server.includes('/api/security/settings'));
assert.ok(server.includes('/api/security/validate'));
assert.ok(html.includes('media-player-container'));
assert.ok(js.includes('/api/browser/parse'));
assert.ok(!/<canvas/i.test(html));
assert.ok(server.includes('/api/browser/parse'));
assert.ok(gateway.includes('EXTRACT_TIMEOUT_MS') || gateway.includes('30000'));
assert.ok(server.includes("listen(PORT, '0.0.0.0'"));
assert.ok(server.includes('/ready'));
assert.ok(server.includes('/api/network/status'));
assert.ok(server.includes('engineManager.start()'));
assert.ok(!server.includes("require('./lib/web-gateway')"));
assert.ok(compose.includes('build: .'));
assert.ok(!/^\s*image:\s*\S/m.test(compose));
assert.ok(!dockerfile.includes('CEF_URL'));
assert.ok(!server.includes('cdp-control'));
assert.ok(dockerfile.includes('mcr.microsoft.com/playwright:v1.40.0'));
for (const legacy of ['libwebkit2gtk', 'libgtk-3', 'cmake', 'CMakeLists', 'build-essential', 'xvfb', 'x11vnc', 'novnc', 'websockify', 'gstreamer', 'solohost-webkit-engine']) {
  assert.ok(!dockerfile.toLowerCase().includes(legacy.toLowerCase()), 'Dockerfile still references ' + legacy);
}
assert.ok(!server.includes('display-proxy') && !server.includes('display-manager'));
assert.ok(server.includes('/api/extract'));
for (const dep of ['playwright-core', 'playwright', '@mozilla/readability', 'jsdom', 'express']) {
  assert.ok(pkg.dependencies[dep], 'missing dependency ' + dep);
}
// Playwright npm version must equal the Docker image tag, or Chromium will not be found at runtime.
const tag = (dockerfile.match(/playwright:v([0-9.]+)/) || [])[1];
assert.strictEqual(pkg.dependencies['playwright-core'], tag);
assert.strictEqual(pkg.dependencies.playwright, tag);
assert.ok(js.includes('media-video') || js.includes('setupMedia') || js.includes('hls'));
assert.ok(!gateway.includes('Page.startScreencast'));
console.log('✓ contracts');
console.log('All static tests passed successfully.');
