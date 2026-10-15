import {isIP} from 'node:net';
import {limitedJSON,SearchError} from './policy.js';
export function createSearchProvider({fetcher=fetch,key=()=>process.env.BRAVE_SEARCH_API_KEY,secret=()=>process.env.SEARCH_CLIENT_SECRET}={}){
 return async request=>{
  const token=key();if(!token)throw new SearchError('search_not_connected');
  const url=new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q',request.expanded);url.searchParams.set('count','8');url.searchParams.set('text_decorations','false');
  if(request.freshness)url.searchParams.set('freshness',({day:'pd',week:'pw',month:'pm',year:'py'})[request.freshness]);
  let r;try{r=await fetcher(url,{headers:{Accept:'application/json','X-Subscription-Token':token},redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw new SearchError('search_provider_unavailable');}
  if(!r.ok)throw new SearchError(r.status===429?'search_rate_limited':r.status===401||r.status===403?'search_access_denied':'search_provider_unavailable');
  const body=await limitedJSON(r);
  if(body?.web!==undefined&&!Array.isArray(body.web?.results)||body?.type!=='search'&&!body?.web)throw new SearchError('search_invalid_response');
  // Discovery candidates only. Provider snippets and ranking metadata never leave this request.
  const hidden=[token,secret()].filter(Boolean);
  const urls=[...new Set((body.web?.results??[]).flatMap(item=>{
   try{
    if(typeof item.url!=='string'||item.url.length>2048||hidden.some(x=>item.url.includes(x)||decodeURIComponent(item.url).includes(x)))return [];
    const u=new URL(item.url),h=u.hostname.toLowerCase();
    if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||isIP(h)||h.includes(':')||!h.includes('.')||h==='localhost'||/\.(?:localhost|local|internal|test|invalid)$/.test(h))return [];
    return [u.href];
   }catch{return [];}
  }))].slice(0,4);
  return {urls};
 };
}
