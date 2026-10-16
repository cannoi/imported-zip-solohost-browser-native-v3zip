const { classifyIntent } = require('./agent-intent');
'use strict';
/** Lightweight deterministic task understanding. Keeps the original brief intact. */
function analyzeTask(brief, lang) {
  const text = String(brief || '');
  const low = text.toLowerCase();
  const section = (name) => {
    const aliases = { goal: 'goal', steps: 'steps?|instructions?', instructions: 'instructions?|steps?', output: 'required\\s+output\\s+format|output\\s+format', guardrails: 'guardrails?|constraints' };
    const pattern = aliases[name] || name;
    const re = new RegExp('(?:^|\\n)\\s*(?:#+\\s*)?(?:' + pattern + ')\\s*:?\\s*([\\s\\S]*?)(?=\\n\\s*(?:#+\\s*)?(?:role|goal|steps?|instructions?|guardrails?|output\\s+format|required\\s+output\\s+format|sources?|constraints?)\\s*:|$)', 'i');
    const m = text.match(re); return m ? String(m[m.length - 1] || '').trim() : '';
  };
  const intent = classifyIntent(text);
  let kind = /tin t[uứ]c|news digest|24 hours|24h|24 giờ|breaking news/i.test(low) ? 'news' :
    /compare|so sánh|versus|vs\.|giá|price|nơi bán|where to buy/i.test(low) ? 'compare' :
    /study|learn|học tập|giải thích|flashcard/i.test(low) ? 'study' :
    /audit|repository|repo|mã nguồn|source code|technical/i.test(low) ? 'work_doc' :
    /research|nghiên cứu|deep dive/i.test(low) ? 'research' :
    /summari[sz]e|tóm tắt|đọc nhanh/i.test(low) ? 'lookup' :
    intent.kind === 'TASK' ? 'research' : 'other';
  const sources = [...new Set((text.match(/https?:\/\/[^\s)\]>]+/gi) || []).map(u => u.replace(/[.,;]+$/, '')))];
  const output = section('output') || '';
  const guardrails = section('guardrails|constraints') || '';
  const stepText = section('steps');
  const steps = stepText ? stepText.split(/\n|(?=\d+[.)]\s)/).map(s => s.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim()).filter(Boolean).slice(0, 20) : [];
  const needs_clarification = [];
  if (kind === 'work_doc' && !sources.length && !/\b(repo|repository|url|zip|file|attached|tệp|đính kèm)\b/i.test(text)) needs_clarification.push('Bạn muốn audit dự án/repository nào? Dán URL repo, tải ZIP, hoặc chọn phân tích khung tổng quát.');
  return { kind, goal: section('goal') || text.slice(0, 700), steps, sources, time_window: /24\s*(?:h|hours?|giờ)/i.test(text) ? '24h' : '', language: /\b(vietnamese|tiếng việt|vietnamese language)\b/i.test(text) || lang === 'vi' ? 'vi' : 'en', guardrails: guardrails ? [guardrails] : [], output_format: output || '', needs_clarification, risk: /buy|delete|payment|transfer|password|otp|mật khẩu|thanh toán/i.test(low) ? 'elevated' : 'low' };
}
function buildChecklist(spec) {
  const output = String(spec.output_format || '');
  return { sources: (spec.sources || []).slice(), time_window: spec.time_window || '', min_items: spec.kind === 'news' ? 8 : 1, citation_required: ['news','research','compare','lookup','work_doc'].includes(spec.kind), output_sections: output.split(/\n/).map(x => x.trim()).filter(x => /^#{1,4}\s|^[0-9]+[.)]\s|^-\s/.test(x)).slice(0, 30), completed: [] };
}
module.exports = { analyzeTask, buildChecklist };
