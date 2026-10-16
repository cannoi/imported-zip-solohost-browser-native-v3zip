'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const agent = require('./lib/browser-agent');
const evidence = require('./lib/agent-evidence');
const report = require('./lib/agent-report');
const research = require('./lib/agent-research-tools');
const newsDigest = require('./lib/agent-playbooks/news_digest');
const agentTools = require('./lib/agent-tools');

// 1. sanitizeHistory keeps step/thought/params
{
  const h = agent.sanitizeHistory([
    { step: 3, thought: 'open VN', action: { type: 'navigate', url: 'https://vnexpress.net/' }, result: 'ok', ok: true, url: 'https://vnexpress.net/' },
    { step: 4, thought: 'read', action: 'extract_page', result: 'title...', ok: true }
  ]);
  assert.strictEqual(h[0].step, 3);
  assert.ok(h[0].action && h[0].action.type === 'navigate');
  assert.ok(h[0].action.url.includes('vnexpress'));
  assert.ok(h[0].thought.includes('open'));
  assert.notStrictEqual(h[0].n, 0);
  console.log('[PASS] sanitizeHistory_fields');
}

// 2. press_key + note valid
{
  const pk = agent.validateAction({ type: 'press_key', key: 'Enter' }, { elements: [] });
  assert.ok(pk.ok, pk.error);
  const note = agent.validateAction({ type: 'note', text: 'finding A' }, {});
  assert.ok(note.ok);
  const bad = agent.validateAction({ type: 'press_key', key: 'Ctrl' }, {});
  assert.ok(!bad.ok);
  console.log('[PASS] press_key_note');
}

// 3. search brave allowed
{
  const s = agent.validateAction({ type: 'search', query: 'x', engine: 'brave' }, {});
  assert.ok(s.ok && s.action.engine === 'brave');
  console.log('[PASS] search_brave');
}

// 4. type press_enter kept
{
  const t = agent.validateAction({ type: 'type', id: 1, text: 'hi', press_enter: true }, { elements: [{ id: 1 }] });
  assert.ok(t.ok && t.action.press_enter);
  console.log('[PASS] type_press_enter');
}

// 5. AGENT_OBS budget not hard 3500 only
{
  assert.ok(agent.MAX_TEXT >= 6000 || agent.AGENT_OBS_TOKENS >= 2000);
  console.log('[PASS] obs_budget', agent.MAX_TEXT, agent.MAX_ELEMENTS);
}

// 6. evidence ledger
{
  const tid = 'test_' + Date.now();
  const e = evidence.addEvidence(tid, { url: 'https://example.com/a', title: 'A', text: 'Hello world evidence text', kind: 'article', publishedAt: '2026-10-15T10:00:00.000Z' });
  assert.ok(e.id.startsWith('E'));
  const hits = evidence.recall(tid, { query: 'Hello' });
  assert.ok(hits.length >= 1);
  evidence.clearTaskEvidence(tid);
  console.log('[PASS] evidence_ledger');
}

// 7. report no double summary + step labels
{
  const task = {
    lang: 'en',
    task: 'news',
    message: 'Done.',
    history: [
      { step: 1, thought: 'go', action: { type: 'navigate', url: 'https://a.com' }, result: 'ok', url: 'https://a.com' },
      { step: 2, thought: 'read', action: { type: 'extract_page' }, result: 'ok', url: 'https://a.com' }
    ],
    workMemory: { findings: ['[E1] Story about X https://a.com/story'], visited: ['https://a.com'] }
  };
  const fin = report.finalizeDoneMessage(task, 'Done.');
  assert.ok(fin.message.length > 40);
  const countSummary = (fin.message.match(/Result summary/gi) || []).length;
  assert.ok(countSummary <= 1, 'summary duplicated: ' + countSummary);
  const r = report.buildAgentReport(task);
  assert.ok(r.steps.some((s) => /navigate|extract/i.test(s.action)));
  console.log('[PASS] report_steps_and_dedupe');
}

// 8. RSS parse
{
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title>Tin 1</title><link>https://example.com/1</link><pubDate>Wed, 15 Oct 2026 08:00:00 GMT</pubDate><description>Mo ta</description></item>
    <item><title>Tin 2</title><link>https://example.com/2</link><pubDate>Wed, 15 Oct 2026 09:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const items = research.parseFeed(xml, 'https://example.com/rss');
  assert.strictEqual(items.length, 2);
  assert.ok(items[0].publishedAt);
  console.log('[PASS] parse_feed');
}

// 9. extract articles heuristic
{
  const html = `<html><body>
    <a href="/tin-tuc/2026/10/bai-viet-dai-ve-chinh-tri-123456.html">Bài viết dài về chính trị quan trọng hôm nay</a>
    <a href="/">Trang chủ</a>
  </body></html>`;
  const list = research.extractArticlesFromHtml(html, 'https://example.com/');
  assert.ok(list.length >= 1);
  console.log('[PASS] extract_articles_heuristic', list.length);
}

// 10. news playbook
{
  assert.ok(newsDigest.matchNewsIntent('Tổng hợp tin tức báo chí Việt Nam 24 giờ qua'));
  const cl = newsDigest.buildChecklist('news', 'vi');
  assert.ok(cl.sources.length >= 5);
  console.log('[PASS] news_digest_playbook');
}

// 11. fetchDocumentText uses manual redirect (source check)
{
  const src = fs.readFileSync(path.join(__dirname, 'lib/agent-tools.js'), 'utf8');
  assert.ok(src.includes("redirect: 'manual'"));
  assert.ok(src.includes('assertPublicHttpUrl'));
  console.log('[PASS] fetch_doc_manual_redirect');
}

// 12. ACTION_TYPES includes research tools
{
  assert.ok(agent.ACTION_TYPES.includes('fetch_feed'));
  assert.ok(agent.ACTION_TYPES.includes('read_article'));
  assert.ok(agent.ACTION_TYPES.includes('recall'));
  console.log('[PASS] action_types_research');
}

console.log('\nAll Phase 1-3 automated tests PASS');
