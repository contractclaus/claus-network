import {projectPagePath} from '../lib/project-path.mjs';
// Opaque project frames can request only declared pages of their own release.
export function attachSiteNavigation(frame,{slug,release}){
 function message(event){
  const data=event.data;
  if(event.source!==frame.contentWindow||event.origin!=='null'||!data||data.releaseId!==release.id)return;
  if(data.type==='claus-site-ready'){
   frame.contentWindow.postMessage({type:'claus-site-host-ready',releaseId:release.id},'*');return;
  }
  if(data.type!=='claus-site-navigate'||frame.inert||!frame.isConnected||typeof data.path!=='string')return;
  const path=projectPagePath(data.path,release.paths);
  if(!path||path!==data.path||!Array.isArray(release.paths)||!release.paths.includes(path))return;
  const hash=data.hash??'';
  if(typeof hash!=='string'||hash&&!/^#[A-Za-z0-9_=:.%~-]{1,360}$/.test(hash))return;
  const anchor=document.createElement('a'),box=frame.getBoundingClientRect();
  anchor.href='/c/'+encodeURIComponent(slug)+(path==='index.html'?'':'/'+path)+hash;
  anchor.setAttribute('aria-hidden','true');anchor.tabIndex=-1;
  Object.assign(anchor.style,{position:'fixed',width:'1px',height:'1px',pointerEvents:'none',left:(box.left+Math.min(box.width,Math.max(0,Number.isFinite(data.x)?data.x:box.width/2)))+'px',top:(box.top+Math.min(box.height,Math.max(0,Number.isFinite(data.y)?data.y:box.height/2)))+'px'});
  document.body.append(anchor);anchor.click();anchor.remove();
 }
 addEventListener('message',message);
 return()=>removeEventListener('message',message);
}
