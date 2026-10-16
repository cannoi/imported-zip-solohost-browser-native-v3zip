'use strict';
/**
 * Bounded parallel task runner — independent jobs with timeout, no cascade failure.
 * status: pending | running | succeeded | failed | timed_out | skipped
 */
function createJob(id, label, fn, meta) {
  return {
    id: String(id),
    label: String(label || id),
    fn,
    meta: meta || {},
    status: 'pending',
    result: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    ms: 0
  };
}

async function runWithTimeout(fn, ms) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(Object.assign(new Error('timed_out'), { code: 'timed_out' })), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run jobs with concurrency limit. Failed jobs do not stop others.
 * @param {Array} jobs from createJob
 * @param {{ concurrency?: number, timeoutMs?: number, onProgress?: function }} opts
 */
async function runParallel(jobs, opts = {}) {
  const concurrency = Math.max(1, Math.min(8, Number(opts.concurrency) || 3));
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || 45000);
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const queue = jobs.slice();
  let idx = 0;

  async function worker() {
    while (idx < queue.length) {
      const i = idx++;
      const job = queue[i];
      if (!job || job.status === 'skipped') continue;
      job.status = 'running';
      job.startedAt = Date.now();
      if (onProgress) try { onProgress(job); } catch (_) {}
      try {
        const result = await runWithTimeout(() => job.fn(job), timeoutMs);
        job.result = result;
        job.status = 'succeeded';
      } catch (e) {
        job.error = String(e && e.message || e).slice(0, 300);
        job.status = (e && e.code === 'timed_out') ? 'timed_out' : 'failed';
      }
      job.finishedAt = Date.now();
      job.ms = job.finishedAt - (job.startedAt || job.finishedAt);
      if (onProgress) try { onProgress(job); } catch (_) {}
    }
  }

  const workers = [];
  for (let w = 0; w < concurrency; w++) workers.push(worker());
  await Promise.all(workers);

  return {
    jobs,
    succeeded: jobs.filter((j) => j.status === 'succeeded'),
    failed: jobs.filter((j) => j.status === 'failed' || j.status === 'timed_out'),
    summary: {
      total: jobs.length,
      ok: jobs.filter((j) => j.status === 'succeeded').length,
      failed: jobs.filter((j) => j.status === 'failed').length,
      timed_out: jobs.filter((j) => j.status === 'timed_out').length,
      skipped: jobs.filter((j) => j.status === 'skipped').length
    }
  };
}

module.exports = { createJob, runParallel };
