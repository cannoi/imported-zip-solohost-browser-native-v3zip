'use strict';

const fs = require('fs');
const os = require('os');

let previousCpu = process.cpuUsage();
let previousCpuAt = process.hrtime.bigint();
let previousProcessTicks = new Map();
let previousProcessAt = process.hrtime.bigint();

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}
function readStatus(pid) {
  const raw = readText(`/proc/${Number(pid)}/status`);
  if (!raw) return null;
  const out = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^(VmRSS|VmHWM|VmSize|Threads):\s+(\d+)/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return { pid: Number(pid), rssBytes: (out.VmRSS || 0) * 1024, peakRssBytes: (out.VmHWM || 0) * 1024, virtualBytes: (out.VmSize || 0) * 1024, threads: out.Threads || null };
}
function readProcessTable() {
  const rows = new Map();
  let entries = [];
  try { entries = fs.readdirSync('/proc', { withFileTypes: true }).filter(e => e.isDirectory() && /^\d+$/.test(e.name)); } catch {}
  for (const entry of entries) {
    const pid = Number(entry.name);
    const stat = readText(`/proc/${pid}/stat`);
    const close = stat.lastIndexOf(')');
    if (close < 0) continue;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const ppid = Number(fields[1]); // /proc/<pid>/stat field 4 (after comm/state)
    const userTicks = Number(fields[11] || 0); // stat field 14
    const systemTicks = Number(fields[12] || 0); // stat field 15
    if (Number.isFinite(ppid)) rows.set(pid, { pid, ppid, userTicks, systemTicks, status: readStatus(pid) });
  }
  return rows;
}
function descendantsOf(rootPids) {
  const table = readProcessTable();
  const known = new Set(rootPids.filter(Number.isFinite));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of table.values()) if (!known.has(row.pid) && known.has(row.ppid)) { known.add(row.pid); changed = true; }
  }
  return [...known].map(pid => table.get(pid)).filter(Boolean);
}
function readCgroupMemory() {
  const current = Number(readText('/sys/fs/cgroup/memory.current').trim());
  const maxRaw = readText('/sys/fs/cgroup/memory.max').trim();
  const max = maxRaw && maxRaw !== 'max' ? Number(maxRaw) : null;
  return {
    currentBytes: Number.isFinite(current) && current > 0 ? current : null,
    limitBytes: Number.isFinite(max) && max > 0 ? max : null,
    usagePercent: Number.isFinite(current) && Number.isFinite(max) && max > 0 ? Math.round(current / max * 1000) / 10 : null
  };
}
function sample(engine = {}) {
  const now = process.hrtime.bigint();
  const elapsedUs = Number(now - previousCpuAt) / 1000;
  const cpu = process.cpuUsage(previousCpu);
  previousCpu = process.cpuUsage();
  previousCpuAt = now;
  const cpuPercent = elapsedUs > 0 ? Math.round(((cpu.user + cpu.system) / elapsedUs) * 1000) / 10 : null;
  const mem = process.memoryUsage();
  const childProcesses = {};
  for (const [name, pid] of Object.entries(engine.processIds || {})) {
    if (pid) childProcesses[name] = readStatus(pid);
  }
  const childRssBytes = Object.values(childProcesses).reduce((sum, p) => sum + (p?.rssBytes || 0), 0);
  const processAt = process.hrtime.bigint();
  const processElapsedSeconds = Number(processAt - previousProcessAt) / 1e9;
  const descendantRows = descendantsOf(Object.values(engine.processIds || {}).filter(Number.isFinite));
  const descendantProcesses = descendantRows.map(row => {
    const old = previousProcessTicks.get(row.pid);
    const ticks = row.userTicks + row.systemTicks;
    const cpuPercent = old && processElapsedSeconds > 0 ? Math.max(0, Math.round((ticks - old) / processElapsedSeconds * 10) / 10) : null;
    return { ...row.status, cpuPercentOfOneCore: cpuPercent };
  });
  previousProcessTicks = new Map(descendantRows.map(row => [row.pid, row.userTicks + row.systemTicks]));
  previousProcessAt = processAt;
  const descendantRssBytes = descendantProcesses.reduce((sum, p) => sum + (p.rssBytes || 0), 0);
  const displayProcesses = {};
  for (const [name, pid] of Object.entries(engine.processIds || {})) {
    const found = descendantProcesses.find(p => p.pid === pid);
    if (found) displayProcesses[name] = found;
  }
  return {
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime() * 10) / 10,
    node: { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed, heapTotalBytes: mem.heapTotal, externalBytes: mem.external, cpuPercentSinceLastSample: cpuPercent },
    cgroupMemory: readCgroupMemory(),
    host: { cpuCount: os.cpus().length, totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem() },
    browserProcesses: { directChildren: childProcesses, directChildrenRssBytes: childRssBytes, descendantCount: descendantProcesses.length, descendantRssBytes, trackedByRole: displayProcesses, descendants: descendantProcesses },
    browser: { status: engine.status || 'unknown', tabCount: Array.isArray(engine.tabs) ? engine.tabs.length : 0, activeTab: engine.active || '', restarts: engine.restarts || 0, display: engine.display || null },
    measurementNotes: ['Node CPU is a short interval sample and can vary with request load.', 'Descendant CPU is expressed as percent of one CPU core from Linux /proc tick deltas; first sample is null and detached/re-parented subprocesses may be omitted.', 'This endpoint does not measure page FPS, input latency, network bytes, or decoded image memory.']
  };
}
module.exports = { sample, readStatus, readCgroupMemory };
