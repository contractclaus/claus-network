import {createProjectSite} from './project-site.js?v=f0220f9bce1a';
import {publicPresentation,presentation} from './presentation.js';
import {signalView} from './signal-model.js';
const root = document.querySelector('#project-content'), heading = document.querySelector('#project-name');
const projectPath=location.pathname.match(/^\/(?:c|p)\/([a-z0-9-]+)(?:\/(.*))?$/),slug=projectPath?.[1],rawPath=projectPath?.[2]||'index.html';
const sitePath=rawPath;
const site=createProjectSite(root);
const status = document.querySelector('#project-status');
if (slug) {
  const canonical = document.createElement('link'); canonical.rel = 'canonical';
  document.querySelector('link[rel=alternate]').href='/read/network/'+slug;
  canonical.href = 'https://claus.si/c/' + slug + (projectPath[2] ? '/' + projectPath[2] : ''); document.head.append(canonical);
}
function element(tag, text, className) {
  const el = document.createElement(tag); if (text) el.textContent = text; if (className) el.className = className; return el;
}
function link(text, url) {
  const a = element('a', text); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
}
let rendered = '',lastPresentation=null;
function display(project) {
  const releaseId=(project.releases??[]).filter(r=>r.expiresAt===null||r.expiresAt>Date.now()).sort((a,b)=>b.createdAt-a.createdAt||b.id.localeCompare(a.id))[0]?.id;
  if(project.presentation)lastPresentation={releaseId,value:project.presentation};
  else if(releaseId&&lastPresentation?.releaseId===releaseId)project={...project,presentation:lastPresentation.value};
  else lastPresentation=null;
  const signature = JSON.stringify([project,releaseId,location.hash]);
  if (signature === rendered) { status.textContent = ''; return; }
  rendered = signature;
  const brand=publicPresentation(project.presentation),name=brand?.name||project.name;
  heading.textContent=name;document.title=name;
  const icon=document.querySelector('link[rel=icon]');icon.href=brand?.logo||'/assets/favicon-ec673a.png';
  if(site.show(project,slug,sitePath)){status.textContent='';return;}
  const nodes = [element('span', 'Registered', 'project-stage')];
  if(brand?.logo||brand?.preview){const media=element('div','','project-media');
    for(const kind of ['logo','preview'])if(brand?.[kind]){const image=element('img','','project-'+kind);image.alt=kind==='logo'?name+' logo':'';image.referrerPolicy='no-referrer';image.decoding='async';image.src=brand[kind];image.addEventListener('error',()=>image.remove(),{once:true});media.append(image);}nodes.push(media);}
  if (brand?.description||project.description) nodes.push(element('p', brand?.description||project.description, 'project-description'));
  if(project.application){const section=element('section','','project-section');section.append(element('h2','Application'),link('Read app', '/read/apps/'+encodeURIComponent(slug)),link('App JSON', '/c/'+encodeURIComponent(slug)+'/app.json'));nodes.push(section);}
  const evidence = project.evidence ?? {};
  if(Array.isArray(project.services)&&project.services.length){
    const section=element('section');section.id='services';section.append(element('h2','Services'));
    for(const service of project.services){
      if(typeof service.name!=='string'||typeof service.version!=='string')continue;
      const row=element('div','','project-evidence');
      row.append(element('strong',service.name),element('span',service.capability),element('span','v'+service.version));
      section.append(row);
    }
    nodes.push(section);
  }
  if(Array.isArray(project.releases)&&project.releases.length){
    const section=element('section');section.id='interfaces';section.append(element('h2','Interfaces'));
    for(const release of project.releases){
      if(!/^https:\/\/claus-network-sites\.vercel\.app\/r\/[0-9a-f]{64}\/index\.html$/.test(release.url??''))continue;
      const row=element('div','','project-evidence');row.append(link('Open interface',release.url));section.append(row);
    }
    nodes.push(section);
  }
  if (Array.isArray(project.agents) && project.agents.length) {
    const section = element('section'); section.id = 'agents'; section.append(element('h2', 'Agents'));
    for (const agent of project.agents) if (typeof agent.name === 'string' && agent.name.length <= 80)
      section.append(element('div', agent.name, 'project-evidence'));
    nodes.push(section);
  }
  if(Array.isArray(project.signals)&&project.signals.length){
    const section=element('section');section.id='signals';section.append(element('h2','Signal feed'));
    for(const feed of project.signals){
      if(![1,11155111].includes(feed.chainId)||!/^0x[0-9a-f]{40}$/i.test(feed.address))continue;
      const row=element('div','','project-feed');row.dataset.signal=feed.projectId;
      const label=element('p','Loading…','project-feed-state');label.setAttribute('role','status');
      row.append(label,element('div','','project-feed-value'),element('dl','','project-feed-details'),
        link('View contract','https://'+(feed.chainId===1?'':'sepolia.')+'etherscan.io/address/'+feed.address));
      section.append(row);
    }
    nodes.push(section);
  }
  if(Array.isArray(project.results)&&project.results.length){
    const section=element('section');section.id='results';section.append(element('h2','Published results'));
    for(const result of project.results){
      if(typeof result.id!=='string'||!/^sha256:[0-9a-f]{64}$/.test(result.outputHash??''))continue;
      const row=element('div','','project-evidence');
      row.append(link('Result · '+result.outputHash.slice(7,17),'/network.json?result='+encodeURIComponent(result.id)));
      const date=new Date(result.deliveredAt);if(Number.isFinite(date.getTime())){
        const time=element('time',date.toLocaleString());time.dateTime=date.toISOString();row.append(time);
      }
      for(const source of result.sourceResults??[])row.append(link('Source · '+source.outputHash.slice(7,17),
        '/network.json?result='+encodeURIComponent(source.id)));
      section.append(row);
    }
    nodes.push(section);
  }
  for (const [field, label] of [['reviews', 'Reviews'], ['decisions', 'Claus decisions'], ['deployments', 'Contracts']]) {
    const entries = evidence[field]; if (!Array.isArray(entries) || !entries.length) continue;
    const section = element('section'); section.id = field === 'deployments' ? 'contracts' : field; section.append(element('h2', label));
    for (const entry of entries) {
      const row = element('div', '', 'project-evidence');
      if (field === 'deployments') {
        if (![1, 11155111].includes(entry.chainId) || !/^0x[0-9a-fA-F]{40}$/.test(entry.address)) continue;
        row.append(element('span', entry.chainId === 1 ? 'Ethereum' : 'Sepolia testnet'));
        row.append(link(entry.address, 'https://' + (entry.chainId === 1 ? '' : 'sepolia.') + 'etherscan.io/address/' + entry.address));
        if (entry.verification === 'verified') row.append(element('span', 'Source verified'));
      } else {
        row.append(element('span', typeof entry.status === 'string' ? entry.status : 'Recorded'));
        if (field === 'reviews' && /^sha256:[0-9a-f]{64}$/.test(entry.id ?? ''))
          row.append(link('IMD report', '/network.json?review=' + encodeURIComponent(entry.id)));
      }
      section.append(row);
    }
    nodes.push(section);
  }
  root.replaceChildren(...nodes); root.removeAttribute('aria-busy'); status.textContent = '';
}
const feedCache=new Map();
function displayFeed(row,data){
 const view=signalView(data),signature=JSON.stringify(view);
 if(row.dataset.view===signature)return;row.dataset.view=signature;row.dataset.state=view.state;
 row.querySelector('.project-feed-state').textContent=view.label;
 const value=row.querySelector('.project-feed-value'),details=row.querySelector('.project-feed-details');
 value.textContent=view.baseFeeGwei?view.baseFeeGwei+' gwei':'';
 details.replaceChildren();
 for(const [label,text] of [['Threshold',view.threshold],['Block',view.blockNumber],['Record',view.sequence],
   ['Logic version',view.version],['Observed',view.observedAt?new Date(view.observedAt).toLocaleString():null]]){
  if(text==null)continue;const pair=element('div');pair.append(element('dt',label),element('dd',text));details.append(pair);
 }
}
async function loadFeeds(signal){
 await Promise.all([...root.querySelectorAll('[data-signal]')].map(async row=>{
  try{
   const r=await fetch('/network.json?signal='+encodeURIComponent(row.dataset.signal),{signal,cache:'no-store'});
   if(!r.ok)throw Error('unavailable');const data=await r.json();
   if(signal.aborted)return;
   if(data.projectId!==row.dataset.signal)throw Error('invalid_feed');
   feedCache.set(row.dataset.signal,data);if(row.isConnected)displayFeed(row,data);
  }catch{if(signal.aborted)return;feedCache.delete(row.dataset.signal);if(row.isConnected)displayFeed(row,{state:'unavailable'});}
 }));
}
setInterval(()=>{if(document.hidden)return;for(const row of root.querySelectorAll('[data-signal]')){
 const data=feedCache.get(row.dataset.signal);if(data)displayFeed(row,data);
}},10000);
let controller, timer;
function pauseLoad(){
 clearTimeout(timer);const previous=controller;controller=null;previous?.abort();
}
async function load() {
  if (!slug || controller || document.hidden) return;
  controller = new AbortController(); const active=controller; const timeout = setTimeout(() => active.abort(), 12000);
  try {
    const r = await fetch('/network.json?project=' + encodeURIComponent(slug)+'&view=entry', { signal: active.signal });
    if(active!==controller||active.signal.aborted)return;
    if (r.status === 404) {
      site.clear();rendered = ''; document.title='Project unavailable | Claus';document.querySelector('link[rel=icon]').href='/assets/favicon-ec673a.png';heading.textContent = 'Project unavailable'; root.replaceChildren(); root.removeAttribute('aria-busy'); status.textContent = ''; return;
    }
    if (!r.ok) throw Error('unavailable');
    let project = await r.json(); if(active!==controller||active.signal.aborted)return; if (project.slug !== slug || typeof project.name !== 'string') throw Error('invalid_project');
    // Preserve the full evidence view for registered projects without a site.
    if(!(project.releases??[]).some(release=>release.expiresAt===null||release.expiresAt>Date.now())){
      const details=await fetch('/network.json?project='+encodeURIComponent(slug),{signal:active.signal});
      if(!details.ok)throw Error('unavailable');const full=await details.json();
      if(active!==controller||active.signal.aborted)return;
      if(full.projectId!==project.projectId||full.slug!==slug)throw Error('invalid_project');project=full;
    }
    // Start the actual website immediately. Optional branding must not hold it up.
    display(project);
    await Promise.all([loadFeeds(active.signal),loadPresentation(project,active.signal)]);
  } catch { if(active!==controller)return; if(!rendered)document.getElementById('project-loading-retry').hidden=false; status.textContent = rendered ? 'Update unavailable. Showing last loaded version.' : 'Could not load this project. Retrying shortly.'; }
  finally { clearTimeout(timeout); if(controller===active){controller=null;clearTimeout(timer);if(!document.hidden)timer=setTimeout(load,30000);} }
}
async function loadPresentation(project,signal){
  const release=(project.releases??[]).filter(r=>/^sha256:[a-f0-9]{64}$/.test(r.id??'')&&(r.expiresAt===null||r.expiresAt>Date.now())).sort((a,b)=>b.createdAt-a.createdAt||b.id.localeCompare(a.id))[0];
  if(!release)return;
  try{
    const r=await fetch('https://claus-network-api.vercel.app/v1/public/releases/'+encodeURIComponent(release.id)+'/file?filePath=claus.json',{signal,credentials:'omit'});
    if(!r.ok)return;const source=await r.json();
    if(signal.aborted||source.projectId!==project.projectId||source.id!==release.id||source.expiresAt!==null&&source.expiresAt<=Date.now()||typeof source.file?.content!=='string'||new TextEncoder().encode(source.file.content).length>4096||!Array.isArray(source.paths))return;
    const brand=presentation(JSON.parse(source.file.content),{...source,files:source.paths.map(path=>({path}))});
    if(!brand)return;
    display({...project,presentation:brand});
    for(const row of root.querySelectorAll('[data-signal]')){const data=feedCache.get(row.dataset.signal);if(data)displayFeed(row,data);}
  }catch{/* Branding is optional; the verified project entry already rendered. */}
}
document.addEventListener('visibilitychange', () => { if (document.hidden) pauseLoad(); else load(); });
addEventListener('pagehide', event => {if(!event.persisted){site.clear();rendered='';} pauseLoad(); });
if(slug&&['#services','#interfaces','#agents','#signals','#results','#reviews','#decisions','#contracts'].includes(location.hash)){location.replace('/read/network/'+slug+location.hash);}
else if(!slug){site.clear();heading.textContent='Project unavailable';root.removeAttribute('aria-busy');}else load();

addEventListener('pageshow',load);

addEventListener('hashchange',()=>{pauseLoad();void load();});

const loadingRetry=document.getElementById('project-loading-retry');loadingRetry?.addEventListener('click',()=>location.reload());
setTimeout(()=>{if(document.body.classList.contains('project-loading')&&loadingRetry)loadingRetry.hidden=false;},12000);
