import {boundedJSON} from './research-cache.ts';
export function searchBrokerAvailable(){return process.env.SEARCH_BROKER_ENABLED==='true'&&!!process.env.SEARCH_CLIENT_SECRET;}
export function createSearchClient({fetcher=fetch,secret=()=>process.env.SEARCH_CLIENT_SECRET}={}){
 return async (query:{query:string;domains:string[];freshness:string|null})=>{
  const key=secret();if(!key)throw Error('search_not_connected');
  const r=await fetcher('https://claus-inference.vercel.app/api/search',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify({id:'search:'+crypto.randomUUID(),...query}),redirect:'error',signal:AbortSignal.timeout(22000)}).catch(()=>{throw Error('search_broker_unavailable');});
  const body=await boundedJSON(r,16384).catch(()=>{throw Error('search_invalid_response');});
  if(!r.ok)throw Error(typeof body?.error==='string'&&/^search_[a-z_]+$/.test(body.error)?body.error:'search_broker_unavailable');
  if(!body||!Array.isArray(body.urls)||body.urls.length>4||body.urls.some((u:any)=>typeof u!=='string'||u.length>2048))throw Error('search_invalid_response');
  return body.urls as string[];
 };
}
export async function discoverSearch(query:{query:string;domains:string[];freshness:string|null}){return createSearchClient()(query);}
