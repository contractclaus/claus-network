import {render} from './render.mjs';
export function siteRequestUrl(value,siteOrigin){
  const url=new URL(value,siteOrigin);
  if(url.pathname==='/api/gateway')url.pathname='/r/'+(url.searchParams.get('__claus_route')??'');
  url.searchParams.delete('__claus_route');
  // The host also forwards its wildcard capture as a query parameter. Remove
  // only the capture of this exact public path; other queries remain invalid.
  const capture=url.searchParams.get('path'),tail=url.pathname.slice(3);
  if(url.pathname.startsWith('/r/')&&capture!==null&&[tail,'/'+tail].includes(capture))url.searchParams.delete('path');
  return url;
}
export default async function handler(req,res){
  const siteOrigin=process.env.CLAUS_SITE_ORIGIN??'https://claus-network-sites.vercel.app';
  const incoming=siteRequestUrl(req.url,siteOrigin);
  const response=await render(new Request(incoming,{method:req.method}),{siteOrigin,
      apiOrigin:process.env.CLAUS_API_ORIGIN??'https://claus-network-api.vercel.app',
      frameOrigin:process.env.CLAUS_FRAME_ORIGIN??'https://claus.si'});
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
}
