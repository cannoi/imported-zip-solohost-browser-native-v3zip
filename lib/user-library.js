'use strict';

/**
 * Playlists, automation scripts, SoloHost app shortcuts — JSON persistence.
 * Scripts run client-side without AI when steps use navigate/wait only.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function dataDir() {
  return process.env.SOLOHOST_DATA_DIR || path.join(__dirname, '..', 'data');
}

function filePath(name) {
  return path.join(dataDir(), name);
}

function readJson(name, fallback) {
  try {
    const raw = fs.readFileSync(filePath(name), 'utf8');
    const j = JSON.parse(raw);
    return j == null ? fallback : j;
  } catch {
    return fallback;
  }
}

function writeJson(name, data) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(filePath(name), JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    return false;
  }
}

function id() {
  return crypto.randomBytes(6).toString('hex');
}

function nowIso() {
  return new Date().toISOString();
}

/* —— Playlists —— */
function listPlaylists() {
  const db = readJson('playlists.json', { playlists: [] });
  return Array.isArray(db.playlists) ? db.playlists : [];
}

function savePlaylists(list) {
  writeJson('playlists.json', { playlists: list, updatedAt: nowIso() });
}

function createPlaylist(title) {
  const list = listPlaylists();
  const pl = {
    id: id(),
    title: String(title || 'Playlist').slice(0, 120),
    items: [],
    createdAt: nowIso()
  };
  list.unshift(pl);
  savePlaylists(list);
  return pl;
}

function updatePlaylist(plId, patch) {
  const list = listPlaylists();
  const i = list.findIndex((p) => p.id === plId);
  if (i < 0) return null;
  if (patch.title != null) list[i].title = String(patch.title).slice(0, 120);
  if (Array.isArray(patch.items)) list[i].items = patch.items;
  list[i].updatedAt = nowIso();
  savePlaylists(list);
  return list[i];
}

function deletePlaylist(plId) {
  const list = listPlaylists().filter((p) => p.id !== plId);
  savePlaylists(list);
  return true;
}

function addPlaylistItem(plId, item) {
  const list = listPlaylists();
  const pl = list.find((p) => p.id === plId);
  if (!pl) return null;
  const entry = {
    id: id(),
    url: String(item.url || '').slice(0, 2048),
    title: String(item.title || item.url || 'Video').slice(0, 200),
    source: String(item.source || detectSource(item.url)).slice(0, 40),
    addedAt: nowIso()
  };
  if (!entry.url) return null;
  pl.items = pl.items || [];
  pl.items.push(entry);
  pl.updatedAt = nowIso();
  savePlaylists(list);
  return entry;
}

function removePlaylistItem(plId, itemId) {
  const list = listPlaylists();
  const pl = list.find((p) => p.id === plId);
  if (!pl) return false;
  pl.items = (pl.items || []).filter((x) => x.id !== itemId);
  pl.updatedAt = nowIso();
  savePlaylists(list);
  return true;
}

function detectSource(url) {
  const u = String(url || '').toLowerCase();
  if (/youtube\.com|youtu\.be/.test(u)) return 'youtube';
  if (/tiktok\.com/.test(u)) return 'tiktok';
  if (/facebook\.com|fb\.watch/.test(u)) return 'facebook';
  if (/vimeo\.com/.test(u)) return 'vimeo';
  if (/bilibili\.com/.test(u)) return 'bilibili';
  return 'web';
}

/* —— SoloHost apps —— */
function listApps() {
  const db = readJson('solohost-apps.json', { apps: [] });
  return Array.isArray(db.apps) ? db.apps : [];
}

function saveApps(apps) {
  writeJson('solohost-apps.json', { apps, updatedAt: nowIso() });
}

function addApp(name, url) {
  const apps = listApps();
  const entry = {
    id: id(),
    name: String(name || 'App').slice(0, 80),
    url: String(url || '').slice(0, 512),
    createdAt: nowIso()
  };
  apps.unshift(entry);
  saveApps(apps);
  return entry;
}

function removeApp(appId) {
  saveApps(listApps().filter((a) => a.id !== appId));
  return true;
}

/* —— Scripts (no AI required) —— */
const SAMPLE_SCRIPTS = [
  { id: 'sample-evening-meditation', name: 'Evening meditation · 21:00', nameVi: 'Nhạc thiền buổi tối · 21:00', description: 'At 21:00, open a YouTube meditation search in the Playlist player for 60 minutes.', descriptionVi: 'Lúc 21:00 mở tìm kiếm nhạc thiền YouTube trong trình phát Playlist trong 60 phút.', sample: true, steps: [{ type: 'waitUntil', time: '21:00' }, { type: 'navigate', url: 'https://www.youtube.com/results?search_query=nhac+thien+thu+gian+1+tieng' }, { type: 'stopAt', time: '22:00' }], schedule: { type: 'daily', time: '21:00', durationMinutes: 60 } },
  { id: 'sample-morning-music', name: 'Morning music · 07:00', nameVi: 'Nhạc buổi sáng · 07:00', description: 'Open relaxing music each morning at 07:00.', descriptionVi: 'Mở nhạc thư giãn mỗi sáng lúc 07:00.', sample: true, steps: [{ type: 'waitUntil', time: '07:00' }, { type: 'navigate', url: 'https://www.youtube.com/results?search_query=relaxing+morning+music' }], schedule: { type: 'daily', time: '07:00' } },
  { id: 'sample-daily-news', name: 'Daily news', nameVi: 'Tin tức mỗi ngày', description: 'Open a trusted news homepage when started.', descriptionVi: 'Mở trang tin tức khi được chạy.', sample: true, steps: [{ type: 'navigate', url: 'https://thanhnien.vn' }] },
  { id: 'sample-lofi-focus', name: 'Lo-fi focus music', nameVi: 'Nhạc lofi tập trung', description: 'Find lo-fi music on YouTube.', descriptionVi: 'Tìm nhạc lofi trên YouTube.', sample: true, steps: [{ type: 'navigate', url: 'https://www.youtube.com/results?search_query=lofi+focus+music' }] },
  { id: 'sample-wikipedia', name: 'Open Wikipedia', nameVi: 'Mở Wikipedia', description: 'Open the Vietnamese Wikipedia home page.', descriptionVi: 'Mở trang chủ Wikipedia tiếng Việt.', sample: true, steps: [{ type: 'navigate', url: 'https://vi.wikipedia.org' }] }
];

function listScripts() {
  const db = readJson('scripts.json', { scripts: [] });
  const user = Array.isArray(db.scripts) ? db.scripts : [];
  const sampleIds = new Set(SAMPLE_SCRIPTS.map((s) => s.id));
  const merged = SAMPLE_SCRIPTS.map((s) => {
    const override = user.find((u) => u.id === s.id);
    return override ? { ...s, ...override, sample: true } : { ...s };
  });
  // Ignore retired built-in sample IDs from older versions, but preserve real user-created tasks.
  const extra = user.filter((u) => !sampleIds.has(u.id) && !String(u.id || '').startsWith('sample-'));
  const deleted = new Set(user.filter((u) => u.deleted).map((u) => u.id));
  return merged.filter((s) => !deleted.has(s.id)).concat(extra.filter((s) => !s.deleted));
}

function saveUserScripts(scripts) {
  // Persist only non-default customizations + user scripts
  const sampleIds = new Set(SAMPLE_SCRIPTS.map((s) => s.id));
  const toSave = scripts.filter((s) => !s.sample || s.edited);
  writeJson('scripts.json', { scripts: toSave, updatedAt: nowIso() });
}

function createScript(body) {
  const all = listScripts();
  const s = {
    id: id(),
    name: String(body.name || 'Script').slice(0, 120),
    nameVi: String(body.nameVi || body.name || 'Script').slice(0, 120),
    description: String(body.description || '').slice(0, 400),
    descriptionVi: String(body.descriptionVi || body.description || '').slice(0, 400),
    sample: false,
    steps: Array.isArray(body.steps) ? body.steps.slice(0, 40) : [],
    schedule: body.schedule && typeof body.schedule === 'object' ? body.schedule : null,
    active: body.active !== false,
    createdAt: nowIso()
  };
  const user = readJson('scripts.json', { scripts: [] }).scripts || [];
  user.unshift(s);
  writeJson('scripts.json', { scripts: user, updatedAt: nowIso() });
  return s;
}

function updateScript(scriptId, patch) {
  const user = readJson('scripts.json', { scripts: [] }).scripts || [];
  let i = user.findIndex((s) => s.id === scriptId);
  const base = SAMPLE_SCRIPTS.find((s) => s.id === scriptId);
  if (i < 0 && base) {
    user.push({ ...base, sample: true, edited: true });
    i = user.length - 1;
  }
  if (i < 0) return null;
  if (patch.name != null) user[i].name = String(patch.name).slice(0, 120);
  if (patch.nameVi != null) user[i].nameVi = String(patch.nameVi).slice(0, 120);
  if (patch.description != null) user[i].description = String(patch.description).slice(0, 400);
  if (Array.isArray(patch.steps)) user[i].steps = patch.steps.slice(0, 40);
  if (patch.schedule !== undefined) user[i].schedule = patch.schedule;
  if (patch.active !== undefined) user[i].active = patch.active !== false;
  user[i].edited = true;
  writeJson('scripts.json', { scripts: user, updatedAt: nowIso() });
  return listScripts().find((s) => s.id === scriptId) || user[i];
}

function deleteScript(scriptId) {
  if (SAMPLE_SCRIPTS.some((s) => s.id === scriptId)) {
    // mark deleted for samples by storing tombstone
    const user = readJson('scripts.json', { scripts: [] }).scripts || [];
    const filtered = user.filter((s) => s.id !== scriptId);
    filtered.push({ id: scriptId, deleted: true });
    writeJson('scripts.json', { scripts: filtered, updatedAt: nowIso() });
    return true;
  }
  const user = (readJson('scripts.json', { scripts: [] }).scripts || []).filter((s) => s.id !== scriptId);
  writeJson('scripts.json', { scripts: user, updatedAt: nowIso() });
  return true;
}

function listScriptsVisible() {
  const deleted = new Set(
    (readJson('scripts.json', { scripts: [] }).scripts || [])
      .filter((s) => s.deleted)
      .map((s) => s.id)
  );
  return listScripts().filter((s) => !deleted.has(s.id) && !s.deleted);
}

module.exports = {
  listPlaylists,
  createPlaylist,
  updatePlaylist,
  deletePlaylist,
  addPlaylistItem,
  removePlaylistItem,
  detectSource,
  listApps,
  addApp,
  removeApp,
  listScripts: listScriptsVisible,
  createScript,
  updateScript,
  deleteScript,
  SAMPLE_SCRIPTS
};
