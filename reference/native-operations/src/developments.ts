import {textPrefix} from './text.ts';
import sources from '../config/development-sources.json' with {type:'json'};
import {ResearchCache,boundedJSON} from './research-cache.js';
import {hash,publicUrl,type LabSettings} from './lab-schema.js';
import {LabStore} from './lab-store.js';

export type Development={id:string;title:string;url:string;publishedAt:string;kind:'release'|'commit'|'publication'|'capability';summary:string;eligible:boolean};
function stableCapabilities(value:any):any {
  if(Array.isArray(value))return value.map(stableCapabilities);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(key=>!['timestamp','observedAt','generatedAt','serverTime','requestId'].includes(key)).map(key=>[key,stableCapabilities(value[key])]));
  return value;
}
export function capabilityItem(source:{id:string;name:string;url:string},body:any,observedAt:string):Development {
  if(!sources.capabilities.some(s=>s.id===source.id&&s.url===source.url)||!body||typeof body!=='object'||Array.isArray(body)||!Object.keys(body).length)throw Error('development_invalid_response');
  const content=JSON.stringify(stableCapabilities(body));
  return {id:'capability:'+source.id+':'+hash(content),title:source.name,url:source.url,publishedAt:date(observedAt),kind:'capability',summary:'Observed public capability document, not a release announcement or execution grant. '+textPrefix(content,1400),eligible:true};
}
function date(value:any){if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))throw Error('development_invalid_date');return new Date(value).toISOString();}
export function githubItems(repo:string,releases:any,commits:any):Development[]{
  if(!sources.github.includes(repo)||!Array.isArray(releases)||!Array.isArray(commits))throw Error('development_invalid_response');
  const origin=`https://github.com/${repo}/`;
  return [...releases.filter(r=>!r.draft).slice(0,6).map(r=>({id:`github:${repo}:release:${r.id}`,title:textPrefix(String(r.name||r.tag_name),160),url:publicUrl(r.html_url),publishedAt:date(r.published_at),kind:'release' as const,summary:textPrefix(String(r.body??''),1600),eligible:r.prerelease===false})),...commits.slice(0,4).map(c=>({id:`github:${repo}:commit:${c.sha}`,title:textPrefix(String(c.commit?.message??'').split('\n')[0],160),url:publicUrl(c.html_url),publishedAt:date(c.commit?.committer?.date),kind:'commit' as const,summary:'Default-branch commit; this is not a release or evidence that deployed code changed.',eligible:false}))].filter(i=>i.url.startsWith(origin));
}
export function imdItems(body:any):Development[]{
  if(!Array.isArray(body.items))throw Error('development_invalid_response');
  return body.items.slice(0,20).map((p:any)=>({id:'imd:'+String(p.id).slice(0,140),title:textPrefix(String(p.title??'IMD publication'),160),url:'https://api.imd.fun/publications?q='+encodeURIComponent(String(p.id)),publishedAt:date(p.publishedAt),kind:'publication' as const,summary:textPrefix(String(p.title??''),1600),eligible:false}));
}
export class Developments {
  constructor(readonly cache:ResearchCache,readonly fetcher:typeof fetch=fetch){}
  private async json(url:string){const r=await this.fetcher(url,{headers:{Accept:'application/json','User-Agent':'ClausResearch/1.0'},redirect:'error',signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error(r.status===429||r.status===403?'development_rate_limited':'development_source_unavailable');return boundedJSON(r,1500000);}
  async read(){
    const tasks=sources.github.map(repo=>({id:'github:'+repo,ttl:6*3600000,load:async()=>githubItems(repo,...await Promise.all([this.json(`https://api.github.com/repos/${repo}/releases?per_page=6`),this.json(`https://api.github.com/repos/${repo}/commits?per_page=4`)]) as [any,any])}));
    tasks.push({id:'imd-publications',ttl:6*3600000,load:async()=>imdItems(await this.json(sources.imdPublications))});
    for(const source of sources.capabilities)tasks.unshift({id:'capabilities:'+source.id,ttl:4*3600000,load:async()=>[capabilityItem(source,await this.json(source.url),this.cache.now().toISOString())]});
    const feeds=[];
    for(const task of tasks){const result=await this.cache.read('developments',task.id,task.ttl,async()=>({items:await task.load(),observedAt:this.cache.now().toISOString()}),null);feeds.push({id:task.id,...result});}
    return {feeds,coverage:'Selected releases and commits, IMD publications, and public IMD/Surplus capabilities. Capabilities refresh every four hours; other feeds every six, without an internal daily read quota; upstream rate limits still apply. Use the source URL for a fresh check when answering a current question. Not exhaustive or a guarantee of service availability.',instructionAuthority:false};
  }
  async observe(store:LabStore,settings:LabSettings){
    const result=await this.read();
    for(const feed of result.feeds){
      if(!feed.available||!feed.result)continue;
      await this.cache.db.transaction(async q=>{
        await q.query('SELECT pg_advisory_xact_lock(7439094)');
        const {rows:[old]}=await q.query('SELECT * FROM claus_development_baselines WHERE id=$1',[feed.id]);
        const items:Development[]=feed.result.items.filter((item:Development)=>Date.parse(item.publishedAt)<=this.cache.now().getTime());
        if(old){const seen=new Set(old.seen as string[]);for(const item of items){
          if(seen.has(item.id)||!item.eligible||Date.parse(item.publishedAt)<new Date(old.started_at).getTime())continue;
          await q.query("INSERT INTO claus_development_updates(id,content,created_at) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING",[item.id,item,this.cache.now()]);
        }}
        const seen=[...new Set([...(old?.seen??[]),...items.map(i=>i.id)])].slice(-1000);
        await q.query('INSERT INTO claus_development_baselines(id,seen,started_at) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET seen=$2',[feed.id,JSON.stringify(seen),this.cache.now()]);
      });
    }
    // Each observation may seed one useful dossier, within the existing work queue.
    // The first observation only establishes a baseline. Existing budgets apply.
    const {rows:[next]}=await this.cache.db.query("SELECT id,content FROM claus_development_updates WHERE captured=false ORDER BY created_at,id LIMIT 1");
    if(next){try{
      const item=next.content as Development;
      await store.capture({id:'development-'+hash(next.id).slice(0,24),title:textPrefix(item.title,140),question:`A watched source changed: ${item.title}. ${item.kind==='capability'?'This is an observed capability document change, not a release or a new permission.':'This is a stable release.'} Check whether it changes an assumption in current work or enables a useful idea. Keep the check proportionate and set it aside if irrelevant.`,source:{label:item.title,url:item.url},actor:'system'},settings);
      await this.cache.db.query('UPDATE claus_development_updates SET captured=true WHERE id=$1',[next.id]);
    }catch(error){if(!(error instanceof Error&&error.message==='lab_queue_full'))throw error;}}
    return result;
  }
}
