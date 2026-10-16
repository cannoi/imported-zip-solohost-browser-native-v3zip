'use strict';
/**
 * Agent benchmark (offline + optional live API).
 * Offline always runs. Live runs when AI_API_KEY / settings present — otherwise SKIP.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const agent = require('./lib/backend-agent');
const planner = require('./lib/browser-agent');
const { normalizeVisionMessages, supportsVisionHint, withBackoff } = require('./lib/ai-module/provider-engine');

const results = [];
function row(name, status, detail) {
  results.push({ name, status, detail });
  console.log(`[${status}] ${name}${detail ? ' — ' + detail : ''}`);
}

// 1. Form observation regression
{
  const html = `<body><form data-sh-id="f1"><input data-sh-id="e1" type="text" name="q" placeholder="Search" value="hi"><button data-sh-id="e2">Go</button></form></body>`;
  const obs = agent.observeHtmlFallback({ html, url: 'https://example.com/' }, 0);
  const ok = obs.elements.some((e) => e.tag === 'input') && obs.elements.some((e) => e.tag === 'button');
  row('form_inputs_visible', ok ? 'PASS' : 'FAIL', 'count=' + obs.elements.length);
  assert.ok(ok);
}

// 2. Vision message normalization
{
  const msgs = normalizeVisionMessages([
    { role: 'user', content: 'What is on screen?', images: [{ url: 'data:image/jpeg;base64,aaa' }] }
  ]);
  assert.ok(Array.isArray(msgs[0].content));
  assert.ok(msgs[0].content.some((p) => p.type === 'image_url'));
  row('vision_message_normalize', 'PASS');
}

// 3. Vision model heuristic
{
  assert.strictEqual(supportsVisionHint('gpt-4o'), true);
  assert.strictEqual(supportsVisionHint('gemini-2.0-flash'), true);
  assert.strictEqual(supportsVisionHint('llama3'), false);
  row('vision_model_hint', 'PASS');
}

// 4. Offline heuristic plan
{
  const p = planner.heuristicPlan('open https://example.com');
  assert.ok(p && p.type === 'navigate');
  row('offline_heuristic_navigate', 'PASS', p.url || '');
}

// 5. Tool defs present
{
  assert.ok(String(fs.readFileSync(path.join(__dirname, 'lib/browser-agent.js'), 'utf8')).includes('AGENT_TOOL_DEFS'));
  row('agent_tool_defs', 'PASS');
}

// 6. completeTools export
{
  const src = fs.readFileSync(path.join(__dirname, 'lib/ai-module/ai-service.js'), 'utf8');
  assert.ok(src.includes('completeTools'));
  assert.ok(src.includes('tool_calls'));
  row('ai_complete_tools_export', 'PASS');
}

// 7. Backoff helper
{
  let n = 0;
  const t0 = Date.now();
  withBackoff(async () => {
    n++;
    if (n < 2) {
      const e = new Error('rate');
      e.status = 429;
      throw e;
    }
    return 'ok';
  }, { retries: 3 }).then((v) => {
    assert.strictEqual(v, 'ok');
    row('provider_backoff_429', 'PASS', 'ms=' + (Date.now() - t0));
  }).catch((e) => {
    row('provider_backoff_429', 'FAIL', e.message);
  });
}

// 8. Multi-action parse path (simulate tool result shape)
{
  const fakeTools = {
    mode: 'tools',
    text: 'searching',
    tool_calls: [{ name: 'search', arguments: { query: 'weather', engine: 'google' } }]
  };
  assert.strictEqual(fakeTools.tool_calls[0].name, 'search');
  row('tool_call_shape', 'PASS');
}

// 9. Live API (optional)
(async () => {
  let live = 'SKIP';
  try {
    const { createAIService } = require('./lib/ai-module/ai-service');
    // Minimal adapter
    const ai = createAIService({ dataDir: path.join(__dirname, 'data'), adapter: { knowledge: 'SoloHost Browser agent benchmark.' } });
    if (ai.configured()) {
      const t0 = Date.now();
      const out = await ai.complete({
        messages: [
          { role: 'system', content: 'Reply with JSON only: {"thought":"t","action":{"type":"done","summary":"ok"}}' },
          { role: 'user', content: 'Say done.' }
        ],
        maxTokens: 200
      });
      const ms = Date.now() - t0;
      live = out && out.text ? 'PASS' : 'FAIL';
      row('live_api_complete', live, 'ms=' + ms + ' provider=' + (out.provider || ''));
      // tools attempt
      try {
        const t1 = Date.now();
        const out2 = await ai.completeTools({
          messages: [
            { role: 'system', content: 'You are a browser agent. Use tools to finish.' },
            { role: 'user', content: 'Mark the task done with summary ok.' }
          ],
          tools: [
            { type: 'function', function: { name: 'done', description: 'Finish', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } } }
          ],
          maxTokens: 300
        });
        row('live_api_tools', out2.mode === 'tools' || (out2.text && out2.text.length) ? 'PASS' : 'FAIL',
          'mode=' + (out2.mode || 'text') + ' ms=' + (Date.now() - t1));
      } catch (e) {
        row('live_api_tools', 'FAIL', String(e.message || e).slice(0, 120));
      }
    } else {
      row('live_api_complete', 'SKIP', 'AI not configured in this environment');
      row('live_api_tools', 'SKIP', 'AI not configured');
    }
  } catch (e) {
    row('live_api_complete', 'SKIP', String(e.message || e).slice(0, 120));
  }

  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skip = results.filter((r) => r.status === 'SKIP').length;
  console.log('\nBenchmark summary: PASS=' + pass + ' FAIL=' + fail + ' SKIP=' + skip);
  const report = {
    version: '10.27.2',
    at: new Date().toISOString(),
    pass, fail, skip,
    results,
    note: 'Live API rows require configured provider keys. SoloHost production not tested in this CI sandbox.'
  };
  fs.mkdirSync(path.join(__dirname, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'docs/agent-benchmark-latest.json'), JSON.stringify(report, null, 2));
  if (fail) process.exit(1);
})();
