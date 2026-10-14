'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
console.log('Running SoloHost Browser verification...');
const root = __dirname;
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.ok(pkg.dependencies.express);
assert.ok(pkg.dependencies.playwright || pkg.dependencies['playwright-core'], 'playwright engine dependency');
assert.ok(fs.existsSync(path.join(root, 'lib/ai-module/ai-service.js')));
assert.ok(fs.existsSync(path.join(root, 'lib/feedback-module/feedback-service.js')));
assert.ok(fs.existsSync(path.join(root, 'public/ai-panel.js')));
assert.ok(fs.existsSync(path.join(root, 'public/ai-module/ai-module.js')));
assert.ok(fs.existsSync(path.join(root, 'lib/app-adapter.js')));
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const serverApp = fs.readFileSync(path.join(root, 'server-app.js'), 'utf8');
const fullServer = server + '\n' + serverApp;
assert.ok(fullServer.includes('mountAIRoutes'));
assert.ok(fullServer.includes('mountFeedbackRoutes'));
assert.ok(fullServer.includes('/api/proxy'));
assert.ok(fullServer.includes('/api/browser/history'));
assert.ok(fullServer.includes('/api/browser/bookmarks'));
assert.ok(!fullServer.includes("require('./browser-gateway')"));
assert.ok(fullServer.includes('playwright-engine') || fullServer.includes('playwrightEngine'));
const fb = fs.readFileSync(path.join(root, 'lib/feedback-module/feedback-service.js'), 'utf8');
assert.ok(fb.includes('SHFH-CANNOI-0905428801'));
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
assert.ok(html.includes('id="aiFab"'));
assert.ok(html.includes('ai-module/ai-module.js'));
assert.ok(html.includes('feedback-module/feedback-module.js'));
assert.ok(html.includes('pane-settings') || html.includes('setProvider'));
assert.ok(html.includes('tab-strip'));
assert.ok(html.includes('chrome-bottom'));
assert.ok(html.includes('btn-home'));
assert.ok(html.includes('library-overlay'));
const appJs = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
assert.ok(appJs.includes('function newTab'));
assert.ok(appJs.includes('function addCurrentBookmark'));
assert.ok(appJs.includes('saveVisit(url)'));
assert.ok(appJs.includes('function isInternalBridgeViewUrl'), 'bridge viewport URL must not become the active website URL');
assert.ok(appJs.includes('navigate_internal_view_blocked'), 'internal viewport navigation must be blocked');
assert.ok(fullServer.includes('internal_url_not_navigable'), 'server must reject recursive navigation into its own session view');
assert.ok(appJs.indexOf('if (href && isInternalBridgeViewUrl(href))') < appJs.indexOf('state.url = realHref'), 'internal bridge view must be excluded before syncing iframe URL');
console.log('✓ package.json');
console.log('✓ required files');
console.log('✓ contracts');

// WebView proxy rendering/security regression tests.
const proxy = require('./lib/frame-proxy');
assert.strictEqual(proxy.isPrivateIp('127.0.0.1'), true);
assert.strictEqual(proxy.isPrivateIp('10.1.2.3'), true);
assert.strictEqual(proxy.isPrivateIp('192.168.1.1'), true);
assert.strictEqual(proxy.isPrivateIp('169.254.169.254'), true);
assert.strictEqual(proxy.isPrivateIp('224.0.0.1'), true);
assert.strictEqual(proxy.isPrivateIp('::1'), true);
assert.strictEqual(proxy.isPrivateIp('::ffff:127.0.0.1'), true);
assert.strictEqual(proxy.isPrivateIp('8.8.8.8'), false);

// Regression coverage for normal website navigation and media assets.
const googleUrl = proxy.normalizeTargetUrl('https://www.google.com/search?q=Phim%20hay&client=browser&source=hp');
assert.ok(/q=Phim[+%20]hay/i.test(googleUrl) || googleUrl.includes('Phim'), 'Google query must be preserved');
assert.ok(googleUrl.includes('gbv=1'), 'proxy forces gbv=1 so results render without SPA JS');
const googleMobile = proxy.normalizeTargetUrl('https://www.google.com/m?q=phim+hay&client=ms-opera-mobile');
assert.ok(googleMobile.includes('/search'), 'Google /m must map to /search');
assert.ok(googleMobile.includes('gbv=1'), 'Google /m must use HTML mode');
assert.ok(proxy.specialShell('https://www.google.com/').includes('/api/browser/go'), 'Google shell form needs no-JS action');
assert.ok(proxy.specialShell('https://www.youtube.com/').includes('/api/browser/go'), 'YouTube shell form needs no-JS action');
assert.strictEqual(proxy.specialShell('https://www.iq.com/movie?lang=vi_vn'), null, 'streaming site must not be replaced by a fake shell');
const srcsetHtml = proxy.rewriteHtml('<html><head></head><body><img srcset="/a.webp 1x, /b.webp 2x"></body></html>', 'https://example.org/page');
assert.ok(srcsetHtml.includes('srcset="https://example.org/a.webp 1x, https://example.org/b.webp 2x"'), 'srcset image URLs must stay direct to origin');
assert.ok(!/srcset="[^"]*api\/proxy/i.test(srcsetHtml), 'srcset must not route image variants through proxy');
const rewritten = proxy.rewriteHtml('<html><head><link rel="stylesheet" href="/site.css"></head><body><img src="/hero.png"><script src="/app.js"></script><a href="https://example.com/path">Next</a></body></html>', 'https://example.org/page');
// Navigation links are normalized to absolute URLs and routed by the injected SoloHost click bridge; static assets stay on origin.
assert.ok(rewritten.includes('data-sh-nav="1"'), 'anchors should be routed through the SoloHost navigation bridge');
assert.ok(rewritten.includes('https://example.org/site.css'), 'stylesheets should be absolute origin, not nested proxy');
assert.ok(rewritten.includes('https://example.org/hero.png'), 'images should be absolute origin');
assert.ok(rewritten.includes('name="viewport"'), 'mobile viewport should be present');
assert.ok(rewritten.includes('href="https://example.com/path"'), 'external anchors should normalize to their absolute destination');
const css = proxy.rewriteCss('.hero{background:url("../img/a.png")} @import "./theme.css";', 'https://example.org/css/site.css');
assert.ok(css.includes('https://example.org/img/a.png'), 'CSS url() should absolutize to origin');
assert.ok(css.includes('https://example.org/css/theme.css'), 'CSS @import should absolutize to origin');
assert.ok(!css.includes('/api/proxy?url='), 'CSS must not nest proxy URLs');
// Nested proxy unwrap
assert.ok(proxy.normalizeTargetUrl('http://14.176.78.46:62160/api/proxy?url=' + encodeURIComponent('https://static.example.com/a.css')) === 'https://static.example.com/a.css');
(async () => {
  await assert.rejects(proxy.assertPublicHttpUrl('file:///etc/passwd'));
  await assert.rejects(proxy.assertPublicHttpUrl('http://127.0.0.1/'));
  await assert.rejects(proxy.assertPublicHttpUrl('http://[::1]/'));
  await assert.rejects(proxy.assertPublicHttpUrl('http://user:pass@example.com/'));
  console.log('✓ proxy rendering and SSRF regression checks');
  console.log('All static tests passed successfully.');
})().catch(err => { console.error(err); process.exitCode = 1; });

// Regression checks for the reported login/video/agent failures.
const browserAgentSource = fs.readFileSync(path.join(root, 'lib/browser-agent.js'), 'utf8');
assert.ok(browserAgentSource.includes('function systemPrompt'), 'agent planner source should load');
const domBridge = require('./lib/engine/dom-bridge');
const loginHtml = '<!doctype html><html><head><title>Sign in</title></head><body><form><input type="email" data-sh-id="e1"><input type="password" data-sh-id="e2"><button data-sh-id="e3">Next</button></form></body></html>';
const loginView = domBridge.buildHybridView({ url: 'https://accounts.google.com/v3/signin', title: 'Sign in', html: loginHtml }, {
  url: 'https://accounts.google.com/v3/signin', title: 'Sign in', html: loginHtml, textLen: 12, mapCount: 3, hasPassword: true
});
assert.ok(loginView.includes('type="password"') && loginView.includes('data-sh-id="e2"'), 'login DOM controls must remain interactive instead of screenshot-only');
const googleView = domBridge.buildHybridView({ url: 'https://www.google.com/', title: 'Google', html: '<!doctype html><html><body><form><input type="search" name="q" data-sh-id="e1"><button data-sh-id="e2">Search</button></form></body></html>' }, {
  url: 'https://www.google.com/', title: 'Google', html: '<!doctype html><html><body><form><input type="search" name="q" data-sh-id="e1"><button data-sh-id="e2">Search</button></form></body></html>', textLen: 6, mapCount: 2, screenshot: 'data:image/jpeg;base64,AAAA'
});
assert.ok(googleView.includes('type="search"') && !googleView.includes('Page shell is mostly script-driven'), 'sparse Google search controls must stay interactive despite a screenshot');
const ytView = domBridge.buildHybridView({ url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA', title: 'Video', html: '<html><body><a href="https://www.youtube.com/watch?v=AAAAAAAAAAA">video</a></body></html>', youtubeIds: ['AAAAAAAAAAA'] }, {
  url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA', title: 'Video', html: '<html><body><a href="https://www.youtube.com/watch?v=AAAAAAAAAAA">video</a></body></html>', youtubeIds: ['AAAAAAAAAAA'], textLen: 100, mapCount: 2
});
assert.ok(ytView.includes('youtube.com/embed/AAAAAAAAAAA') && ytView.includes('allowfullscreen'), 'YouTube hybrid view must contain a playable embed');
assert.ok(fullServer.includes('frame-src https://www.youtube.com'), 'viewport CSP must allow official YouTube player frames');
assert.ok(fs.readFileSync(path.join(root, 'public/app.js'), 'utf8').includes('allow-same-origin allow-forms allow-scripts'), 'Bridge viewport keeps the controlled interaction sandbox');
assert.ok(!fs.readFileSync(path.join(root, 'public/app.js'), 'utf8').includes('allow-popups allow-scripts'), 'site links must be routed through SoloHost tabs, not uncontrolled popups');
console.log('✓ login DOM, YouTube embed and agent regressions');
