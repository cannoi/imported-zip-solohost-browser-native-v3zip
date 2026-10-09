'use strict';
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const {
  detectChallenge,
  isThinArticle,
  normalizeText,
  countWords
} = require(path.join(root, 'lib/content-extractor.js'));

const googleSorry = `
<html><body>
<h1>About this page</h1>
<p>Our systems have detected unusual traffic from your computer network.
This page checks to see if it's really you sending the requests, and not a robot.</p>
</body></html>`;
const ch = detectChallenge(googleSorry, '', 'https://www.google.com/search?q=x');
assert.ok(ch);
assert.strictEqual(ch.reason, 'google_traffic_check');

const thin = 'Tổng biên tập: A. Phó tổng biên tập: B. Giấy phép xuất bản số 110.';
assert.ok(isThinArticle(thin, '<p>' + thin + '</p>'));

const rich = ('Tin nóng trong ngày. ' + 'Nội dung bài viết khá dài để vượt ngưỡng. ').repeat(20);
assert.ok(!isThinArticle(rich, '<p>' + rich + '</p>'));
assert.ok(countWords(normalizeText(rich)) > 80);

const gw = require(path.join(root, 'browser-gateway.js'));
const schema = gw.toParseSchema({
  title: 'Test',
  kind: 'challenge',
  challenge: ch,
  clean_html: '<p>x</p>',
  raw_text: 'x',
  media: []
});
assert.ok(schema.challenge || (schema.diagnostics && schema.diagnostics.challenge));
console.log('PASS extract-quality');
