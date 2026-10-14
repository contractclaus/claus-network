import {domainName} from '../src/domains/index.mjs';
import {render} from './render.mjs';
export function siteRequestUrl(value,siteOrigin){
  const url=new URL(value,siteOrigin);
  if(url.pathname==='/api/gateway'&&url.searchParams.has('__claus_route'))url.pathname='/r/'+(url.searchParams.get('__claus_route')??'');
  url.searchParams.delete('__claus_route');
  // The host also forwards its wildcard capture as a query parameter. Remove
  // only the capture of this exact public path; other queries remain invalid.
  const capture=url.searchParams.get('path'),tail=url.pathname.slice(3);
  if(url.pathname.startsWith('/r/')&&capture!==null&&[tail,'/'+tail].includes(capture))url.searchParams.delete('path');
  return url;
}
export default async function handler(req,res){
 const siteOrigin=process.env.CLAUS_SITE_ORIGIN??'https://claus-network-sites.vercel.app',apiOrigin=process.env.CLAUS_API_ORIGIN??'https://claus-network-api.vercel.app',frameOrigin=process.env.CLAUS_FRAME_ORIGIN??'https://claus.si';
 let response;try{const host=req.headers.host;if(typeof host!=='string')throw Error('missing_host');const original=siteRequestUrl(req.url,siteOrigin);
  if(host===new URL(siteOrigin).hostname||host===process.env.VERCEL_URL){response=await render(new Request(original,{method:req.method}),{siteOrigin,apiOrigin,frameOrigin});}
  else{domainName(host);const lookup=await fetch(apiOrigin+'/v1/public/domains/'+encodeURIComponent(host),{redirect:'error',signal:AbortSignal.timeout(8000)});if(lookup.status===404){res.writeHead(404,{'cache-control':'no-store'});res.end('Not found');return;}if(!lookup.ok)throw Error('domain_unavailable');const raw=await lookup.text();if(Buffer.byteLength(raw)>10000)throw Error('domain_response');const map=JSON.parse(raw);if(map.hostname!==host||!/^sha256:[0-9a-f]{64}$/.test(map.releaseId)||map.verifiedUntil<=Date.now())throw Error('domain_not_verified');
   let path=original.pathname;if(path==='/api/gateway')path='/'+(original.searchParams.get('__claus_site_path')??'');original.searchParams.delete('__claus_site_path');original.searchParams.delete('path');if(original.search||!['GET','HEAD'].includes(req.method))throw Error('invalid_site_path');if(path.endsWith('/'))path+='index.html';else if(!/\.[^/]+$/.test(path))path+='.html';
   const url=new URL('/r/'+map.releaseId.slice(7)+path,'https://'+host);response=await render(new Request(url,{method:req.method}),{siteOrigin:'https://'+host,apiOrigin,frameOrigin});
  }
 }catch{response=new Response('Temporarily unavailable',{status:503,headers:{'cache-control':'no-store','content-type':'text/plain; charset=utf-8'}});}
 res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
}
