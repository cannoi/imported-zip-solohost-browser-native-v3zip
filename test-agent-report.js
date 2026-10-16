'use strict';
const assert = require('assert');
const { buildAgentReport, finalizeDoneMessage, extractUrls } = require('./lib/agent-report');
const evidence = require('./lib/agent-evidence');
const taskId = 'report-test-' + Date.now();
evidence.addEvidence(taskId, { kind: 'page', url: 'https://docs.example.com/guide', title: 'Guide', snippet: 'Grounded documentation text', text: 'Grounded documentation text' });

const task = {
  id: taskId,
  lang: 'vi',
  task: 'Collect example sources',
  message: 'Done.',
  history: [
    { step: 1, thought: 'search', action: { type: 'search', query: 'test' }, url: 'https://example.com/a' },
    { step: 2, thought: 'read', action: { type: 'extract_page' }, url: 'https://example.com/b' }
  ],
  workMemory: {
    findings: ['Fact one https://docs.example.com/guide', { fact: 'Image src', url: 'https://cdn.example.com/x.png' }],
    visited: ['https://example.com/a', 'https://example.com/b'],
    notes: ['Note']
  }
};
const short = finalizeDoneMessage(task, 'Done.');
assert.ok(short.message.length > 80, 'expanded from Done');
assert.ok(short.message.includes('https://'), 'has links');
assert.ok(short.report.links.length >= 1);
const full = finalizeDoneMessage(task, '## Summary\nFull answer with https://ref.example/page and details...');
assert.ok(full.message.includes('Full answer'));
assert.ok(extractUrls('see https://a.com/x and https://b.com/y.png').length === 2);
evidence.clearTaskEvidence(taskId);
console.log('test-agent-report PASS');
