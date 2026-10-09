const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

// New engine layer exists, legacy layer is gone.
for (const f of ['lib/chromium-engine.js', 'lib/engine-adapter.js', 'lib/engine-control.js', 'lib/content-extractor.js', 'lib/reader-view.js']) {
  assert.ok(fs.existsSync(path.join(root, f)), 'missing ' + f);
}
for (const f of ['native', 'lib/webkit-engine-manager.js', 'lib/display-manager.js', 'lib/display-proxy.js', 'lib/webkit-control.js', 'lib/web-gateway.js']) {
  assert.ok(!fs.existsSync(path.join(root, f)), 'should not exist: ' + f);
}
assert.ok(read('lib/engine-adapter.js').includes("require('./chromium-engine')"));

const files = ['server.js', 'Dockerfile', 'docker-compose.yml', 'public/app.js', 'browser-gateway.js'].map(read).join('\n');
assert.ok(!files.includes('var/run/docker'));
assert.ok(!files.includes('WebView2'));
assert.ok(!files.includes('CEF_URL'));

// No source file may require a deleted module.
const sources = ['server.js', 'browser-gateway.js', ...fs.readdirSync(path.join(root, 'lib')).filter(f => f.endsWith('.js')).map(f => 'lib/' + f)];
for (const f of sources) {
  const src = read(f);
  for (const dead of ['webkit-engine-manager', 'display-manager', 'display-proxy', 'webkit-control']) {
    assert.ok(!new RegExp("require\\([^)]*" + dead).test(src), `${f} still requires ${dead}`);
  }
}

// Every relative require() in the app must resolve to a real file.
for (const f of sources) {
  const src = read(f);
  for (const m of src.matchAll(/require\(['"](\.{1,2}\/[^'"]+)['"]\)/g)) {
    const target = path.resolve(path.dirname(path.join(root, f)), m[1]);
    assert.ok([target, target + '.js', path.join(target, 'index.js')].some(p => fs.existsSync(p)), `${f}: unresolved require ${m[1]}`);
  }
}
console.log('PASS SoloHost Chromium headless-extract architecture');
