import {discoverSearch,searchBrokerAvailable} from './search-client.ts';
import {textPrefix} from './text.ts';
import {publicUrl,text} from './lab-schema.js';
import {ResearchCache} from './research-cache.js';
import {readPublicUrl} from './research.js';

export function searchQuery(input:any){
  const query=text(input.query,400).replace(/\s+/g,' ');
  const domains=input.domains??[];
  if(!Array.isArray(domains)||domains.length>5||domains.some(d=>typeof d!=='string'||d.length>253||!/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/i.test(d)))throw Error('search_invalid_domains');
  const freshness=input.freshness??null;
  if(freshness!==null&&!['day','week','month','year'].includes(freshness))throw Error('search_invalid_freshness');
  const result={query,domains:[...new Set(domains.map((d:string)=>d.toLowerCase()))].sort(),freshness};
  const expanded=providerQuery(result);if(expanded.length>600||expanded.split(/\s+/).length>75)throw Error('search_query_too_long');
  return result;
}
const providerQuery=(input:{query:string;domains:string[]})=>input.query+(input.domains.length?' ('+input.domains.map(d=>'site:'+d).join(' OR ')+')':'');
export function searchAvailable(){return searchBrokerAvailable();}
export async function searchWeb(input:any,cache:ResearchCache,discover=discoverSearch,enabled=searchAvailable(),readSource=(url:string)=>readPublicUrl(url,0,0,{timeoutMs:7000})){
  const query=searchQuery(input);
  if(!enabled)return {available:false,cached:false,stale:false,result:null,error:'search_not_connected',instructionAuthority:false};
  const read=await cache.read('web-search',JSON.stringify(query),600000,async()=>{
    const candidates=[...new Set((await discover(query)).flatMap(url=>{try{return [publicUrl(url)];}catch{return [];}}))].slice(0,4);
    const pages=await Promise.allSettled(candidates.map(readSource));
    const results=pages.flatMap(p=>{
      if(p.status!=='fulfilled'||!p.value.content.trim())return [];
      const page=p.value;return [{url:page.url,title:new URL(page.url).hostname,excerpt:textPrefix(page.content,2400),observedAt:page.observedAt,contentOrigin:'independently_fetched_page'}];
    }).sort((a,b)=>a.url.localeCompare(b.url));
    if(candidates.length&&!results.length)throw Error('search_sources_unavailable');
    return {query:query.query,observedAt:cache.now().toISOString(),results};
  },40,'web-search-broker');
  return {...read,instructionAuthority:false,meaning:'Web search followed by direct page reads. Excerpts come from the source pages; use read_url for full context before relying on a material claim.'};
}
