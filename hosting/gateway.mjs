import {render} from './render.mjs';
export default async function handler(req,res){
  const siteOrigin=process.env.CLAUS_SITE_ORIGIN??'https://claus-network-sites.vercel.app';
  const incoming=new URL(req.url,siteOrigin);
  const route=incoming.pathname.startsWith('/r/')?incoming.pathname:'/r/'+(incoming.searchParams.get('__claus_route')??'');
  incoming.searchParams.delete('__claus_route');
  const response=await render(new Request(siteOrigin+route+
    (incoming.searchParams.size?'?'+incoming.searchParams:''),{method:req.method}),{siteOrigin,
      apiOrigin:process.env.CLAUS_API_ORIGIN??'https://claus-network-api.vercel.app',
      frameOrigin:process.env.CLAUS_FRAME_ORIGIN??'https://claus.si'});
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
}
