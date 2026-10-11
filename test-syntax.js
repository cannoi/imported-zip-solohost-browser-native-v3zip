'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = __dirname;
const skip = new Set(['node_modules', '.git']);
const files = [];
function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) { if (!skip.has(ent.name)) walk(path.join(dir, ent.name)); continue; }
    if (ent.isFile() && ent.name.endsWith('.js')) files.push(path.join(dir, ent.name));
  }
}
walk(root);
let failed = 0;
for (const file of files) {
  try { new vm.Script(fs.readFileSync(file, 'utf8'), { filename: path.relative(root, file) }); }
  catch (e) { failed++; console.error('SYNTAX FAIL', path.relative(root, file), e.message); }
}
console.log(`JavaScript syntax: ${files.length - failed}/${files.length} passed`);
if (failed) process.exitCode = 1;
