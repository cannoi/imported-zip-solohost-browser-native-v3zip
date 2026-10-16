'use strict';
const agentEvidence = require('./agent-evidence');
const agentLinks = require('./agent-links');
function clip(s,n){s=String(s||'');return s.length<=n?s:s.slice(0,n)+'…';}
function uniq(arr){const out=[],seen=new Set();for(const x of arr||[]){const k=String(x||'').trim();if(k&&!seen.has(k)){seen.add(k);out.push(k);}}return out;}
function extractUrls(text){return agentLinks.extractUrls(text);}
function isMediaUrl(u){return /\.(png|jpe?g|gif|webp|svg|mp4|webm|m3u8|mp3|ogg)(\?|$)/i.test(u)||/youtube\.com\/watch|youtu\.be\/|vimeo\.com\//i.test(u);}
function domain(url){try{return new URL(url).hostname.replace(/^www\./,'');}catch(_){return '';}}
function buildAgentReport(task){
  const lang=task.lang==='vi'?'vi':'en', vi=lang==='vi', wm=task.workMemory||{}, history=Array.isArray(task.history)?task.history:[];
  const summaryRaw=String(task.message||task.lastDoneSummary||(vi?'Nhiệm vụ đã hoàn thành.':'Task completed.')).trim();
  const ledger=agentEvidence.loadLedger(task.id).filter(e=>e&&e.url&&e.kind!=='serp'&&agentLinks.canonicalizeUrl(e.url)&&!['captcha','search_results','redirector','invalid'].includes(agentLinks.classifyUrl(e.url)));
  const findings=ledger.filter(e=>e.kind!=='serp').map(e=>({id:e.id,title:e.title||domain(e.url),url:agentLinks.canonicalizeUrl(e.url),snippet:String(e.snippet||'').trim(),publishedAt:e.publishedAt||null,kind:e.kind||'page',source:e.source||domain(e.url)}));
  const stepLines=history.map((h,i)=>{const a=h.action||{};let action=typeof a==='string'?a:(a.type||'');if(a.url)action+=' '+a.url;if(a.query)action+=' q='+a.query;return {n:h.step||h.n||i+1,action:action||h.text||'step',url:h.url||(a.url||''),ok:h.ok,thought:h.thought||h.text||''};}).filter(x=>x.action||x.url);
  // Sources are ledger-backed only. Free text/LLM-authored URLs never become report references.
  const refs=uniq(ledger.map(e=>agentLinks.canonicalizeUrl(e.url))).filter(u=>!['captcha','search_results','redirector','invalid'].includes(agentLinks.classifyUrl(u)));
  const media=refs.filter(isMediaUrl), sources=refs.filter(u=>!isMediaUrl(u));
  const errors=Array.isArray(task.errors)?task.errors:[];
  const sourceStatus=task.sourcesStatus||{};
  const lines=['# '+(vi?'Báo cáo Browser Agent':'Browser Agent report'),'','## '+(vi?'Tóm tắt kết quả':'Result summary'),summaryRaw,''];
  if(findings.length){lines.push('## '+(vi?'Phát hiện có bằng chứng':'Evidence-backed findings'));findings.slice(0,80).forEach((f,i)=>{const time=f.publishedAt?(' · '+f.publishedAt):(' · '+(vi?'thu thập':'collected')+' '+new Date().toISOString());lines.push(`${i+1}. ${clip(f.snippet||f.title,500)} — [${f.title||f.source} · ${f.source}]( ${f.url} ) [${f.id}]${time}`.replace(/\]\(\s+/g,'](').replace(/\s+\)/g,')'));});lines.push('');}
  if(stepLines.length){lines.push('## '+(vi?'Các bước đã thực hiện':'Steps taken'));stepLines.slice(-40).forEach(s=>lines.push(`${s.n}. ${s.action}${s.url?' — '+s.url:''}`));lines.push('');}
  if(sources.length){lines.push('## '+(vi?'Nguồn có trong sổ bằng chứng':'Evidence ledger sources'));sources.slice(0,60).forEach((u,i)=>{const e=ledger.find(x=>agentLinks.canonicalizeUrl(x.url)===u);lines.push(`${i+1}. [${(e&&e.title)||domain(u)} · ${domain(u)}](${u})${e&&e.publishedAt?' · '+e.publishedAt:''} · [${e&&e.id||'E?'}]`);});lines.push('');}
  if(media.length){lines.push('## '+(vi?'Ảnh / media':'Media'));media.slice(0,30).forEach((u,i)=>lines.push(`${i+1}. ${u}`));lines.push('');}
  lines.push('## '+(vi?'Phạm vi & hạn chế':'Scope & limitations'));
  lines.push(vi?`Số bằng chứng trong sổ: ${ledger.length}; trang đã đọc/ghi nhận: ${findings.length}. Kết quả tìm kiếm (SERP) chỉ là ứng viên, không được coi là bằng chứng nội dung.`:`Ledger evidence entries: ${ledger.length}; opened/read evidence pages: ${findings.length}. Search results (SERP) are candidates, not evidence for factual claims.`);
  const statusEntries=Object.entries(sourceStatus); if(statusEntries.length) statusEntries.forEach(([host,v])=>lines.push(`- ${host}: ${v.status||'unknown'}${v.reason?' — '+v.reason:''}`));
  if(errors.length){lines.push(vi?'Lỗi/hạn chế kỹ thuật:':'Technical errors/limitations:');errors.slice(-20).forEach(e=>lines.push(`- ${clip(e.message||e.reason||'Unknown error',240)}`));}
  if(!findings.length) lines.push(vi?'Chưa có bằng chứng từ trang đã mở; không nên xem các đoạn trích tìm kiếm là dữ kiện đã xác minh.':'No opened-page evidence was recorded; search snippets should not be treated as verified facts.');
  lines.push('',`## ${vi?'Thời điểm thu thập':'Collection time'}`,`${new Date().toISOString()} (UTC)`,'',vi?'Báo cáo chỉ liệt kê liên kết lấy từ sổ bằng chứng của nhiệm vụ này.':'Links are listed only when present in this task’s evidence ledger.');
  return {markdown:lines.join('\n'),summary:summaryRaw,findings:findings.slice(0,80),steps:stepLines.slice(-40),links:sources.slice(0,60),media:media.slice(0,30),visited:sources.slice(0,40),linkChecks:sources.map(url=>({url,status:'opened_in_task_ledger',checkedAt:(ledger.find(e=>agentLinks.canonicalizeUrl(e.url)===url)||{}).fetchedAt||null})),task:clip(task.task||'',2000),errors:errors.slice(-20),evidenceCount:ledger.length,generatedAt:new Date().toISOString()};
}
function groundSummary(task, raw) {
  let msg = String(raw || '').trim();
  const ledger = agentEvidence.loadLedger(task.id).filter(e => e && e.url && e.kind !== 'serp' && !['captcha','search_results','redirector','invalid'].includes(agentLinks.classifyUrl(e.url)));
  const byId = new Map(ledger.map(e => [String(e.id), e]));
  const allowed = new Set(ledger.map(e => agentLinks.canonicalizeUrl(e.url)));
  for (const url of agentLinks.extractUrls(msg)) {
    if (!allowed.has(agentLinks.canonicalizeUrl(url))) {
      const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      msg = msg.replace(new RegExp(escaped, 'g'), task.lang === 'vi' ? '[đã bỏ liên kết chưa có trong sổ bằng chứng]' : '[link omitted: not in task evidence ledger]');
    }
  }
  msg = msg.replace(/\[(E\d+)\]/g, (full, id) => {
    const e = byId.get(id); if (!e) return task.lang === 'vi' ? '[trích dẫn chưa xác minh]' : '[unverified citation]';
    const url = agentLinks.canonicalizeUrl(e.url);
    return `[${clip(e.title || e.source || domain(url), 100)} · ${domain(url)}](${url}) [${id}]`;
  });
  const validCitation = /\[[^\]]+\]\(https?:\/\/.+\)\s+\[E\d+\]/i;
  const lines = msg.split('\n').map(line => {
    const t = line.trim();
    if (!t || /^#{1,6}\s/.test(t) || /^[-*_]{3,}$/.test(t) || /^\|/.test(t) || /^⚠/.test(t)) return line;
    if (validCitation.test(t)) return line;
    if (/^[-*]\s+/.test(t) || /^\d+[.)]\s+/.test(t)) return line.replace(/^([-*]\s+|\d+[.)]\s+)/, m => m) + (task.lang === 'vi' ? ' ⚠ Chưa xác minh độc lập.' : ' ⚠ Not independently verified.');
    return line + (task.lang === 'vi' ? ' ⚠ Chưa xác minh độc lập.' : ' ⚠ Not independently verified.');
  });
  return lines.join('\n');
}
function finalizeDoneMessage(task,summary){let msg=String(summary||task.message||'').trim();const report=buildAgentReport(Object.assign({},task,{message:msg,lastDoneSummary:msg}));if(msg.length<80||/^(done\.?|xong\.?|hoàn thành\.?|completed\.?)$/i.test(msg))msg=report.markdown;else { msg = groundSummary(task, msg); if(report.evidenceCount && !/\[E\d+\]/.test(msg)){msg=msg+'\n\n---\n\n'+(task.lang==='vi'?'## Bằng chứng đã thu thập':'## Collected evidence')+'\n'+report.findings.slice(0,30).map((f,i)=>`${i+1}. ${clip(f.snippet||f.title,500)} — [${f.title||f.source}](${f.url}) [${f.id}]`).join('\n');} }if(msg.length>120000)msg=msg.slice(0,120000)+'\n…';return {message:msg,report};}
module.exports={buildAgentReport,finalizeDoneMessage,extractUrls,isMediaUrl,groundSummary};
