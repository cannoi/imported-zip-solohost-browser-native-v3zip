'use strict';
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const {
  fixRelativeLinks,
  normalizeLinks,
  normalizePageUrl,
  ContentExtractor
} = require(path.join(root, 'lib/content-extractor.js'));

const base = 'https://news.example.com/section/page.html';
const html = '<article><p>See <a href="/tin-tuc/123?utm_source=x&fbclid=1">news</a> and <a href="sibling.html">sib</a></p></article>';

// Without cheerio installed in sandbox, fallback path still works
const out = normalizeLinks(html, base);
assert.ok(out.includes('https://news.example.com/tin-tuc/123'), out);
assert.ok(!/utm_source/i.test(out), out);
assert.ok(!/fbclid/i.test(out), out);
assert.ok(out.includes('https://news.example.com/section/sibling.html'), out);

assert.strictEqual(normalizeLinks(html, base), fixRelativeLinks(html, base));

const cleaned = normalizePageUrl('https://news.example.com/a?utm_source=x&ref=y&keep=1#hash');
assert.ok(!/utm_source/.test(cleaned));
assert.ok(!/#/.test(cleaned));
assert.ok(/keep=1/.test(cleaned) || cleaned.includes('keep=1'));

const key = ContentExtractor.cacheKey('https://a.test/p?utm_medium=x#z');
assert.ok(!/utm_medium/.test(key));
assert.ok(!/#/.test(key));

console.log('PASS reader-links');
