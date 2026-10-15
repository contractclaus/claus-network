import {createHash} from 'node:crypto';
export const dailyLimit=40;
export class SearchError extends Error {
 constructor(code,status=503){super(code);this.status=status;}
}
export function searchRequest(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['id','query','domains','freshness'].includes(k)))throw new SearchError('search_invalid_request',400);
 const {id}=input;
 if(typeof id!=='string'||!/^search:[a-zA-Z0-9_-]{1,100}$/.test(id))throw new SearchError('search_invalid_id',400);
 if(typeof input.query!=='string'||input.query.length>400||/[\u0000-\u001f\u007f]/.test(input.query))throw new SearchError('search_invalid_query',400);
 const query=input.query.trim().replace(/\s+/g,' ');
 if(!query)throw new SearchError('search_invalid_query',400);
 const raw=input.domains??[];
 if(!Array.isArray(raw)||raw.length>5||raw.some(d=>typeof d!=='string'||d.length>253||!/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/i.test(d)))throw new SearchError('search_invalid_domains',400);
 const domains=[...new Set(raw.map(d=>d.toLowerCase()))].sort(),freshness=input.freshness??null;
 if(freshness!==null&&!['day','week','month','year'].includes(freshness))throw new SearchError('search_invalid_freshness',400);
 const expanded=query+(domains.length?' ('+domains.map(d=>'site:'+d).join(' OR ')+')':'');
 if(expanded.length>600||expanded.split(/\s+/).length>75)throw new SearchError('search_query_too_long',400);
 const hash=createHash('sha256').update(JSON.stringify({query,domains,freshness})).digest('hex');
 return {id,query,domains,freshness,expanded,hash};
}
export async function limitedJSON(response,max=500000){
 if(!response.body)throw new SearchError('search_invalid_response');
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max)throw new SearchError('search_response_too_large');chunks.push(value);}}
 catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new SearchError('search_invalid_response');}
}
