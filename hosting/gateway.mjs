import {render} from './render.mjs';
export default async function handler(req,res){
  const incoming=new URL(req.url,'https://claus-network-sites.vercel.app');
  const route=incoming.pathname.startsWith('/r/')?incoming.pathname:'/r/'+(incoming.searchParams.get('__claus_route')??'');
  incoming.searchParams.delete('__claus_route');
  const response=await render(new Request('https://claus-network-sites.vercel.app'+route+
    (incoming.searchParams.size?'?'+incoming.searchParams:''),{method:req.method}));
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
}
