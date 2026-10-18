'use strict';
/** Parallel retailer price fetch — injected deps keep behavior identical. */
const agentWeb = require('./agent-web');
const agentRunner = require('./agent-runner');
const appLog = require('./app-log');
let compareProducts = {};
try { compareProducts = require('./agent-sources/compare-products'); } catch (_) {}

function createRunCompareProductsParallel(deps) {
  return async function runCompareProductsParallel(task) {
  const push = deps.push;
  const persistTaskDisk = deps.persistTaskDisk;
  const assertSafeUrl = deps.assertSafeUrl;
  const agentEvidence = deps.agentEvidence;

  const retail = require('./agent-sources/vn-retail');
  const { safeFetch } = agentWeb;
  const query = (compareProducts.productQuery ? compareProducts.productQuery(task.task) : (String(task.task || '').match(/(?:iphone|samsung|galaxy|pixel|macbook|ipad|điện thoại)[^,]{0,50}/i) || ['product'])[0]).trim();
  const matched = retail.matchRetailersInText(task.task);
  const list = (matched.length ? matched : retail.defaultPhoneRetailers()).slice(0, 5);
  const jobs = list.map((r, i) => agentRunner.createJob(
    'retail-' + r.id,
    r.name,
    async () => {
      const url = r.searchUrl(query);
      await assertSafeUrl(url);
      const res = await safeFetch(url, { timeoutMs: 12000 });
      if (!res || !res.ok) {
        const err = new Error('fetch_failed_' + (res && res.status));
        err.blocked = res && res.status === 403;
        throw err;
      }
      const body = String(res.body || '');
      if (/captcha|verify you are human|unusual traffic/i.test(body.slice(0, 8000))) {
        const err = new Error('blocked_challenge');
        err.blocked = true;
        throw err;
      }
      const offers = retail.extractProductOffers(body, res.url || url);
      // Heuristic price from visible text if no JSON-LD
      let priceText = null;
      const pm = body.match(/(?:(?:đ|đ\s*|VND|₫)\s*)?([0-9]{1,3}(?:[.,][0-9]{3}){1,3})\s*(?:đ|₫|VND)?/i);
      if (pm) priceText = pm[1];
      return {
        retailer: r.name,
        host: r.host,
        url: res.url || url,
        offers: offers.slice(0, 5),
        priceHint: offers[0] && offers[0].price ? offers[0].price : priceText,
        title: offers[0] && offers[0].title ? offers[0].title : query,
        at: new Date().toISOString()
      };
    },
    { retailer: r.id }
  ));

  push(task, 'status', {
    message: task.lang === 'vi'
      ? 'Đang lấy giá song song từ ' + list.length + ' nhà bán…'
      : 'Fetching prices in parallel from ' + list.length + ' retailers…'
  });

  const batch = await agentRunner.runParallel(jobs, {
    concurrency: 3,
    timeoutMs: 20000,
    onProgress: (job) => {
      appLog.log('info', 'agent.subtask', {
        task: task.id, id: job.id, status: job.status, ms: job.ms, label: job.label
      });
    }
  });

  task.workMemory = task.workMemory || { findings: [], sources_status: {} };
  const rows = [];
  for (const job of batch.jobs) {
    const host = (job.meta && job.meta.retailer) || job.id;
    if (job.status === 'succeeded' && job.result) {
      task.workMemory.sources_status[job.result.host] = { status: 'ok', reason: 'parallel_fetch' };
      task.sourcesStatus = task.sourcesStatus || {};
      task.sourcesStatus[job.result.host] = { status: 'ok', reason: 'parallel_fetch' };
      task.workMemory.findings = (task.workMemory.findings || []).concat([{
        fact: (job.result.title || '') + ' @ ' + (job.result.priceHint || 'n/a') + ' — ' + job.result.retailer,
        url: job.result.url,
        step: task.history.length
      }]).slice(-40);
      try {
        agentEvidence.addEvidence(task.id, {
          type: 'price_observation',
          url: job.result.url,
          claim: job.result.priceHint || null,
          title: job.result.title,
          retailer: job.result.retailer
        });
      } catch (_) {}
      rows.push(job.result);
    } else {
      const st = {
        status: /block/i.test(job.error || '') ? 'blocked' : 'failed',
        reason: job.error || job.status
      };
      task.workMemory.sources_status[host] = st;
      task.sourcesStatus = task.sourcesStatus || {};
      task.sourcesStatus[host] = st;
    }
  }

  const okRows = rows.filter((r) => r.priceHint);
  let report;
  if (task.lang === 'vi') {
    report = '## So sánh giá (song song)\n\nTruy vấn: **' + query + '**\n\n';
    report += '| Nhà bán | Giá quan sát | Link | Trạng thái |\n|---|---|---|---|\n';
    for (const job of batch.jobs) {
      if (job.status === 'succeeded' && job.result) {
        report += '| ' + job.result.retailer + ' | ' + (job.result.priceHint || '—') + ' | ' + job.result.url + ' | ✓ |\n';
      } else {
        report += '| ' + job.label + ' | — | — | ' + (job.status === 'timed_out' ? 'timeout' : (job.error || job.status)) + ' |\n';
      }
    }
    report += '\n### Phạm vi & hạn chế\n';
    if (!okRows.length) {
      report += '- Chưa lấy được giá xác minh (nguồn chặn/timeout). **Không kết luận chỗ rẻ nhất.**\n';
      report += '- Thử Open ↗ từng cửa hàng hoặc xác minh thủ công, rồi bấm Tiếp tục.\n';
    } else {
      report += '- Chỉ so sánh các dòng có giá quan sát được; giá có thể là niêm yết, chưa gồm KM.\n';
      report += '- Thời điểm lấy: ' + new Date().toISOString() + '\n';
    }
  } else {
    report = '## Price comparison (parallel)\n\nQuery: **' + query + '**\n\n';
    report += '| Retailer | Observed price | Link | Status |\n|---|---|---|---|\n';
    for (const job of batch.jobs) {
      if (job.status === 'succeeded' && job.result) {
        report += '| ' + job.result.retailer + ' | ' + (job.result.priceHint || '—') + ' | ' + job.result.url + ' | ok |\n';
      } else {
        report += '| ' + job.label + ' | — | — | ' + (job.error || job.status) + ' |\n';
      }
    }
    report += '\n### Scope & limits\n';
    if (!okRows.length) {
      report += '- No verified prices (blocked/timeout). **Do not claim a cheapest store.**\n';
    } else {
      report += '- Only rows with observed prices are comparable; promo conditions may differ.\n';
    }
  }

  task.status = okRows.length ? (batch.failed.length ? 'partial' : 'done') : 'partial';
  task.message = report;
  task.history.push({
    thought: 'parallel_retail_fetch',
    action: { type: 'parallel_fetch', query },
    result: 'ok=' + batch.summary.ok + ' failed=' + batch.summary.failed,
    ok: okRows.length > 0,
    url: null
  });
  push(task, 'done', { message: report, status: task.status, summary: batch.summary });
  persistTaskDisk(task);
  return task;
}


}

module.exports = { createRunCompareProductsParallel };
