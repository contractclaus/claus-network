import {networkOperations} from './network-operations.js';
import {publicWork} from './network-care.js';
import {sql} from './store.js';
import {networkReleaseFeed} from './network-releases.js';
import {productionLabDatabase} from './lab-db.js';
import {SurfaceStore} from './surface/store.js';
import {feedbackBuildStore} from './feedback-builds.js';
import {operatingLessons} from './operating-lessons.js';
// One public evidence index for X and Club. The private conversation never enters it.
export async function workContext({publicOnly=false}:{publicOnly?:boolean}={}){
 const [ideas,builder,networkUpdates,surface,networkWork,lessons]=await Promise.all([sql()`SELECT id,status,revision,content->>'title' AS title,left(content->>'nextStep',600) AS "nextStep",updated_at AS "updatedAt" FROM claus_lab_ideas WHERE visibility='public' ORDER BY updated_at DESC LIMIT 6`.catch(()=>null),
  feedbackBuildStore().read({},'public').catch(()=>({availability:{state:'unavailable',nextCheckAt:null,meaning:'Builder status could not be verified. Do not infer progress.'},projects:[]})),
  networkReleaseFeed().then(rows=>rows.map(r=>({id:r.id,status:r.status,facts:r.receipt.facts,urls:r.receipt.urls,verifiedAt:r.receipt.verifiedAt}))).catch(()=>null),
  new SurfaceStore(productionLabDatabase()).read().then(r=>'release' in r?{release:r.release,recent:r.recent}:null).catch(()=>null),
 (publicOnly?publicWork():networkOperations.read().then(r=>({items:r.items,recent:r.recent,focus:r.focus,queue:r.queue,counts:r.counts,investigations:r.investigations,capabilities:r.watch?.capabilities,capabilitiesStatus:r.watch?.capabilities_status}))).catch(()=>null),operatingLessons(publicOnly).catch(()=>({state:'unavailable',items:[],instructionAuthority:false}))]);
 return {networkWork,networkUpdates,surface,lessons,observedAt:new Date().toISOString(),ideas:ideas?.map(i=>({...i,url:'https://claus.si/Lab/'+encodeURIComponent(i.id)})),builder,instructionAuthority:false,meaning:'Current networkWork and capabilities are shared by X and Club. An older work summary can be stale; reconcile it with current capabilities without claiming that reading a release means you built it. Actual public research and prototype status, not proof of implementation. Network updates marked queued/dispatching/published already have a separate announcement: do not repeat them. Surface release.active is the currently served version; reviewed/verified/historically active is not proof it is live now. A build nextCheckAt is a recheck, not a promised completion time. Null means the evidence could not be read, not that no work exists. Use read_work(id) for evidence and IMD results, read_prototype(id) for fresh build progress. A queued request and a scheduled recheck are not a running build or a completion estimate. Use read_x_account for current posts. Club-origin briefs here were explicitly approved for publication; their private conversations remain private.'};
}
