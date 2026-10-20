// Only /view/ adds navigation. /r/ always serves the exact published source.
function navigation({releaseId,paths,frameOrigin}){
 if(parent===window)return;
 const base='/view/'+releaseId.slice(7)+'/',allowed=new Set(paths);let connected=false;
 addEventListener('message',event=>{if(event.source===parent&&event.origin===frameOrigin&&event.data?.type==='claus-site-host-ready'&&event.data.releaseId===releaseId)connected=true;});
 const ready=()=>parent.postMessage({type:'claus-site-ready',releaseId},frameOrigin);
 addEventListener('pageshow',ready);ready();
 document.addEventListener('click',event=>{
  if(!connected||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.altKey||event.shiftKey)return;
  const link=event.target instanceof Element?event.target.closest('a[href]'):null;
  if(!link||link.hasAttribute('download')||link.target&&link.target!=='_self')return;
  const target=new URL(link.href,location.href);
  if(target.origin!==location.origin||!target.pathname.startsWith(base)||target.search||target.pathname===location.pathname)return;
  const path=target.pathname.slice(base.length);
  if(!allowed.has(path)||!path.endsWith('.html')||target.hash&&!/^#[A-Za-z0-9_=:.%~-]{1,360}$/.test(target.hash))return;
  event.preventDefault();event.stopImmediatePropagation();
  parent.postMessage({type:'claus-site-navigate',releaseId,path,hash:target.hash,x:event.clientX,y:event.clientY},frameOrigin);
 },true);
}
export function withSiteNavigation(content,{releaseId,paths,frameOrigin}){
 if(!/^sha256:[a-f0-9]{64}$/.test(releaseId)||!Array.isArray(paths))return content;
 const safe=paths.filter(p=>typeof p==='string'&&/^[A-Za-z0-9_.@+/-]+\.html$/.test(p)&&!p.startsWith('/')&&!p.split('/').some(s=>!s||s==='.'||s==='..'));
 const script='<script>('+navigation.toString()+')('+JSON.stringify({releaseId,paths:safe,frameOrigin}).replaceAll('<','\\u003c')+');</script>';
 const head=/^\s*<!doctype[^>]*>/i.exec(content)?.[0]??'';
 return head+script+content.slice(head.length);
}
