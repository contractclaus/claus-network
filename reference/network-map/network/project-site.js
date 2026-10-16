import {attachAppBridge} from './app-bridge.js';
import {projectPagePath} from '../lib/project-path.mjs';
export function createProjectSite(root){
 let current=null,frame=null,dispose=null,pending=null,sequence=0;
 const retired=new Map();
 const cancelPending=()=>{sequence++;pending?.dispose?.();pending?.frame.remove();pending=null;};
 const mask=document.getElementById('project-loading');
 const loading=value=>{document.body.classList.toggle('project-loading',value);if(mask)mask.hidden=!value;root.setAttribute('aria-busy',String(value));if(!value)dispatchEvent(new Event('claus-page-ready'));};
 return {
  show(project,slug,requestedPath='index.html'){
   const release=(project.releases??[]).filter(r=>/^sha256:[a-f0-9]{64}$/.test(r.id??'')&&(r.expiresAt===null||r.expiresAt>Date.now())).sort((a,b)=>b.createdAt-a.createdAt||b.id.localeCompare(a.id))[0];
   if(!release){this.clear();return false;}
   const path=projectPagePath(requestedPath,release.paths);
   if(!path){
    this.clear();root.closest('main').classList.add('has-project-site');
    const note=document.createElement('p');note.textContent='Page not found. ';
    const back=document.createElement('a');back.href='/c/'+encodeURIComponent(slug);back.textContent='Back to project';note.append(back);root.replaceChildren(note);
    return true;
   }
   const fragment=/^#task=[A-Za-z0-9:_%-]{1,360}$/.test(location.hash)?location.hash:'';
   const key=release.id+':'+path+fragment;
   if(key===current){cancelPending();dispose?.update?.(project);return true;}
   if(key===pending?.key){pending.dispose?.update?.(project);return true;}
   cancelPending();const own=sequence;
   root.closest('main').classList.add('has-project-site');if(!frame)loading(true);
   const next=document.createElement('iframe');next.className='network-project-site is-loading';next.title=(project.presentation?.name||project.name)+' website';next.sandbox='allow-scripts allow-forms';next.referrerPolicy='no-referrer';next.inert=true;
   next.setAttribute('allow',"camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'");
   next.addEventListener('load',()=>requestAnimationFrame(()=>requestAnimationFrame(()=>{
    if(own!==sequence||pending?.frame!==next)return;
    const old=frame;dispose?.();frame=next;dispose=pending.dispose;current=key;pending=null;
    // The first frame must be opaque before removing its loading background.
    // Later releases can crossfade over the existing, fully rendered page.
    if(!old)next.classList.add('is-initial');
    next.classList.remove('is-loading');next.inert=false;loading(false);if(old){old.inert=true;retired.set(old,setTimeout(()=>{old.remove();retired.delete(old);},200));}
   })),{once:true});
   next.src='https://claus-network-sites.vercel.app/r/'+release.id.slice(7)+'/'+path+fragment;
   pending={key,frame:next,dispose:attachAppBridge(next,project)};
   if(!frame)root.replaceChildren(next);else root.append(next);
   return true;
  },
  clear(){cancelPending();for(const [old,timer]of retired){clearTimeout(timer);old.remove();}retired.clear();dispose?.();dispose=null;frame?.remove();current=null;frame=null;loading(false);root.closest('main').classList.remove('has-project-site');}
 };
}
