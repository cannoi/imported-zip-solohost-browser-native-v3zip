(() => {
  const $ = id => document.getElementById(id);
  const els = {
    chrome:$('chrome'), form:$('search-form'), input:$('search-input'), suggest:$('suggest'),
    constellation:$('constellation'), sky:$('sky'), statusLine:$('status-line'), statusText:$('status-text'),
    viewHome:$('view-home'), viewBrowser:$('view-browser'), canvas:$('browser-canvas'), view:$('browser-view'),
    browserError:$('browser-error'), browserErrorTitle:$('browser-error-title'), browserErrorDesc:$('browser-error-desc'),
    browserErrorRetry:$('browser-error-retry'), tabs:$('tabs'), back:$('btn-back'), forward:$('btn-forward'),
    reload:$('btn-reload'), neu:$('btn-new'), glow:$('pointer-glow'), toast:$('toast'),
    findbar:$('findbar'), findInput:$('find-input'), findStatus:$('find-status'), findPrev:$('find-prev'), findNext:$('find-next'), findClose:$('find-close'),
    mediaPlay:$('media-play'), mediaMute:$('media-mute'), mediaVolume:$('media-volume'), mediaCaptions:$('media-captions'), mediaFullscreen:$('media-fullscreen'),
    aiBtn:null, aiDock:null, aiLog:null, aiForm:null, aiInput:null, aiClose:null
  };
  const ICONS={calculator:'∑',music:'♪',ai:'◎',node:'⬡',app:'◇',apps:'·'};
  const state={apps:[],bookmarks:[],history:[],tabs:[{id:'home',title:'Home',url:'',kind:'home'}],active:'home',ws:null,pending:null,frame:null,online:true,restored:false};
  const lang=(navigator.language||'en').toLowerCase().startsWith('vi')?'vi':'en';
  const T={en:{search:'Search the Web',newTab:'New Tab',assist:'Assist',back:'Back',forward:'Forward',reload:'Reload',find:'Find on page',close:'Close',ask:'Ask',online:'Online',offline:'Offline',unavailable:'Page unavailable',unavailableDesc:'This address could not be opened.',retry:'Retry',home:'Home',playPause:'Play / Pause',mute:'Mute / Unmute',volume:'Volume',captions:'Subtitles',videoFullscreen:'Video fullscreen'},vi:{search:'Tìm kiếm trên web',newTab:'Tab mới',assist:'Trợ lý',back:'Quay lại',forward:'Tiến tới',reload:'Tải lại',find:'Tìm trên trang',close:'Đóng',ask:'Hỏi',online:'Trực tuyến',offline:'Ngoại tuyến',unavailable:'Không thể mở trang',unavailableDesc:'Địa chỉ này không thể được mở.',retry:'Thử lại',home:'Trang chủ',playPause:'Phát / Tạm dừng',mute:'Tắt / Bật tiếng',volume:'Âm lượng',captions:'Phụ đề',videoFullscreen:'Toàn màn hình video'}}[lang];
  document.documentElement.lang=lang;
  function applyLanguage(){
    els.input.placeholder=T.search; els.findInput.placeholder=T.find; if(els.aiInput)els.aiInput.placeholder=T.ask;
    els.browserErrorRetry.textContent=T.retry; els.browserErrorTitle.textContent=T.unavailable; els.browserErrorDesc.textContent=T.unavailableDesc;
    els.back.title=T.back; els.back.setAttribute('aria-label',T.back); els.forward.title=T.forward; els.forward.setAttribute('aria-label',T.forward); els.reload.title=T.reload; els.reload.setAttribute('aria-label',T.reload);
    els.mediaPlay.title=T.playPause; els.mediaPlay.setAttribute('aria-label',T.playPause); els.mediaMute.title=T.mute; els.mediaMute.setAttribute('aria-label',T.mute); els.mediaVolume.title=T.volume; els.mediaVolume.setAttribute('aria-label',T.volume); els.mediaCaptions.title=T.captions; els.mediaCaptions.setAttribute('aria-label',T.captions); els.mediaFullscreen.title=T.videoFullscreen; els.mediaFullscreen.setAttribute('aria-label',T.videoFullscreen);
    els.neu.title=T.newTab; els.neu.setAttribute('aria-label',T.newTab);  els.findClose.title=T.close; els.findClose.setAttribute('aria-label',T.close);
  }
  const ctx=els.canvas ? els.canvas.getContext('2d',{alpha:false,desynchronized:true}) : null;
  if(els.canvas) els.canvas.tabIndex=0;
  function hideNovncChrome(win){
    try{
      const doc = win && win.document;
      if(!doc || !doc.head) return;
      if(doc.getElementById('solohost-novnc-hide')) return;
      const s=doc.createElement('style');
      s.id='solohost-novnc-hide';
      s.textContent='#noVNC_control_bar,#noVNC_control_bar_anchor,#noVNC_control_bar_handle,#noVNC_status,#noVNC_hint,#noVNC_hint_anchor,#noVNC_transition,#noVNC_connect_dlg,#noVNC_buttons,#noVNC_settings,#noVNC_clipboard,#noVNC_power,#noVNC_extras,.noVNC_panel,#noVNC_fallback_error,#noVNC_keyboard_button,#noVNC_toggle_color_mode_button{display:none!important;visibility:hidden!important;pointer-events:none!important}html,body,#noVNC_container,canvas{cursor:none!important}';
      doc.head.appendChild(s);
      if(win.UI && typeof win.UI.hideControlbar==='function') win.UI.hideControlbar();
    }catch(e){}
  }
  function showDisplay(){
    if(!els.view) return;
    if(!els.view.src || els.view.src.indexOf('/view/')===-1){
      // noVNC is display/input transport only; WebKit owns the real page.
      // Scale mode avoids tearing the VNC connection during shell resize.
      els.view.src='view/vnc.html?autoconnect=1&reconnect=1&resize=scale&quality=7&compression=2&show_dot=0&path=view/websockify';
    }
    els.view.onload=()=>hideNovncChrome(els.view.contentWindow);
    if(els.view.contentWindow) hideNovncChrome(els.view.contentWindow);
  }

  function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function toast(s){els.toast.textContent=s;els.toast.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>els.toast.classList.remove('show'),1800);}
  function icon(n){return `<span class="app-symbol">${esc(ICONS[String(n||'app').toLowerCase()]||ICONS.app)}</span>`;}
  function setStatus(ok){state.online=ok;els.statusLine.classList.toggle('online',ok);els.statusLine.classList.toggle('offline',!ok);els.statusText.textContent=ok?T.online:T.offline;}

  function renderApps(){
    els.constellation.innerHTML='';
    if(!state.apps.length){els.constellation.innerHTML='<div class="empty-space"><div class="empty-mark">·</div><h2>No apps yet</h2><p>Apps installed on SoloHost will appear here.</p></div>';return;}
    state.apps.forEach((app,i)=>{const b=document.createElement('button');b.className='app-node';b.type='button';b.style.left=`${20+((i*29)%65)}%`;b.style.top=`${24+((i*41)%55)}%`;b.innerHTML=`<span class="app-dot ${app.status||'offline'}"></span>${icon(app.icon||app.id)}<span class="app-label">${esc(app.name)}</span>`;b.onclick=()=>openUrl(app.route,app.name);els.constellation.appendChild(b);});
  }
  async function loadApps(){try{const r=await fetch('/api/apps');if(!r.ok)throw 0;const d=await r.json();state.apps=d.apps||[];setStatus(true);}catch{setStatus(false);}renderApps();}
  async function loadBookmarks(){try{state.bookmarks=(await (await fetch('/api/bookmarks')).json()).bookmarks||[];}catch{state.bookmarks=[];}}
  async function loadHistory(){try{state.history=(await (await fetch('/api/history')).json()).history||[];}catch{state.history=[];}}

  function renderTabs(){
    els.tabs.innerHTML='';state.tabs.forEach(t=>{const g=document.createElement('span');g.className='tab-group'+(t.id===state.active?' active':'');const b=document.createElement('button');b.className='tab'+(t.id===state.active?' active':'');b.textContent=t.title||'New Tab';b.onclick=()=>activate(t.id);g.appendChild(b);if(t.kind!=='home'){const x=document.createElement('button');x.className='tab-close';x.textContent='×';x.onclick=e=>{e.stopPropagation();closeTab(t.id)};g.appendChild(x);}els.tabs.appendChild(g);});
  }
  function showHome(){document.body.classList.remove('browsing');els.chrome.classList.remove('browsing');els.viewBrowser.hidden=true;els.viewHome.hidden=false;state.active='home';els.input.value='';els.input.placeholder='Search the Web';renderTabs();}
  function ensureWs(){
    if(state.ws&&state.ws.readyState===WebSocket.OPEN)return Promise.resolve(state.ws);
    return new Promise((resolve,reject)=>{const proto=location.protocol==='https:'?'wss':'ws';const ws=new WebSocket(`${proto}://${location.host}/ws`);ws.binaryType='arraybuffer';let done=false;const fail=()=>{if(!done){done=true;reject(new Error('Browser engine unavailable'));}};ws.onopen=()=>{state.ws=ws;done=true;resolve(ws);};ws.onerror=fail;ws.onclose=()=>{if(state.ws===ws)state.ws=null;};ws.onmessage=e=>{if(typeof e.data==='string')handleEvent(JSON.parse(e.data));else drawFrame(e.data);};});
  }
  function send(obj){if(state.ws&&state.ws.readyState===WebSocket.OPEN)state.ws.send(JSON.stringify(obj));}
  function syncBrowserState(s){if(!s||!Array.isArray(s.tabs))return;const web=s.tabs.filter(t=>t.id!=='home');web.forEach(t=>{let local=state.tabs.find(x=>x.id===t.id);if(!local){local={id:t.id,title:t.title||T.newTab,url:t.url||'',kind:'web'};state.tabs.push(local);}if(t.title)local.title=t.title.slice(0,42);if(t.url)local.url=t.url;});if(s.active&&state.tabs.some(t=>t.id===s.active)){state.active=s.active;}renderTabs();if(state.active!=='home'){const a=state.tabs.find(t=>t.id===state.active);if(a)els.input.value=a.url||'';}persistSession();}
  function persistSession(){try{localStorage.setItem('solohost.browser.session.v73',JSON.stringify({active:state.active,tabs:state.tabs.filter(t=>t.kind==='web').slice(0,12).map(t=>({id:t.id,title:t.title,url:t.url}))}));}catch{}}
  function restoreSession(){if(state.restored)return;state.restored=true;try{const saved=JSON.parse(localStorage.getItem('solohost.browser.session.v73')||'{}');const tabs=Array.isArray(saved)?saved:(saved&&Array.isArray(saved.tabs)?saved.tabs:[]);tabs.filter(t=>t&&t.url).slice(0,8).forEach(t=>{if(state.tabs.some(x=>x.id===t.id))return;state.tabs.push({id:t.id,title:t.title||T.newTab,url:t.url,kind:'web'});});if(!tabs.length)return;renderTabs();ensureWs().then(()=>{state.tabs.filter(t=>t.kind==='web').forEach(t=>send({type:'create',id:t.id,url:t.url}));const target=state.tabs.find(t=>t.id===saved.active)||state.tabs.find(t=>t.kind==='web');if(target){state.active=target.id;send({type:'activate',id:target.id});activate(target.id);}}).catch(()=>{});}catch{}}
  function handleEvent(m){
    if(m.type==='error'){
      if(els.view && els.view.src){ hideError(); return; }
      showError('Page unavailable', m.error || 'WebKit could not load this address.');
      return;
    }
    if(m.type==='gateway'){ if(m.ready) hideError(); return; }
    if(m.type==='browser-state'){syncBrowserState(m.state);return;}
    if(m.type==='tab'&&m.event==='state'){const t=state.tabs.find(x=>x.id===m.id);if(t){if(m.title)t.title=m.title.slice(0,42);if(m.url){t.url=m.url;state.pending=m.url;if(t.id===state.active)els.input.value=m.url;}renderTabs();}}
  }
  function drawFrame(buf){const d=new DataView(buf);if(d.byteLength<12)return;const w=d.getUint32(4),h=d.getUint32(8);const blob=new Blob([buf.slice(12)],{type:'image/jpeg'});createImageBitmap(blob).then(img=>{if(els.canvas.width!==w||els.canvas.height!==h){els.canvas.width=w;els.canvas.height=h;}ctx.drawImage(img,0,0,w,h);img.close();hideError();});}
  function showError(t,d){els.browserErrorTitle.textContent=t;els.browserErrorDesc.textContent=d;els.browserError.hidden=false;}
  function hideError(){els.browserError.hidden=true;}
  function viewportSize(){return {width:Math.max(320,els.viewBrowser.clientWidth),height:Math.max(300,els.viewBrowser.clientHeight-52)};}
  function sendResize(){if(state.active==='home')return;const s=viewportSize();send({type:'resize',id:state.active,width:s.width,height:s.height});}
  let resizeT=null;
  function debouncedResize(){clearTimeout(resizeT);resizeT=setTimeout(sendResize,400);}
  function activate(id){const t=state.tabs.find(x=>x.id===id);if(!t)return;state.active=id;renderTabs();if(t.kind==='home'){showHome();return;}document.body.classList.add('browsing');els.chrome.classList.add('browsing');els.viewHome.hidden=true;els.viewBrowser.hidden=false;els.input.value=t.url||'';els.input.placeholder='Search or enter website';showDisplay();ensureWs().then(()=>{send({type:'activate',id});sendResize();}).catch(()=>{ if(!(els.view&&els.view.src)) showError('Browser engine unavailable','The WebKit engine is not ready yet.'); });}
  function closeTab(id){const i=state.tabs.findIndex(t=>t.id===id);if(i<0)return;send({type:'close',id});const was=state.active===id;state.tabs.splice(i,1);persistSession();if(was)activate((state.tabs[i-1]||state.tabs[i]||state.tabs[0]).id);else renderTabs();}
  function normalize(raw){let u=String(raw||'').trim();if(!u)return '';if(u.startsWith('/'))return location.origin+u;if(/^[a-z][a-z0-9+.-]*:/i.test(u))return u;if(/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(u)||/^localhost(:\d+)?/.test(u)||/^(\d{1,3}\.){3}\d{1,3}/.test(u))return 'https://'+u;return 'https://www.google.com/search?q='+encodeURIComponent(u);}
  function openUrl(raw,title){const url=normalize(raw);if(!url)return;let t=state.tabs.find(x=>x.url===url&&x.kind==='web');if(!t){t={id:'tab-'+Date.now().toString(36)+Math.random().toString(36).slice(2,5),title:title||new URL(url).hostname.replace(/^www\./,''),url,kind:'web'};state.tabs.push(t);}state.active=t.id;renderTabs();activate(t.id);showDisplay();hideError();const go=()=>fetch('/api/browser/navigate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})}).catch(()=>{});ensureWs().then(()=>send({type:'create',id:t.id,url})).then(()=>{send({type:'activate',id:t.id});remember(url,title||t.title);go();}).catch(()=>{go();remember(url,title||t.title);});}
  function remember(url,title){persistSession();fetch('/api/history',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url,title:title||url})}).catch(()=>{});}

  function pointer(e,phase,button=''){const r=els.canvas.getBoundingClientRect();const sx=els.canvas.width/r.width,sy=els.canvas.height/r.height;send({type:'mouse',id:state.active,x:Math.round((e.clientX-r.left)*sx),y:Math.round((e.clientY-r.top)*sy),phase,button});}
  els.canvas.addEventListener('pointermove',e=>pointer(e,'move'));els.canvas.addEventListener('pointerdown',e=>{els.canvas.focus();pointer(e,'down',e.button===2?'right':e.button===1?'middle':'left');});els.canvas.addEventListener('pointerup',e=>pointer(e,'up',e.button===2?'right':e.button===1?'middle':'left'));els.canvas.addEventListener('contextmenu',e=>e.preventDefault());els.canvas.addEventListener('wheel',e=>{e.preventDefault();const r=els.canvas.getBoundingClientRect();send({type:'wheel',id:state.active,x:Math.round(e.clientX-r.left),y:Math.round(e.clientY-r.top),delta:Math.round(-e.deltaY)});},{passive:false});
  els.canvas.addEventListener('keydown',e=>{send({type:'key',id:state.active,phase:'down',code:e.code,key:e.key,ctrl:e.ctrlKey?'1':'0',alt:e.altKey?'1':'0',shift:e.shiftKey?'1':'0',meta:e.metaKey?'1':'0'});e.preventDefault();});
  els.canvas.addEventListener('keyup',e=>{send({type:'key',id:state.active,phase:'up',code:e.code,key:e.key,ctrl:e.ctrlKey?'1':'0',alt:e.altKey?'1':'0',shift:e.shiftKey?'1':'0',meta:e.metaKey?'1':'0'});e.preventDefault();});

  els.form.onsubmit=e=>{e.preventDefault();openUrl(els.input.value);};els.input.onfocus=()=>els.form.classList.add('is-focus');
  els.input.oninput=()=>{const q=els.input.value.toLowerCase();const hits=[...state.bookmarks,...state.history].filter(x=>(x.title+' '+x.url).toLowerCase().includes(q)).slice(0,6);els.suggest.hidden=!q||!hits.length;els.suggest.innerHTML=hits.map(x=>`<button class="chip" type="button">${esc(x.title||x.url)}</button>`).join('');[...els.suggest.querySelectorAll('button')].forEach((b,i)=>b.onclick=()=>openUrl(hits[i].url,hits[i].title));};
  document.addEventListener('click',e=>{if(!els.form.contains(e.target)&&!els.suggest.contains(e.target))els.suggest.hidden=true;});
  els.neu.onclick=()=>openUrl('about:blank','New Tab');
  els.back.onclick=()=>send({type:'back',id:state.active});els.forward.onclick=()=>send({type:'forward',id:state.active});els.reload.onclick=()=>send({type:'reload',id:state.active});
  els.browserErrorRetry.onclick=()=>{hideError();send({type:'reload',id:state.active});};
  els.mediaPlay.onclick=()=>send({type:'media-play',id:state.active}); els.mediaMute.onclick=()=>send({type:'media-mute',id:state.active}); els.mediaVolume.oninput=()=>send({type:'media-volume',id:state.active,volume:Number(els.mediaVolume.value)}); els.mediaCaptions.onclick=()=>send({type:'media-captions',id:state.active}); els.mediaFullscreen.onclick=()=>send({type:'media-fullscreen',id:state.active});
  els.findClose.onclick=()=>els.findbar.hidden=true;els.findPrev.onclick=()=>send({type:'find-prev',id:state.active});els.findNext.onclick=()=>send({type:'find-next',id:state.active});els.findInput.oninput=()=>send({type:'find',id:state.active,text:els.findInput.value});
  window.addEventListener('resize',debouncedResize);
  document.addEventListener('keydown',e=>{
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='l'){e.preventDefault();els.input.focus();els.input.select();}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='f'&&state.active!=='home'){e.preventDefault();els.findbar.hidden=false;els.findInput.focus();els.findInput.select();}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='r'&&state.active!=='home'){e.preventDefault();send({type:'reload',id:state.active});}
  });
  window.openUrl=openUrl;
  applyLanguage(); loadApps();loadBookmarks();loadHistory();renderTabs(); restoreSession();
})();
