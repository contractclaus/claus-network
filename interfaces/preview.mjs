// Local, loopback-only preview of an authenticated immutable source bundle.
import {createServer} from 'node:http';
export async function previewSite({client,projectId,releaseId}){
 const site=await client.call('release_preview',{projectId,releaseId}),files=new Map(site.files.map(f=>[f.path,f.content]));
 const server=createServer((req,res)=>{
  if(req.headers.host!==`127.0.0.1:${server.address().port}`||req.method!=='GET'){res.writeHead(403);res.end();return;}
  let path;try{path=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname).slice(1)||'index.html';}catch{res.writeHead(400);res.end();return;}
  if(!files.has(path)){res.writeHead(404);res.end();return;}
  const mime={html:'text/html',css:'text/css',js:'text/javascript',json:'application/json',svg:'image/svg+xml'};
  res.setHeader('content-type',(mime[path.split('.').at(-1)]??'text/plain')+'; charset=utf-8');res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
  res.setHeader('content-security-policy',"sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");res.end(files.get(path));
 });await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});return {url:`http://127.0.0.1:${server.address().port}/`,releaseId,close:()=>new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()))};
}
