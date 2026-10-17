'use strict';
/** Browser Agent action handlers (extracted; behavior-preserving). */
const agentSearch = require('./agent-search');
const agentEvidence = require('./agent-evidence');
const agentWeb = require('./agent-web');
const appLog = require('./app-log');
const { clip } = require('./util');

function createExecuteAction(ctx) {
  return async function executeAction(task, session, action, obs) {
    const domBridge = ctx.domBridge;
    const assertSafeUrl = ctx.assertSafeUrl;
  const targets = (obs && obs.targets) || {};
  switch (action.type) {
    case 'navigate': {
      let url = String(action.url || '').trim();
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      await assertSafeUrl(url);
      const r = await domBridge.navigate(session, url);
      const ok = !!(r && !r.error && r.hasContent !== false && r.backend !== 'proxy-error');
      const domain = agentEvidence.domainOf((r && r.url) || url);
      task.sourcesStatus = task.sourcesStatus || {};
      if (domain) task.sourcesStatus[domain] = ok
        ? { status: 'ok', reason: 'navigation_succeeded', at: new Date().toISOString() }
        : { status: 'failed', reason: clip((r && r.error) || 'navigation_failed_or_empty_content', 180), at: new Date().toISOString() };
      if (ok && r && r.url) {
        task.urlStack = task.urlStack.slice(0, task.urlIndex + 1);
        task.urlStack.push(r.url);
        task.urlIndex = task.urlStack.length - 1;
        task.workMemory = task.workMemory || {};
        task.workMemory.visited = (task.workMemory.visited || []).concat([r.url]).slice(-30);
      }
      return { ok, result: ok ? (r.url || url) : ((r && r.error) || 'navigation_failed_or_empty_content'), state: r };
    }
    case 'search': {
      const query = String(action.query || '').trim();
      if (!query) throw new Error('search needs "query"');
      // Task-local dedupe: identical normalized query already ran → reuse, no engine hit
      try {
        const nq = agentSearch.normalizeQuery ? agentSearch.normalizeQuery(query) : query.toLowerCase().trim();
        task.searchMemory = task.searchMemory || {};
        const prev = task.searchMemory[nq];
        if (prev && prev.at && (Date.now() - prev.at) < 8 * 60 * 1000 && prev.payload) {
          appLog.log('info', 'agent.search.duplicate_skipped', { query: nq.slice(0, 120), ageMs: Date.now() - prev.at });
          return prev.payload;
        }
      } catch (_) {}

      let engine = String(action.engine || process.env.SOLOHOST_DEFAULT_SEARCH || 'bing').toLowerCase();
      if (!['youtube', 'bing', 'google', 'ddg', 'brave'].includes(engine)) engine = 'bing';
      let url;
      if (engine === 'youtube') url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query);
      else if (engine === 'bing') url = 'https://www.bing.com/search?q=' + encodeURIComponent(query);
      else if (engine === 'ddg') url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
      else if (engine === 'brave') url = 'https://search.brave.com/search?q=' + encodeURIComponent(query);
      else url = 'https://www.google.com/search?q=' + encodeURIComponent(query);
      if (engine !== 'youtube') {
        const preferred = engine === 'google' ? ['bing', 'ddg', 'brave'] : [engine, ...['bing','ddg','brave'].filter(x => x !== engine)];
        task.searchEngineBlockedMap = task.searchEngineBlockedMap || {};
        if (Array.isArray(task.searchEngineBlocked)) {
          for (const e of task.searchEngineBlocked) task.searchEngineBlockedMap[e] = Date.now() + 20 * 60 * 1000;
        }
        const found = await agentSearch.searchWeb(query, {
          engines: preferred, timeoutMs: 3200, limit: 10, blockedMap: task.searchEngineBlockedMap
        });
        task.searchEngineBlocked = Object.keys(task.searchEngineBlockedMap).filter((k) => task.searchEngineBlockedMap[k] > Date.now());
        const blockedEngines = Array.isArray(found.blockedEngines) ? found.blockedEngines : (found.blocked || []);
        appLog.log('info', found.cached ? 'agent.search.cache_hit' : 'agent.search.end', {
          query: query.slice(0, 120),
          outcome: found.outcome || (found.results && found.results.length ? 'ok' : 'empty'),
          engine: found.engine || null,
          durationMs: found.durationMs != null ? found.durationMs : found.ms,
          resultCount: (found.results || []).length,
          blockedEngines: blockedEngines.length ? blockedEngines : undefined,
          cached: !!found.cached
        });
        if (found.results && found.results.length) {
          task.workMemory = task.workMemory || { findings: [], visited: [], notes: [], todo: [] };
          const candidateChecks = await agentLinks.verifyLinks(found.results.slice(0, 4).map(x => x.url), { cache: task.linkVerifyCache || (task.linkVerifyCache = new Map()), timeoutMs: 3500, concurrency: 4 });
          const checkedByUrl = new Map(candidateChecks.map(x => [x.url, x]));
          task.workMemory.searchCandidates = found.results.map(x => Object.assign({}, x, { linkCheck: checkedByUrl.get(agentLinks.canonicalizeUrl(x.url)) || null }));
          task.searchEngineBlocked = [...new Set([...(task.searchEngineBlocked || []), ...(found.blocked || [])])];
          for (const item of task.workMemory.searchCandidates) agentEvidence.addEvidence(task.id, { kind: 'serp', url: item.url, title: item.title, snippet: (item.snippet || '') + (item.linkCheck ? ` [link check: ${item.linkCheck.ok ? 'ok' : item.linkCheck.reason || 'unverified'}]` : ''), text: item.snippet || '', source: item.site });
          const summary = task.workMemory.searchCandidates.map((x, i) => `${i + 1}. ${x.title} — ${x.url}${x.snippet ? ' — ' + x.snippet : ''}${x.linkCheck ? ' [link: ' + (x.linkCheck.ok ? 'reachable' : 'not verified') + ']' : ''}`).join('\n');
          try {
            const nq = agentSearch.normalizeQuery ? agentSearch.normalizeQuery(query) : query.toLowerCase().trim();
            task.searchMemory = task.searchMemory || {};
            task.searchMemory[nq] = { at: Date.now(), payload: null };
          } catch (_) {}
          task.lastToolResult = {
            action: 'search', query, outcome: 'ok', engine: found.engine,
            durationMs: found.durationMs != null ? found.durationMs : found.ms,
            resultCount: (found.results || []).length
          };
          task.searchAttempts = (task.searchAttempts || []).concat([{
            engine: found.engine, outcome: 'ok', query, durationMs: task.lastToolResult.durationMs, at: Date.now()
          }]).slice(-20);
          const __searchPayload = { ok: true, result: `Structured search via ${found.engine}; ${found.results.length} candidates. Search snippets are candidates only; open pages before making factual claims.\n${summary}`, state: { url, title: `Search: ${query}`, text: summary, searchResults: found.results, engine: found.engine, blocked: found.blocked || [], blockedEngines: found.blocked || [] } };
          try { const nq = agentSearch.normalizeQuery ? agentSearch.normalizeQuery(query) : query.toLowerCase().trim(); if (task.searchMemory && task.searchMemory[nq]) task.searchMemory[nq].payload = __searchPayload; } catch (_) {}
          return __searchPayload;
        }
        task.errors = task.errors || [];
        task.errors.push({
          at: new Date().toISOString(),
          step: task.history.length + 1,
          message: 'Structured search ' + (found.outcome || 'empty') + ': ' + (found.error || 'no results'),
          enginesBlocked: found.blocked || []
        });
        if (found.outcome === 'blocked' || found.outcome === 'empty') {
          // Query variants once before giving up
          const variants = [];
          const base = query.replace(/\s+/g, ' ').trim();
          if (base) {
            variants.push(base + ' chotot');
            variants.push(base + ' mua bán');
            variants.push(base.replace(/quảng trị/ig, 'Quang Tri').replace(/giá bán nơi bán/ig, 'gia'));
            // strip diacritics soft
            try {
              const nodia = base.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
              if (nodia !== base) variants.push(nodia);
            } catch (_) {}
          }
          for (const v of variants) {
            const nq = agentSearch.normalizeQuery ? agentSearch.normalizeQuery(v) : v.toLowerCase();
            if (task.searchMemory && task.searchMemory[nq]) continue;
            const found2 = await agentSearch.searchWeb(v, {
              engines: preferred, timeoutMs: 3200, limit: 10, blockedMap: task.searchEngineBlockedMap
            });
            task.searchAttempts = (task.searchAttempts || []).concat([{
              engine: found2.engine, outcome: found2.outcome, reason: found2.error || null, query: v,
              durationMs: found2.durationMs || found2.ms, at: Date.now()
            }]).slice(-20);
            try {
              task.searchMemory = task.searchMemory || {};
              task.searchMemory[nq] = { at: Date.now(), outcome: found2.outcome, payload: null };
            } catch (_) {}
            if (found2.results && found2.results.length) {
              found = found2;
              // fall through by reusing success path — rebuild candidates briefly
              task.workMemory = task.workMemory || { findings: [], visited: [], notes: [], todo: [] };
              task.workMemory.searchCandidates = found2.results.map((x, i) => Object.assign({}, x, { rank: i + 1 }));
              task.lastToolResult = {
                action: 'search', query: v, outcome: 'ok', engine: found2.engine,
                durationMs: found2.durationMs || found2.ms, resultCount: found2.results.length
              };
              const summary = task.workMemory.searchCandidates.map((x, i) => (i + 1) + '. ' + x.title + ' — ' + x.url).join('\n');
              const payload = { ok: true, result: 'Structured search (variant) via ' + found2.engine + '; ' + found2.results.length + ' candidates.\n' + summary, state: { searchResults: found2.results, engine: found2.engine } };
              try { task.searchMemory[nq].payload = payload; } catch (_) {}
              return payload;
            }
          }
          const failPayload = {
            ok: false,
            outcome: found.outcome,
            result: found.outcome === 'blocked'
              ? 'search_blocked: engines challenged. Tried variants. Open a source URL or ask_user — do NOT conclude unavailable.'
              : 'search_empty: no results after variants. Try different keywords or direct classifieds URLs.',
            state: { blocked: found.blocked || [], outcome: found.outcome, attempts: (task.searchAttempts || []).slice(-8) }
          };
          try {
            const nq = agentSearch.normalizeQuery ? agentSearch.normalizeQuery(query) : query.toLowerCase();
            task.searchMemory = task.searchMemory || {};
            task.searchMemory[nq] = { at: Date.now(), outcome: found.outcome, payload: failPayload };
          } catch (_) {}
          task.lastToolResult = {
            action: 'search', query, outcome: found.outcome, reason: found.error || found.outcome,
            engine: found.engine, resultCount: 0
          };
          return failPayload;
        }
      }
      await assertSafeUrl(url);
      const r = await domBridge.navigate(session, url);
      if (r && r.url && /google\.com\/sorry|captcha|verify/i.test(r.url)) {
        task.errors = task.errors || []; task.errors.push({ at: new Date().toISOString(), message: 'Search engine blocked/verification page; switched to structured fallback where possible.' });
        return { ok: false, result: 'search_engine_blocked; do not retry this engine, use another public search engine or direct official source', state: r };
      }
      return { ok: !r.error && r.hasContent !== false, result: engine + ': ' + query, state: r };
    }
    case 'click': {
      const id = Number(action.id);
      const targetId = targets[id];
      if (!targetId) return { ok: false, result: 'unknown_element_id' };
      const el = (obs.elements || []).find((e) => e.id === id);
      if (el && el.href && /\/(login|signin|oauth)/i.test(el.href) && !isLiveEngine(session)) {
        return { ok: false, result: 'login_requires_engine' };
      }
      const out = await domBridge.dispatchEvent(session, { type: 'click', targetId });
      return { ok: !!out.ok, result: out.result || 'clicked ' + id, state: out };
    }
    case 'type': {
      const id = Number(action.id);
      const targetId = targets[id];
      if (!targetId) return { ok: false, result: 'unknown_element_id' };
      const el = (obs.elements || []).find((e) => e.id === id);
      if (el && SECRET.test([el.type, el.label].join(' '))) return { ok: false, result: 'blocked_secret_field_use_ask_user' };
      const value = String(action.text != null ? action.text : action.value != null ? action.value : '');
      const out = await domBridge.dispatchEvent(session, { type: 'input', targetId, value });
      if (action.submit || action.press_enter) {
        await waitStable(session);
        const sub = await domBridge.dispatchEvent(session, { type: 'submit', targetId });
        return { ok: !!out.ok, result: 'typed+submit', state: sub };
      }
      return { ok: !!out.ok, result: 'typed', state: out };
    }
    case 'press_key':
    case 'press': {
      const id = Number(action.id);
      const targetId = id ? targets[id] : '';
      const key = String(action.key || 'Enter');
      if (isLiveEngine(session)) {
        const pw = require('./engine/playwright-engine');
        const out = await pw.dispatchEvent(session.pwSessionId, { type: 'press_key', targetId, key });
        return { ok: true, result: 'pressed ' + key, state: out };
      }
      if (targetId && (key === 'Enter' || key === 'Return')) {
        const out = await domBridge.dispatchEvent(session, { type: 'submit', targetId });
        return { ok: !!out.ok, result: 'enter', state: out };
      }
      return { ok: false, result: 'press_key_requires_engine' };
    }
    case 'select': {
      const id = Number(action.id);
      const targetId = targets[id];
      if (!targetId) return { ok: false, result: 'unknown_element_id' };
      const out = await domBridge.dispatchEvent(session, {
        type: 'input',
        targetId,
        value: action.value != null ? String(action.value) : '',
        selectedIndex: action.selectedIndex
      });
      return { ok: !!out.ok, result: 'selected', state: out };
    }
    case 'extract_page': {
      try {
        const pw = require('./engine/playwright-engine');
        const data = await agentTools.extractFromPlaywrightSession(pw, session.pwSessionId);
        if (data && !data.error) {
          const summary = [
            'title: ' + (data.title || ''),
            'headings: ' + (data.headings || []).slice(0, 12).join(' · '),
            'links: ' + (data.links || []).slice(0, 16).map((l) => l.text + ' → ' + l.href).join(' | '),
            'docs: ' + (data.docs || []).map((d) => d.kind + ' ' + d.href).join(' | '),
            'tables: ' + (data.tables || []).slice(0, 3).join('\n---\n'),
            'text: ' + (data.text || '').slice(0, 8000)
          ].join('\n');
          task.workMemory = task.workMemory || { findings: [], sources_status: {} };
          const ev = agentEvidence.addEvidence(task.id, {
            url: data.url || session.url,
            title: data.title || '',
            text: data.text || summary,
            snippet: (data.headings || []).slice(0, 6).join(' · '),
            kind: 'page'
          });
          task.workMemory.findings = (task.workMemory.findings || []).concat([{
            fact: clip(summary, 2500),
            url: data.url || session.url,
            evidenceId: ev.id,
            step: task.history.length
          }]).slice(-30);
          task.workMemory.lastUrl = data.url || session.url;
          const domain = agentEvidence.domainOf(data.url || session.url);
          if (domain) {
            task.workMemory.sources_status = task.workMemory.sources_status || {};
            task.workMemory.sources_status[domain] = { status: 'ok', reason: 'extract_page' };
          }
          return { ok: true, result: '[' + ev.id + '] ' + clip(summary, 6000) };
        }
        return { ok: false, result: (data && data.error) || 'extract_failed' };
      } catch (e) {
        return { ok: false, result: clip(e.message || e, 200) };
      }
    }
    case 'fetch_doc': {
      try {
        const docUrl = String(action.url || '').trim();
        if (!/^https?:/i.test(docUrl)) return { ok: false, result: 'fetch_doc needs http(s) url' };
        await assertSafeUrl(docUrl);
        const undici = global.fetch || (async (url, opt) => {
          const http = require('http');
          const https = require('https');
          const lib = String(url).startsWith('https') ? https : http;
          return new Promise((resolve, reject) => {
            const req = lib.get(url, { headers: (opt && opt.headers) || {}, timeout: 15000 }, (res) => {
              // block redirect to private hosts: re-check location
              if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const next = res.headers.location;
                assertSafeUrl(next).then(() => {
                  res.resume();
                  reject(new Error('redirect_recheck_required:' + next));
                }).catch((err) => {
                  res.resume();
                  reject(err);
                });
                return;
              }
              const chunks = [];
              res.on('data', (c) => chunks.push(c));
              res.on('end', () => {
                const buf = Buffer.concat(chunks);
                resolve({
                  ok: res.statusCode >= 200 && res.statusCode < 400,
                  status: res.statusCode,
                  headers: { get: (k) => res.headers[String(k).toLowerCase()] },
                  arrayBuffer: async () => buf
                });
              });
            });
            req.on('error', reject);
          });
        });
        const result = await agentTools.fetchDocumentText(docUrl, undici);
        if (result.ok) {
          task.workMemory = task.workMemory || { findings: [] };
          task.workMemory.findings = (task.workMemory.findings || []).concat([{ fact: clip(result.text, 800), url: docUrl, step: task.history.length }]).slice(-20);
          return { ok: true, result: clip((result.kind || 'doc') + ': ' + (result.text || ''), 6000) };
        }
        return { ok: false, result: result.error || 'fetch_doc_failed' };
      } catch (e) {
        return { ok: false, result: clip(e.message || e, 200) };
      }
    }

    
    case 'fetch_feed': {
      try {
        let feedUrl = String(action.url || session.url || '').trim();
        if (!feedUrl) return { ok: false, result: 'fetch_feed needs url' };
        await assertSafeUrl(feedUrl);
        let items = [];
        try {
          const res = await researchTools.safeFetch(feedUrl);
          items = researchTools.parseFeed(res.body, res.url);
          if (!items.length && /html/i.test(res.contentType || '')) {
            const alts = researchTools.discoverFeedLinks(res.body, res.url);
            for (const alt of alts.slice(0, 3)) {
              try {
                const r2 = await researchTools.safeFetch(alt);
                items = researchTools.parseFeed(r2.body, r2.url);
                if (items.length) { feedUrl = r2.url; break; }
              } catch (_) {}
            }
          }
        } catch (e) {
          return { ok: false, result: clip(e.message || e, 200) };
        }
        task.workMemory = task.workMemory || { findings: [], sources_status: {} };
        const lines = [];
        for (const it of items.slice(0, 20)) {
          const ev = agentEvidence.addEvidence(task.id, {
            url: it.url, title: it.title, publishedAt: it.publishedAt,
            snippet: it.summary, text: it.summary, kind: 'feed'
          });
          task.workMemory.findings = (task.workMemory.findings || []).concat([{
            fact: it.title + (it.publishedAt ? ' (' + it.publishedAt + ')' : ''),
            url: it.url, evidenceId: ev.id
          }]).slice(-40);
          lines.push('[' + ev.id + '] ' + it.title + ' | ' + (it.publishedAt || '?') + ' | ' + it.url);
        }
        const domain = agentEvidence.domainOf(feedUrl);
        if (domain) task.workMemory.sources_status[domain] = { status: 'ok', reason: 'feed', count: items.length };
        return { ok: true, result: lines.length ? lines.join('\n') : 'no_feed_items' };
      } catch (e) {
        return { ok: false, result: clip(e.message || e, 200) };
      }
    }
    case 'extract_articles': {
      try {
        const html = session.html || '';
        const pageUrl = session.url || '';
        const list = researchTools.extractArticlesFromHtml(html, pageUrl);
        task.workMemory = task.workMemory || { findings: [] };
        const lines = [];
        for (const it of list.slice(0, 20)) {
          const ev = agentEvidence.addEvidence(task.id, {
            url: it.url, title: it.title, publishedAt: it.time, snippet: it.title, kind: 'article'
          });
          lines.push('[' + ev.id + '] ' + it.title + ' → ' + it.url);
        }
        return { ok: true, result: lines.join('\n') || 'no_articles_found' };
      } catch (e) {
        return { ok: false, result: clip(e.message || e, 200) };
      }
    }
    case 'read_article': {
      try {
        const u = String(action.url || '').trim();
        if (!u) return { ok: false, result: 'read_article needs url' };
        await assertSafeUrl(u);
        const res = await researchTools.safeFetch(u);
        const meta = researchTools.extractArticleMeta(res.body, res.url);
        const ev = agentEvidence.addEvidence(task.id, {
          url: res.url, title: meta.title, publishedAt: meta.publishedAt,
          text: meta.text, snippet: meta.text.slice(0, 400), kind: 'article'
        });
        task.workMemory = task.workMemory || { findings: [], sources_status: {} };
        task.workMemory.findings = (task.workMemory.findings || []).concat([{
          fact: meta.title + (meta.publishedAt ? ' @' + meta.publishedAt : ''),
          url: res.url, evidenceId: ev.id
        }]).slice(-40);
        const domain = agentEvidence.domainOf(res.url);
        if (domain) task.workMemory.sources_status[domain] = { status: 'ok', reason: 'read_article' };
        return {
          ok: true,
          result: '[' + ev.id + '] ' + meta.title + '\n' + (meta.publishedAt || '') + '\n' + researchTools.clip(meta.text, 4000)
        };
      } catch (e) {
        return { ok: false, result: clip(e.message || e, 200) };
      }
    }
    case 'open_many': {
      const urls = Array.isArray(action.urls) ? action.urls.slice(0, 8) : [];
      const lines = [];
      const runOne = async (u) => {
        try {
          await assertSafeUrl(u);
          const res = await researchTools.safeFetch(u);
          const meta = researchTools.extractArticleMeta(res.body, res.url);
          const ev = agentEvidence.addEvidence(task.id, {
            url: res.url, title: meta.title, publishedAt: meta.publishedAt,
            text: meta.text, snippet: meta.text.slice(0, 400), kind: 'article'
          });
          lines.push('[' + ev.id + '] ' + meta.title + ' | ' + (meta.publishedAt || '?') + ' | ' + res.url);
        } catch (e) {
          lines.push('FAIL ' + u + ' ' + String(e.message || e).slice(0, 80));
        }
      };
      // sequential with small batches of 3
      for (let i = 0; i < urls.length; i += 3) {
        await Promise.all(urls.slice(i, i + 3).map(runOne));
      }
      return { ok: lines.some((l) => l.startsWith('[E')), result: lines.join('\n') };
    }
    case 'recall': {
      const hits = agentEvidence.recall(task.id, { query: action.query, id: action.id, url: action.url });
      if (!hits.length) return { ok: true, result: 'no_evidence_match' };
      return {
        ok: true,
        result: hits.map((h) => '[' + h.id + '] ' + h.title + ' | ' + (h.publishedAt || '?') + '\n' + h.snippet + '\n' + h.url).join('\n\n')
      };
    }

    case 'scroll': {
      const current = Number((obs.scroll && obs.scroll.y) || session.scrollY) || 0;
      const delta = 600;
      const y =
        action.direction === 'top'
          ? 0
          : action.direction === 'bottom'
            ? 100000
            : Math.max(0, current + (action.direction === 'up' ? -delta : delta));
      const out = await domBridge.dispatchEvent(session, { type: 'scroll', scrollY: y, scrollX: Number(session.scrollX) || 0 });
      session.scrollY = Number(out.result && out.result.scrollY != null ? out.result.scrollY : y);
      return { ok: !!out.ok, result: 'scrolled ' + action.direction, state: out };
    }
    case 'wait':
      await sleep(Math.min(5000, Math.max(200, action.ms || 1000)));
      return { ok: true, result: 'waited' };
    case 'read':
      task.readOffset = Math.max(0, Number(action.offset) || 0);
      return { ok: true, result: 'read page text at offset ' + task.readOffset };
    case 'note': {
      task.workMemory = task.workMemory || { notes: [] };
      task.workMemory.notes = (task.workMemory.notes || []).concat([String(action.text || action.note || '')]).slice(-20);
      return { ok: true, result: 'noted' };
    }
    case 'back':
    case 'forward': {
      const next = task.urlIndex + (action.type === 'back' ? -1 : 1);
      if (next < 0 || next >= task.urlStack.length) return { ok: false, result: 'no_' + action.type + '_history' };
      task.urlIndex = next;
      const target = task.urlStack[task.urlIndex];
      await assertSafeUrl(target);
      const r = await domBridge.navigate(session, target);
      return { ok: !r.error && r.hasContent !== false, result: action.type + ' to ' + target, state: r };
    }
    default:
      return { ok: false, result: 'unsupported_action' };
  }
  };
}

module.exports = { createExecuteAction };
