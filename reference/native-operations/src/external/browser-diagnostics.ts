import type {Page} from 'playwright-core';

type Resource={name:string;initiatorType?:string;startTime?:number;duration?:number;responseEnd?:number;transferSize?:number;responseStatus?:number};
type Image={url:string;complete:boolean;naturalWidth:number;loading?:string};
type Snapshot={readyState:string;timeOrigin:number;elapsedMs:number;navigation:Record<string,number>|null;paint:{name:string;startTime:number}[];resources:Resource[];images:Image[];imageCount:number;svgImageCount:number;frames?:string[]};
const ms=(n:unknown)=>typeof n==='number'&&Number.isFinite(n)&&n>=0?Math.round(n*100)/100:null;
const positive=(n:unknown)=>typeof n==='number'&&n>0?ms(n):null;
function publicUrl(raw:string){try{const u=new URL(raw);return ['https:','http:'].includes(u.protocol)?(u.origin+u.pathname).slice(0,1024):null;}catch{return null;}}

export function summarizeBrowserDiagnostics(s:Snapshot,networkIdleObserved:boolean){
 const counts={ready:0,pending:0,failed:0};
 const images=s.images.map(i=>{const status=!i.complete?'pending':i.naturalWidth>0?'ready':'failed';counts[status]++;return {url:publicUrl(i.url),status,loading:i.loading??null};});
 const resources=s.resources.slice().sort((a,b)=>(b.duration??0)-(a.duration??0)).slice(0,60).map(r=>({url:publicUrl(r.name),type:r.initiatorType??null,startMs:ms(r.startTime),durationMs:ms(r.duration),responseEndMs:positive(r.responseEnd),transferBytes:positive(r.transferSize),httpStatus:positive(r.responseStatus)}));
 return {observedAt:new Date().toISOString(),scope:'top-level document only; child-frame content is not measured',embeddedFrames:(s.frames??[]).slice(0,20).map(publicUrl),networkIdleObserved,readyState:s.readyState,timeOrigin:ms(s.timeOrigin),elapsedMs:ms(s.elapsedMs),
  navigation:s.navigation?{ttfbMs:positive(s.navigation.responseStart),domContentLoadedMs:positive(s.navigation.domContentLoadedEventEnd),loadMs:positive(s.navigation.loadEventEnd)}:null,
  paint:s.paint.slice(0,4).map(p=>({name:p.name.slice(0,80),startMs:ms(p.startTime)})),resources,resourceCount:s.resources.length,resourcesTruncated:s.resources.length>60,
  images:{total:s.imageCount,sampled:s.images.length,counts,items:images.slice(0,100),truncated:s.imageCount>100,svgImageCount:s.svgImageCount,coverage:'HTML img elements; SVG/CSS image requests are in resource timings when available'},
  limitations:'One bounded browser observation, not a universal speed benchmark or proof all content loaded. Null timing/size/status means unavailable, cached, or not finished. Lazy images may be pending. Resource timings may omit cross-origin details and older entries. URLs omit credentials, query and fragment.',instructionAuthority:false};
}

export async function browserDiagnostics(page:Page){
 let idle=false;
 try{await page.waitForLoadState('networkidle',{timeout:2500});idle=true;}catch{}
 const snapshot=await page.evaluate(()=>{
  const nav=performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming|undefined;
  return {readyState:document.readyState,timeOrigin:performance.timeOrigin,elapsedMs:performance.now(),navigation:nav?{responseStart:nav.responseStart,domContentLoadedEventEnd:nav.domContentLoadedEventEnd,loadEventEnd:nav.loadEventEnd}:null,
   paint:performance.getEntriesByType('paint').map(p=>({name:p.name,startTime:p.startTime})),
   resources:performance.getEntriesByType('resource').map(p=>{const r=p as PerformanceResourceTiming;return {name:r.name,initiatorType:r.initiatorType,startTime:r.startTime,duration:r.duration,responseEnd:r.responseEnd,transferSize:r.transferSize,responseStatus:(r as PerformanceResourceTiming&{responseStatus?:number}).responseStatus};}),
   images:Array.from(document.images).slice(0,100).map(i=>({url:i.currentSrc||i.src,complete:i.complete,naturalWidth:i.naturalWidth,loading:i.loading})),imageCount:document.images.length,svgImageCount:document.querySelectorAll('svg image').length,frames:Array.from(document.querySelectorAll('iframe')).slice(0,20).map(f=>f.src)};
 });
 return summarizeBrowserDiagnostics(snapshot,idle);
}
