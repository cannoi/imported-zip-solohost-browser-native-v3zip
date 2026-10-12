'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'solohost-ai-tasks-'));
process.env.SOLOHOST_DATA_DIR = tmp;
const lib = require('./lib/user-library');
try {
  const samples = lib.listScripts();
  assert.strictEqual(samples.filter(s => s.sample).length, 5, 'exactly five starter tasks should be shown');
  assert.ok(samples.some(s => s.id === 'sample-evening-meditation'), 'evening meditation starter task exists');
  const task = lib.createScript({ name: 'Daily meditation', nameVi: 'Nhạc thiền', schedule: { type: 'daily', time: '21:00', durationMinutes: 60 }, steps: [{ type: 'navigate', url: 'https://www.youtube.com/results?search_query=meditation' }] });
  const saved = lib.listScripts().find(s => s.id === task.id);
  assert.strictEqual(saved.schedule.time, '21:00');
  assert.strictEqual(saved.schedule.durationMinutes, 60);
  assert.strictEqual(saved.active, true);
  const paused = lib.updateScript(task.id, { active: false });
  assert.strictEqual(paused.active, false, 'task pause state persists');
  const pl = lib.createPlaylist('Test music');
  const item = lib.addPlaylistItem(pl.id, { url: 'https://youtu.be/dNIvmhbEK4Y', title: 'Video' });
  assert.ok(item && item.source === 'youtube', 'YouTube link is added to music library');
  assert.strictEqual(lib.listPlaylists()[0].items.length, 1);
  const app = fs.readFileSync(path.join(__dirname, 'public/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, 'server-app.js'), 'utf8');
  const aiPanel = fs.readFileSync(path.join(__dirname, 'public/ai-panel.js'), 'utf8');
  assert.ok(app.includes('playlist-player-frame') && app.includes('getVideoEmbedUrl'), 'playlist uses embedded playback');
  assert.ok(!html.includes('id="sc-add-form"'), 'manual AI task form removed');
  assert.ok(aiPanel.includes('/api/library/tasks'), 'AI Panel creates tasks through task API');
  assert.ok(server.includes('BROWSER_ACCESS_PASSWORD') && server.includes('/api/runtime/locale'), 'password and IP locale features are wired');
  assert.ok(server.includes('/api/library/youtube/first'), 'scheduled YouTube music can resolve a result for embedded playback');
  console.log('AI Tasks / Playlist / access password / runtime locale regression: PASS');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
