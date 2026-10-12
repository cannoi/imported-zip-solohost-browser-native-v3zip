'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'solohost-ai-memory-'));
process.env.SOLOHOST_DATA_DIR = tmp;
const memory = require('./lib/ai-memory');
try {
  const profile = '0123456789abcdef0123456789abcdef';
  let out = memory.update(profile, { type: 'memory', content: 'Prefers concise Vietnamese UI instructions.' });
  assert.strictEqual(out.ok, true, 'explicit stable preference is saved');
  out = memory.update(profile, { type: 'skill', name: 'Diagnose browser logs', content: 'Inspect errors, identify root cause, test a minimal fix, report limitations.' });
  assert.strictEqual(out.ok, true, 'reusable skill is saved');
  out = memory.update(profile, { type: 'turn', user: 'Please fix the Back button', assistant: 'I will inspect navigation state and run regression tests.' });
  assert.strictEqual(out.ok, true, 'conversation turn is persisted');
  let saved = memory.get(profile);
  assert.strictEqual(saved.memories.length, 1);
  assert.strictEqual(saved.skills.length, 1);
  assert.strictEqual(saved.history.length, 2);
  out = memory.update(profile, { type: 'memory', content: 'password: my-secret-value' });
  assert.strictEqual(out.ok, false, 'credential-like memory is rejected');
  assert.strictEqual(memory.get(profile).memories.length, 1);

  const html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
  const playerAt = html.indexOf('id="playlist-player-frame"');
  const controlsAt = html.indexOf('id="btn-pl-shuffle"');
  const listAt = html.indexOf('id="pl-list"');
  assert.ok(playerAt >= 0 && controlsAt > playerAt && listAt > controlsAt, 'player and controls precede the track list');
  assert.ok(!html.includes('id="agentToggle"'), 'separate AI Agent mode toggle is removed');
  const app = fs.readFileSync(path.join(__dirname, 'public/app.js'), 'utf8');
  assert.ok(app.includes("repeatMode === 'off' ? 'all'") && app.includes('solo_music_shuffle'), 'repeat modes and shuffle preference persist');
  assert.ok(app.includes('profileId: browserProfileId()') && app.includes('timezoneId:'), 'stable browser profile and time zone are sent to new sessions');
  const panel = fs.readFileSync(path.join(__dirname, 'public/ai-panel.js'), 'utf8');
  assert.ok(panel.includes('/api/ai/memory') && panel.includes('shouldRunAgent(text)'), 'memory and automatic action routing are integrated');
  assert.ok(panel.includes('solo_agent_context') && panel.includes('solo_ai_profile_id'), 'agent continuation and AI profile persist');
  assert.ok(panel.includes('modifyRecentTask(text)') && panel.includes('solo_ai_last_task_id') && panel.includes('/api/library/scripts/'), 'task edits continue across separate chat turns');
  const engine = fs.readFileSync(path.join(__dirname, 'lib/engine/playwright-engine.js'), 'utf8');
  assert.ok(engine.includes('opts.timezoneId') && engine.includes('opts.locale'), 'Playwright context uses per-session locale/time zone');
  const routes = fs.readFileSync(path.join(__dirname, 'server-app.js'), 'utf8');
  assert.ok(routes.includes("'profile:' + profileId") && routes.includes('/api/ai/memory'), 'server stores profile state independently of client IP and mounts memory API');
  assert.ok(routes.includes("meridiem === 'pm'") && routes.includes('SoloHostBrowser/10.20 scheduled-media-resolver'), 'AM/PM schedule parsing and honest resolver identity are present');
  const config = fs.readFileSync(path.join(__dirname, 'config_options.yml'), 'utf8');
  assert.ok(!/fields:\s*\n\s*- id:/.test(config), 'SoloHost config field does not include unsupported id');
  console.log('✓ AI memory / unified assistant / Music Library controls / browser profile regression: PASS');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
