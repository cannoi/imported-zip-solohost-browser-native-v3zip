'use strict';
/**
 * Lightweight planner: rules first, optional single LLM call for ambiguous briefs.
 * Produces TaskState.plan.jobs for the runner DAG.
 */
const intent = require('./agent-intent');
const compareProducts = require('./agent-playbooks/compare_products');
const newsDigest = require('./agent-playbooks/news_digest');

function createTaskState(brief, opts = {}) {
  return {
    id: opts.id || ('task_' + Date.now().toString(36)),
    sessionId: opts.sessionId || null,
    brief: String(brief || '').slice(0, 8000),
    language: opts.language || (intent.classifyIntent(brief).kind === 'CHAT' ? 'en' : (opts.lang || 'en')),
    plan: { jobs: [] },
    jobStates: {},
    evidence: [],
    report: null,
    errors: [],
    status: 'planned',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

function planFromRules(brief, lang) {
  const text = String(brief || '');
  const c = intent.classifyIntent(text);
  if (c.kind === 'CHAT') return { intent: 'CHAT', jobs: [] };
  if (c.kind === 'QUICK_LOOKUP') {
    const url = (text.match(/https?:\/\/[^\s]+/i) || [])[0];
    return {
      intent: 'LOOKUP',
      jobs: url ? [{ id: 'open1', label: 'Open URL', kind: 'navigate', params: { url }, depends_on: [], fallbacks: [] }] : []
    };
  }
  // TASK
  if (compareProducts.matchCompareIntent(text)) {
    const acts = compareProducts.suggestedActions(text);
    const jobs = acts.map((a, i) => ({
      id: 'retail_' + i,
      label: 'Retail source ' + (i + 1),
      kind: 'http_extract',
      params: { url: a.url },
      depends_on: [],
      fallbacks: ['chromium_navigate', 'mark_blocked']
    }));
    jobs.push({
      id: 'synthesize',
      label: 'Compare prices',
      kind: 'synthesize',
      params: {},
      depends_on: jobs.filter((j) => j.kind !== 'synthesize').map((j) => j.id),
      fallbacks: []
    });
    return { intent: 'TASK', playbook: 'compare_products', jobs };
  }
  if (newsDigest.matchNewsIntent && newsDigest.matchNewsIntent(text)) {
    const sources = (newsDigest.DEFAULT_VN_SOURCES || []).slice(0, 5);
    const jobs = sources.map((s, i) => ({
      id: 'feed_' + i,
      label: s.name || s.url || ('Source ' + i),
      kind: 'fetch_feed',
      params: { url: s.feed || s.url },
      depends_on: [],
      fallbacks: ['http_extract', 'mark_blocked']
    }));
    jobs.push({
      id: 'synthesize',
      label: 'Digest',
      kind: 'synthesize',
      params: {},
      depends_on: jobs.filter((j) => j.id !== 'synthesize').map((j) => j.id),
      fallbacks: []
    });
    return { intent: 'TASK', playbook: 'news_digest', jobs };
  }
  // Generic research: search then synthesize
  return {
    intent: 'TASK',
    playbook: 'generic',
    jobs: [
      { id: 'search', label: 'Search', kind: 'search', params: { query: text.slice(0, 200) }, depends_on: [], fallbacks: ['mark_blocked'] },
      { id: 'synthesize', label: 'Report', kind: 'synthesize', params: {}, depends_on: ['search'], fallbacks: [] }
    ]
  };
}

function applyPlan(state, plan) {
  state.plan = { jobs: plan.jobs || [], intent: plan.intent, playbook: plan.playbook || null };
  state.jobStates = {};
  for (const j of state.plan.jobs) {
    state.jobStates[j.id] = { status: 'pending', result: null, error: null, ms: 0, fallbackUsed: null };
  }
  state.updatedAt = Date.now();
  return state;
}

module.exports = { createTaskState, planFromRules, applyPlan };
