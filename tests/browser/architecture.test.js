const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const native = path.join(root, 'native', 'windows', 'SoloHostBrowser');

assert.ok(fs.existsSync(path.join(native, 'SoloHostBrowser.csproj')));
assert.ok(fs.existsSync(path.join(native, 'Program.cs')));
assert.ok(fs.existsSync(path.join(native, 'MainForm.cs')));
assert.ok(fs.existsSync(path.join(native, 'Runtime', 'WebView2Detector.cs')));

const main = fs.readFileSync(path.join(native, 'MainForm.cs'), 'utf8');
assert.ok(main.includes('CoreWebView2'));
assert.ok(main.includes('NewWindowRequested'));
assert.ok(main.includes('DownloadStarting'));
assert.ok(main.includes('PermissionRequested'));
assert.ok(!main.includes('/api/proxy'));

const detector = fs.readFileSync(path.join(native, 'Runtime', 'WebView2Detector.cs'), 'utf8');
assert.ok(detector.includes('GetAvailableBrowserVersionString'));

const client = fs.readFileSync(path.join(native, 'SoloHost', 'SoloHostClient.cs'), 'utf8');
assert.ok(client.includes('not-detected'));

const repo = fs.readFileSync(path.join(root, 'native', 'windows', 'SoloHostBrowser', 'MainForm.cs'), 'utf8')
  + fs.readFileSync(path.join(root, 'README.md'), 'utf8');
assert.ok(!repo.includes('var/run/docker'));

console.log('PASS native architecture contracts');
console.log('NATIVE WINDOWS BUILD NOT EXECUTED');
