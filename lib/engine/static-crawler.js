'use strict';

/**
 * Static Capture for SoloHost Browser.
 *
 * Reuses the bundled Playwright Chromium, but runs as a bounded background job
 * independent of the interactive browser tabs. Output is a safe, responsive,
 * JavaScript-free reading site (not a byte-for-byte offline mirror).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const playwrightEngine = require('./playwright-engine');
const contentPipeline = require('./content-pipeline');

const DATA_DIR = path.resolve(process.env.SOLOHOST_DATA_DIR || '/app/data');
const ROOT = path.join(DATA_DIR, 'static-captures');
const JOBS = new Map();
const MAX_JOBS = Math.max(1, Math.min(4, Number(process.env.SOLOHOST_CAPTURE_MAX_JOBS) || 1));
const DEFAULT_MAX_PAGES = Math.max(1, Math.min(30, Number(process.env.SOLOHOST_CAPTURE_MAX_PAGES) || 12));
const PAGE_TIMEOUT = Math.max(5000, Math.min(60000, Number(process.env.SOLOHOST_CAPTURE_PAGE_TIMEOUT) || 25000));
let activeJobs = 0;
const pendingJobs = [];

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function canonical(raw) {
  const u = new URL(raw);
  u.hash = '';
  u.username = '';
  u.password = '';
  // Drop common analytics parameters to avoid duplicate pages.
  for (const k of [...u.searchParams.keys()]) {
    if (/^(utm_.+|fbclid|gclid|mc_cid|mc_eid)$/i.test(k)) u.searchParams.delete(k);
  }
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.href;
}
function validateOptions(input = {}) {
  const raw = String(input.url || '').trim();
  if (!raw || raw.length > 2048) throw new Error('A valid starting URL is required.');
  let u;
  try { u = new URL(raw); } catch (_) { throw new Error('URL is invalid. Include https:// or http://.'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) {
    throw new Error('Only public HTTP(S) URLs without embedded credentials are supported.');
  }
  const scope = ['single', 'domain', 'sitemap'].includes(input.scope) ? input.scope : 'single';
  const maxPages = Math.max(1, Math.min(30, Math.floor(Number(input.maxPages) || DEFAULT_MAX_PAGES)));
  const profileId = String(input.profileId || '').toLowerCase();
  const clientKey = /^[a-f0-9]{32}$/.test(profileId) ? ('profile:' + profileId) :
    (/^[a-zA-Z0-9:_-]{1,128}$/.test(String(input.clientKey || '')) ? String(input.clientKey) : 'solohost-default-profile');
  return { url: canonical(u.href), scope, maxPages, clientKey };
}
function pageFilename(url, used) {
  const u = new URL(url);
  let base = (u.hostname + u.pathname).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 100);
  if (!base || base === 'index') base = 'page';
  if (u.search) base += '-' + crypto.createHash('sha1').update(u.search).digest('hex').slice(0, 8);
  let name = base + '.html';
  if (name === 'index.html') name = 'page-index.html';
  let i = 2;
  while (used.has(name)) name = base + '-' + i++ + '.html';
  used.add(name);
  return name;
}
function safeContent(html) {
  const sanitizeHtml = require('sanitize-html');
  return sanitizeHtml(String(html || ''), {
    allowedTags: [
      'a','address','article','aside','blockquote','br','caption','code','dd','del','details','div','dl','dt','em','figcaption','figure',
      'h1','h2','h3','h4','h5','h6','hr','i','img','li','main','mark','ol','p','pre','q','s','section','small','span','strong',
      'sub','summary','sup','table','tbody','td','th','thead','tr','u','ul','video','source'
    ],
    allowedAttributes: {
      '*': ['class','lang','dir','title'],
      'a': ['href','title'],
      'img': ['src','alt','title','width','height','loading'],
      'video': ['src','controls','poster','width','height'],
      'source': ['src','type'],
      'td': ['colspan','rowspan'], 'th': ['colspan','rowspan','scope']
    },
    allowedSchemes: ['http','https','mailto'],
    allowedSchemesByTag: { img: ['http','https','data'], source: ['http','https'], video: ['http','https'] },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    transformTags: {
      'a': (tag, attrs) => {
        const href = String(attrs.href || '');
        if (/^\s*(?:javascript|data|vbscript):/i.test(href)) return { tagName: 'span', attribs: {} };
        return { tagName: 'a', attribs: { href, rel: 'noopener noreferrer' } };
      }
    }
  });
}
function extractRecord(html, url, fallbackTitle) {
  const parsed = contentPipeline.extractReadable(html, url, fallbackTitle);
  return { title: parsed.title, byline: parsed.byline, excerpt: parsed.excerpt, content: safeContent(parsed.content), textContent: parsed.textContent, length: parsed.length };
}
function shell(record, url, filename, urlToFile) {
  const linksRewritten = String(record.content || '').replace(
    /href=(["'])(https?:\/\/[^"'<>]+)\1/gi,
    (whole, quote, href) => {
      let target = href;
      try {
        const c = canonical(href);
        if (urlToFile.has(c)) target = urlToFile.get(c);
      } catch (_) {}
      return 'href=' + quote + esc(target) + quote;
    }
  );
  const source = esc(url);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data:; media-src https: http:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${esc(record.title)}</title><style>
:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;font:17px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;background:#101216;color:#e9e9ec}header{padding:12px max(18px,calc((100vw - 920px)/2));border-bottom:1px solid #343741;background:#171a20;font-size:13px;overflow-wrap:anywhere}header a{color:#9ec5ff}main{max-width:860px;margin:0 auto;padding:26px 20px 80px}h1{font-size:clamp(1.65rem,4vw,2.5rem);line-height:1.2;overflow-wrap:anywhere}article{overflow-wrap:anywhere}article img,article video{max-width:100%;height:auto;border-radius:8px}article pre{white-space:pre-wrap;overflow:auto;background:#1d2028;padding:12px;border-radius:8px}article table{display:block;overflow-x:auto;border-collapse:collapse}article td,article th{border:1px solid #484c57;padding:6px 10px}article a{color:#9ec5ff}article blockquote{border-left:3px solid #697386;margin:1em 0;padding:.2em 1em;color:#c3c7d1}.meta{color:#a5a8b1;font-size:.9rem}.notice{margin-top:28px;color:#a5a8b1;font-size:.82rem;border-top:1px solid #343741;padding-top:12px}
@media(min-width:900px){main{padding-top:40px}}@media(max-width:600px){body{font-size:16px}main{padding:20px 14px 56px}}
</style></head><body><header>SoloHost Static Capture · <a href="index.html">Captured pages</a> · <a href="${source}" rel="noopener noreferrer">Open original</a></header><main><h1>${esc(record.title)}</h1>${record.byline ? `<p class="meta">${esc(record.byline)}</p>` : ''}${record.excerpt ? `<p class="meta">${esc(record.excerpt)}</p>` : ''}<article>${linksRewritten}</article><p class="notice">Static reading copy. Scripts, forms, logins, live feeds and protected media are not reproduced. Images/media may still load from their original public URLs.</p></main></body></html>`;
}
function writeZip(folder, target) {
  const archiver = require('archiver');
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(target);
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', () => resolve(archive.pointer()));
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(folder, false);
    archive.finalize().catch(reject);
  });
}
function publicJob(job) {
  return { id: job.id, status: job.status, progress: job.progress, startedAt: job.startedAt,
    finishedAt: job.finishedAt || null, options: job.options, pages: job.pages.length,
    errors: job.errors.slice(0, 20), error: job.error || null,
    downloadUrl: job.status === 'completed' ? `/api/browser/static-captures/${job.id}/site.zip` : null,
    previewUrl: job.status === 'completed' ? `/api/browser/static-captures/${job.id}/files/index.html` : null };
}
async function assertPublic(raw) {
  const { assertPublicHttpUrl, isPrivateIp } = require('../frame-proxy');
  const u = new URL(String(raw || ''));
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || host.endsWith('.lan') || host === 'metadata.google.internal') {
    throw new Error('Private/local targets are not allowed in Static Capture.');
  }
  // The shared browser proxy intentionally supports loopback apps; this public-web
  // crawler is stricter so a capture request cannot scan SoloHost/Docker services.
  if (require('net').isIP(host) && isPrivateIp(host)) throw new Error('Private/local targets are not allowed in Static Capture.');
  return assertPublicHttpUrl(raw);
}
async function sitemapSeeds(startUrl, page) {
  const out = [];
  const origin = new URL(startUrl).origin;
  for (const candidate of [origin + '/robots.txt', origin + '/sitemap.xml']) {
    try {
      await assertPublic(candidate);
      const response = await page.goto(candidate, { waitUntil: 'domcontentloaded', timeout: 8000 });
      if (!response || !response.ok()) continue;
      const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
      const html = await page.content().catch(() => '');
      const text = (bodyText + '\n' + html).slice(0, 2_000_000);
      if (/robots\.txt$/i.test(candidate)) {
        for (const m of text.matchAll(/^\s*Sitemap:\s*(\S+)/gim)) out.push(m[1]);
      } else if (/<(?:urlset|sitemapindex)\b/i.test(text)) {
        for (const m of text.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)) out.push(m[1].trim());
      }
    } catch (_) {}
  }
  return [...new Set(out)].slice(0, 100);
}
async function runJob(job) {
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  const folder = path.join(ROOT, job.id);
  let captureSession = null;
  try {
    fs.mkdirSync(folder, { recursive: true });
    await assertPublic(job.options.url);
    // Reuse SoloHost's default persistent Chromium profile: same cookies, localStorage,
    // IndexedDB and authenticated state as the Browser Bridge, but on a separate page.
    captureSession = await playwrightEngine.createCapturePage({ clientKey: job.options.clientKey || 'solohost-default-profile', timeout: PAGE_TIMEOUT });
    const page = captureSession.page;
    page.setDefaultNavigationTimeout(PAGE_TIMEOUT);
    page.setDefaultTimeout(10000);
    const safeHosts = new Map();
    await page.route('**/*', async route => {
      const reqUrl = route.request().url();
      if (/^(data|blob|about):/i.test(reqUrl)) return route.continue();
      try {
        const u = new URL(reqUrl);
        if (!['http:', 'https:'].includes(u.protocol)) return route.abort();
        const key = u.origin;
        if (!safeHosts.has(key)) safeHosts.set(key, assertPublic(reqUrl).then(() => true).catch(() => false));
        if (!await safeHosts.get(key)) return route.abort('blockedbyclient');
        return route.continue();
      } catch (_) { return route.abort(); }
    });

    const start = canonical(job.options.url);
    const originHost = new URL(start).hostname.toLowerCase();
    const queue = [];
    if (job.options.scope === 'sitemap') {
      const seeds = await sitemapSeeds(start, page);
      queue.push(...seeds.filter(x => { try { return new URL(x).hostname.toLowerCase() === originHost; } catch (_) { return false; } }));
    }
    queue.unshift(start);
    const queued = new Set();
    const seen = new Set();
    const records = [];
    while (queue.length && records.length < job.options.maxPages) {
      const nextRaw = queue.shift();
      let url;
      try { url = canonical(nextRaw); } catch (_) { continue; }
      if (seen.has(url)) continue;
      seen.add(url);
      let target;
      try {
        target = await assertPublic(url);
      } catch (e) {
        job.errors.push({ url, message: 'blocked_url_policy' });
        continue;
      }
      job.progress = { completed: records.length, total: Math.min(job.options.maxPages, seen.size + queue.length), currentUrl: url };
      try {
        const response = await page.goto(target.href || String(target), { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
        if (!response || response.status() >= 400) throw new Error('http_' + (response ? response.status() : 'no_response'));
        await page.waitForTimeout(450);
        const html = await page.content();
        const title = await page.title().catch(() => url);
        const live = await contentPipeline.inspectLivePage(page).catch(() => null);
        const links = live && Array.isArray(live.links) ? live.links.map(x => x.href) : await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(Boolean).slice(0, 5000));
        const record = extractRecord(html, page.url() || url, title);
        if (live) { record.pageType = live.pageType; record.siteName = live.siteName; record.description = live.description; record.lang = live.lang; }
        record.url = url;
        record.finalUrl = page.url() || url;
        records.push(record);
        if (job.options.scope !== 'single' && records.length + queue.length < job.options.maxPages) {
          for (const href of links) {
            try {
              const dest = new URL(href);
              if (!['http:', 'https:'].includes(dest.protocol) || dest.hostname.toLowerCase() !== originHost) continue;
              const normalized = canonical(dest.href);
              if (!seen.has(normalized) && !queued.has(normalized)) {
                queue.push(normalized);
                queued.add(normalized);
                if (queue.length + records.length >= job.options.maxPages * 3) break;
              }
            } catch (_) {}
          }
        }
      } catch (e) {
        job.errors.push({ url, message: String(e.message || e).slice(0, 180) });
      }
      job.progress = { completed: records.length, total: Math.min(job.options.maxPages, records.length + queue.length), currentUrl: url };
    }
    await captureSession.close().catch(() => {});
    captureSession = null;

    if (!records.length) throw new Error('No pages could be captured. Check the URL, network access, or site restrictions.');
    const used = new Set(['index.html']);
    const urlToFile = new Map();
    records.forEach(r => {
      r.filename = pageFilename(r.url, used);
      urlToFile.set(r.url, r.filename);
      try { urlToFile.set(canonical(r.finalUrl || r.url), r.filename); } catch (_) {}
    });
    for (const record of records) {
      fs.writeFileSync(path.join(folder, record.filename), shell(record, record.finalUrl || record.url, record.filename, urlToFile), 'utf8');
    }
    const index = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SoloHost Static Capture</title><style>body{font:16px/1.6 system-ui;max-width:900px;margin:32px auto;padding:0 16px;background:#101216;color:#eee}a{color:#9ec5ff}li{padding:8px 0;border-bottom:1px solid #333}</style></head><body><h1>Captured website</h1><p>${records.length} static reading pages captured from ${esc(start)}.</p><ol>${records.map(r => `<li><a href="${esc(r.filename)}">${esc(r.title)}</a><br><small>${esc(r.url)}</small></li>`).join('')}</ol><p>Scripts, forms and interactive logins were intentionally removed for safety.</p></body></html>`;
    fs.writeFileSync(path.join(folder, 'index.html'), index, 'utf8');
    fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({
      version: 1, id: job.id, createdAt: new Date().toISOString(), startUrl: start,
      options: job.options, scope: job.options.scope, pageCount: records.length, errors: job.errors.slice(0, 20),
      pages: records.map(({ url, finalUrl, title, filename, byline, excerpt }) => ({ url, finalUrl, title, filename, byline, excerpt }))
    }, null, 2), 'utf8');
    job.pages = records.map(({ url, title, filename }) => ({ url, title, filename }));
    job.progress = { completed: records.length, total: records.length, currentUrl: '' };
    job.status = 'packing';
    await writeZip(folder, path.join(ROOT, job.id + '.zip'));
    job.status = 'completed';
  } catch (e) {
    job.status = 'failed';
    job.error = String(e.message || e).slice(0, 300);
  } finally {
    if (captureSession) await captureSession.close().catch(() => {});
    job.finishedAt = new Date().toISOString();
    job.progress = job.progress || { completed: 0, total: 0, currentUrl: '' };
  }
}
function pump() {
  while (activeJobs < MAX_JOBS && pendingJobs.length) {
    const job = pendingJobs.shift();
    activeJobs += 1;
    runJob(job).finally(() => { activeJobs -= 1; pump(); });
  }
}
function start(input) {
  const options = validateOptions(input);
  const job = { id: crypto.randomBytes(12).toString('hex'), status: 'queued', progress: { completed: 0, total: 0, currentUrl: '' },
    options, startedAt: null, finishedAt: null, pages: [], errors: [], error: null };
  JOBS.set(job.id, job);
  while (JOBS.size > 40) {
    const oldest = JOBS.keys().next().value;
    const old = JOBS.get(oldest);
    if (old && ['queued','running','packing'].includes(old.status)) break;
    JOBS.delete(oldest);
  }
  pendingJobs.push(job);
  pump();
  return publicJob(job);
}
function get(id) {
  const key = String(id || '');
  const j = JOBS.get(key);
  if (j) return publicJob(j);
  const paths = getPaths(key);
  if (!paths || !fs.existsSync(paths.zip)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(paths.folder, 'manifest.json'), 'utf8'));
    return {
      id: key, status: 'completed', progress: { completed: Number(manifest.pageCount) || 0, total: Number(manifest.pageCount) || 0, currentUrl: '' },
      startedAt: manifest.createdAt || null, finishedAt: manifest.createdAt || null,
      options: manifest.options || { url: manifest.startUrl || '', scope: manifest.scope || 'single', maxPages: manifest.pageCount || 1 },
      pages: Number(manifest.pageCount) || (Array.isArray(manifest.pages) ? manifest.pages.length : 0),
      errors: Array.isArray(manifest.errors) ? manifest.errors.slice(0, 20) : [], error: null,
      downloadUrl: `/api/browser/static-captures/${key}/site.zip`,
      previewUrl: `/api/browser/static-captures/${key}/files/index.html`
    };
  } catch (_) { return null; }
}
function getPaths(id) {
  if (!/^[a-f0-9]{24}$/.test(String(id || ''))) return null;
  const folder = path.join(ROOT, id);
  const resolved = path.resolve(folder);
  if (!resolved.startsWith(path.resolve(ROOT) + path.sep)) return null;
  return { folder, zip: path.join(ROOT, id + '.zip') };
}
function list() {
  const result = new Map([...JOBS.values()].map(j => [j.id, publicJob(j)]));
  try {
    for (const id of fs.readdirSync(ROOT)) {
      if (result.size >= 20) break;
      if (!result.has(id)) {
        const saved = get(id);
        if (saved) result.set(id, saved);
      }
    }
  } catch (_) {}
  return [...result.values()].slice(-20).reverse();
}
module.exports = { start, get, list, getPaths, validateOptions, extractRecord, safeContent, canonical };
