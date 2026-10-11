
'use strict';
const { EventEmitter } = require('events');
const bus = new EventEmitter();
bus.setMaxListeners(50);
const recent = [];
const MAX = 100;

function push(evt) {
  const row = Object.assign({ ts: new Date().toISOString() }, evt || {});
  // never attach passwords
  if (row.password || row.secret) {
    delete row.password;
    delete row.secret;
  }
  recent.push(row);
  if (recent.length > MAX) recent.shift();
  bus.emit('progress', row);
  return row;
}

function list(n = 50) {
  return recent.slice(-n);
}

module.exports = { bus, push, list };
