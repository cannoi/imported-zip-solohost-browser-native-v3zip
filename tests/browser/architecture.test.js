const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

// Engine layer
for (const f of ['lib/chromium-engine.js', 'lib/engine-adapter.js', 'lib/engine-control.js', 'lib/content-extractor.js', 'lib/reader-view.js']) {
  assert.ok(fs.existsSync(path.join(root, f)), 'missing ' + f);
}
for (const f of ['native', 'lib/webkit-engine-manager.js', 'lib/display-manager.js', 'lib/display-proxy.js', 'lib/webkit-control.js', 'lib/web-gateway.js']) {
  assert.ok(!fs.existsSync(path.join(root, f)), 'should not exist: ' + f);
}
assert.ok(read('lib/engine-adapter.js').includes("require('./chromium-engine')"));

// Phase 2/3/4: JSON parse API + Native Reader + AI article skills
const server = read('server.js');
const gateway = read('browser-gateway.js');
const html = read('public/index.html');
const app = read('public/app.js');
const aiService = read('lib/ai-module/ai-service.js');
const aiRoutes = read('lib/ai-module/routes.js');
assert.ok(server.includes('/api/browser/parse'));
assert.ok(server.includes("require('express')"));
assert.ok(gateway.includes('toParseSchema') || gateway.includes('parseUrl'));
assert.ok(html.includes('reader-view'));
assert.ok(!/<canvas/i.test(html));
assert.ok(app.includes('/api/browser/parse'));
assert.ok(aiService.includes('summarizeArticle'));
assert.ok(aiService.includes('translateArticle'));
assert.ok(aiService.includes('askQuestion'));
assert.ok(aiRoutes.includes('/api/ai/summarize'));
assert.ok(aiRoutes.includes('/api/ai/translate'));
assert.ok(aiRoutes.includes('/api/ai/ask'));

const files = ['server.js', 'Dockerfile', 'docker-compose.yml', 'public/app.js', 'browser-gateway.js'].map(read).join('\n');
assert.ok(!files.includes('var/run/docker'));
assert.ok(!files.includes('WebView2'));
assert.ok(!files.includes('CEF_URL'));

const sources = ['server.js', 'browser-gateway.js', ...fs.readdirSync(path.join(root, 'lib')).filter(f => f.endsWith('.js')).map(f => 'lib/' + f)];
for (const f of sources) {
  const src = read(f);
  for (const dead of ['webkit-engine-manager', 'display-manager', 'display-proxy', 'webkit-control']) {
    assert.ok(!new RegExp("require\\([^)]*" + dead).test(src), `${f} still requires ${dead}`);
  }
}
for (const f of sources) {
  const src = read(f);
  for (const m of src.matchAll(/require\(['"](\.{1,2}\/[^'"]+)['"]\)/g)) {
    const target = path.resolve(path.dirname(path.join(root, f)), m[1]);
    assert.ok([target, target + '.js', path.join(target, 'index.js')].some(p => fs.existsSync(p)), `${f}: unresolved require ${m[1]}`);
  }
}
console.log('PASS architecture (chromium extract + reader + AI article skills)');
