const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
assert.ok(fs.existsSync(path.join(root, 'native', 'webkit-engine', 'main.cpp')));
assert.ok(fs.existsSync(path.join(root, 'lib', 'engine-adapter.js')));
assert.ok(!fs.existsSync(path.join(root, 'lib', 'web-gateway.js')));
const files = ['server.js','Dockerfile','docker-compose.yml','public/app.js','browser-gateway.js']
  .map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
assert.ok(!files.includes('var/run/docker'));
assert.ok(!files.includes('WebView2'));
assert.ok(!files.includes('CEF_URL'));
assert.ok(files.includes('webkit') || fs.readFileSync(path.join(root,'Dockerfile'),'utf8').includes('libwebkit2gtk-4.1'));
assert.ok(!fs.readFileSync(path.join(root,'Dockerfile'),'utf8').includes('chromium'));
assert.ok(!fs.readFileSync(path.join(root,'Dockerfile'),'utf8').match(/^\s*chromium\s*\\$/m));
console.log('PASS SoloHost WebKit live-display architecture');
