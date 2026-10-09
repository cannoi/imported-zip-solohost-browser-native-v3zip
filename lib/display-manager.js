'use strict';

/**
 * V7.7 Display Engine abstraction.
 *
 * SoloHost Browser is opened inside Pi Browser. A native WebKit surface cannot
 * be embedded into that DOM, so a pixel transport is still required.
 *
 * Default transport remains RFB over websockify/noVNC (proven on SoloHost).
 * This module centralizes encoding limits, health reporting, and a pluggable
 * path name so a lighter transport can replace noVNC only after measured gain.
 *
 * Env (all optional):
 *   SOLOHOST_DISPLAY_MODE=novnc|off
 *   SOLOHOST_DISPLAY_FPS=12
 *   SOLOHOST_DISPLAY_WAIT_MS=25
 *   SOLOHOST_DISPLAY_DEFER_MS=25
 *   SOLOHOST_DISPLAY_NCACHE=8
 *   SOLOHOST_DISPLAY_SPEEDS=dsl   (modem|dsl|lan)
 *   DISPLAY_PORT / VNC_PORT
 */

const DISPLAY = process.env.DISPLAY || ':99';
const VNC_PORT = Number(process.env.VNC_PORT || 5900);
const DISPLAY_PORT = Number(process.env.DISPLAY_PORT || 6080);
const MODE = String(process.env.SOLOHOST_DISPLAY_MODE || 'novnc').toLowerCase();
const FPS = Math.max(4, Math.min(30, Number(process.env.SOLOHOST_DISPLAY_FPS || 12)));
const WAIT_MS = Math.max(0, Math.min(200, Number(process.env.SOLOHOST_DISPLAY_WAIT_MS || 25)));
const DEFER_MS = Math.max(0, Math.min(200, Number(process.env.SOLOHOST_DISPLAY_DEFER_MS || 25)));
const NCACHE = Math.max(0, Math.min(20, Number(process.env.SOLOHOST_DISPLAY_NCACHE || 8)));
const SPEEDS = String(process.env.SOLOHOST_DISPLAY_SPEEDS || 'dsl').toLowerCase();

function mode() {
  if (MODE === 'off' || MODE === 'none') return 'off';
  return 'novnc';
}

function x11vncArgs() {
  const args = [
    '-display', DISPLAY,
    '-forever',
    '-shared',
    '-nopw',
    '-localhost',
    '-rfbport', String(VNC_PORT),
    '-quiet',
    '-nocursor',
    '-fps', String(FPS),
    '-wait', String(WAIT_MS),
    '-defer', String(DEFER_MS)
  ];
  if (NCACHE > 0) {
    args.push('-ncache', String(NCACHE));
    args.push('-ncache_cr');
  }
  if (SPEEDS === 'modem' || SPEEDS === 'dsl' || SPEEDS === 'lan') {
    args.push('-speeds', SPEEDS);
  args.push('-noxdamage');
  args.push('-xkb');
  }
  return args;
}

function websockifyArgs() {
  return [
    '--web=/usr/share/novnc',
    `127.0.0.1:${DISPLAY_PORT}`,
    `127.0.0.1:${VNC_PORT}`
  ];
}

function snapshot(extra = {}) {
  return {
    path: mode() === 'off' ? 'disabled' : 'webkit → Xvfb → x11vnc(RFB) → websockify → noVNC',
    mode: mode(),
    transport: mode() === 'novnc' ? 'rfb-novnc' : 'off',
    goal: 'webkit → native surface → efficient transport → SoloHost UI',
    constraint: 'Pi Browser cannot host a native WebKit surface; a pixel transport remains required until an alternative is proven on SoloHost.',
    ports: { vnc: VNC_PORT, display: DISPLAY_PORT },
    tuning: {
      fps: FPS,
      waitMs: WAIT_MS,
      deferMs: DEFER_MS,
      ncache: NCACHE,
      speeds: SPEEDS
    },
    default: 'novnc',
    experimentalAlternatives: [
      'WebRTC/Selkies (lower latency, larger image, TURN/proxy risk)',
      'KasmVNC (still RFB-class)',
      'Native offscreen frame WS (requires new native capture path)'
    ],
    ...extra
  };
}

module.exports = {
  mode,
  x11vncArgs,
  websockifyArgs,
  snapshot,
  VNC_PORT,
  DISPLAY_PORT,
  DISPLAY,
  FPS
};
