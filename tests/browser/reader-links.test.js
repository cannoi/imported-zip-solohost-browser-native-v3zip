'use strict';
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const { fixRelativeLinks } = require(path.join(root, 'lib/content-extractor.js'));

const base = 'https://news.example.com/section/page.html';
const html = '<article><p>See <a href="/tin-tuc/123">news</a> and <a href="sibling.html">sib</a> and <a href="https://ok.test/a">abs</a> and <a href="#frag">frag</a> and <a href="javascript:void(0)">js</a></p></article>';
const out = fixRelativeLinks(html, base);
assert.ok(out.includes('https://news.example.com/tin-tuc/123'), out);
assert.ok(out.includes('https://news.example.com/section/sibling.html'), out);
assert.ok(out.includes('https://ok.test/a'), out);
assert.ok(/#frag/.test(out), out);
assert.ok(/javascript:void\(0\)/.test(out), out);

const empty = fixRelativeLinks('', base);
assert.strictEqual(empty, '');
const broken = fixRelativeLinks('<a href=":::">x</a>', base);
assert.ok(typeof broken === 'string');

console.log('PASS reader-links');
