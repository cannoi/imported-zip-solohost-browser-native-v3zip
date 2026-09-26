const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
assert.ok(fs.existsSync(path.join(root, 'native', 'main.cpp')));
assert.ok(fs.existsSync(path.join(root, 'lib', 'engine-manager.js')));
assert.ok(!fs.existsSync(path.join(root, 'lib', 'web-gateway.js')));
const files = ['server.js','Dockerfile','docker-compose.yml','public/app.js','browser-gateway.js']
  .map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
assert.ok(!files.includes('var/run/docker'));
assert.ok(!files.includes('WebView2'));
assert.ok(!files.includes('CEF_URL'));
assert.ok(files.includes('chromium') || fs.readFileSync(path.join(root,'Dockerfile'),'utf8').includes('chromium'));
console.log('PASS chromium live-display architecture');
