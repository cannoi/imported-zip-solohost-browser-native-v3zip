'use strict';
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');

function has(cmd) {
  try {
    execSync('command -v ' + cmd, { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function gstCheck() {
  if (!has('gst-inspect-1.0')) {
    return { available: false, note: 'gst-inspect-1.0 not in PATH' };
  }
  const plugins = {};
  for (const name of ['avdec_h264', 'openh264dec', 'vtdec', 'vaapih264dec', 'avdec_aac', 'faad', 'vorbisdec', 'vp8dec', 'vp9dec', 'playbin', 'webkit']) {
    try {
      execSync('gst-inspect-1.0 ' + name, { stdio: 'ignore' });
      plugins[name] = true;
    } catch {
      plugins[name] = false;
    }
  }
  return { available: true, plugins };
}

function webkitPkg() {
  try {
    const o = execSync('dpkg -l 2>/dev/null | grep -i webkit || true', { encoding: 'utf8' });
    return o.trim().slice(0, 500) || 'none';
  } catch {
    return 'unknown';
  }
}

const report = {
  measuredAt: new Date().toISOString(),
  environment: process.platform + ' ' + process.arch,
  gstreamer: gstCheck(),
  webkitPackages: webkitPkg(),
  playPauseSeekFullscreen: 'NOT TESTED — requires WebKitGTK display + user interaction',
  tabSwitchMedia: 'NOT TESTED',
  downloadUpload: 'NOT TESTED in automated suite',
  webrtc: 'NOT TESTED',
  drmWidevine: 'NOT CLAIMED — not verified',
  note: 'Proxy path can pass through media URLs as links/embeds; successful network fetch ≠ successful decode/playback.'
};

console.log(JSON.stringify(report, null, 2));
fs.writeFileSync('docs/MEDIA_PROBE.json', JSON.stringify(report, null, 2));
console.log('Wrote docs/MEDIA_PROBE.json');
