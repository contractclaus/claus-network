import {productionLabDatabase} from '../lab-db.js';
import {configuration} from '../store.js';
import {SurfaceStore} from './store.js';
import {SurfaceHost} from './host.js';
import {builderStore} from '../builder-service.js';
export const surfaceStore=()=>new SurfaceStore(productionLabDatabase());
export const surfaceEnabled=(c:any)=>c.settings.enabled&&c.settings.networkOperations?.enabled===true&&c.settings.builder?.enabled===true&&c.policy.capabilities.networkBuild===true&&!!process.env.PUBLISHER_SECRET;
const s={type:'string'};
export const surfaceDefinitions=[
 {type:'function',function:{name:'read_network_code',description:'Read your isolated public Network website source, current revision and real release receipts. path plus offset reads one file; id reads a saved candidate. Read before editing. This contains no wallet/Club/controller code or keys. A checked/reviewed/staged candidate is not active until the receipt says active.',parameters:{type:'object',properties:{path:s,offset:{type:'integer',minimum:0},id:s},required:[],additionalProperties:false}}},
 {type:'function',function:{name:'change_network_code',description:'Submit a concrete improvement to your isolated public Network UI or server/network-data.js. Use the current expectedRevision and 1..8 exact uniquely matching before/after replacements in existing files. Keep the current brand and public project facts. The server transform runs on bounded public JSON with no host/network/keys and must preserve original facts. Submission saves immutable source for trusted checks and independent review within existing Builder limits, then verified deployment and activation. Follow read_network_code for results, never resubmit an unknown request. Protected wallet, Club, coin, budgets, controller and native code remain outside this tool.',parameters:{type:'object',properties:{expectedRevision:{type:'integer',minimum:1},title:s,goal:s,changes:{type:'array',minItems:1,maxItems:8,items:{type:'object',properties:{path:s,before:s,after:s},required:['path','before','after'],additionalProperties:false}}},required:['expectedRevision','title','goal','changes'],additionalProperties:false}}}
];
export async function surfaceTool(actionId:string,name:string,args:any){
 const store=surfaceStore();
 if(name==='read_network_code')return store.read(args.path,args.offset??0,args.id);
 if(!surfaceEnabled(await configuration()))throw Error('surface_disabled');
 const r=await store.propose(actionId,args,builderStore());
 const {startBuilder}=await import('../builder-life.js');await startBuilder(r.build_id);
 return {id:r.id,buildId:r.build_id,state:r.state,sourceHash:r.source_hash,published:r.state==='active',next:'read_network_code with this id'};
}
export async function monitorSurface(){
 const store=surfaceStore(),c=await store.current();if(!c?.enabled)return {state:'disabled'};
 const claimed=(await store.db.query("UPDATE claus_surface_control SET last_checked=now() WHERE id AND (last_checked IS NULL OR last_checked<now()-interval '60 seconds') RETURNING revision",[])).rows[0];
 if(!claimed)return {state:'recent'};
 const r=await store.get(c.active_id);let healthy=false;
 try{await new SurfaceHost().verify(r.deployment.url,r.id,r.source_hash,true);healthy=true;}catch{}
 const updated=(await store.db.query('UPDATE claus_surface_control SET failures=CASE WHEN $1 THEN 0 ELSE failures+1 END WHERE id AND revision=$2 AND active_id=$3 RETURNING failures',[healthy,c.revision,c.active_id])).rows[0];
 if(!healthy&&Number(updated?.failures)>=2&&c.fallback_id){
  const previous=await store.get(c.fallback_id);const proof=await new SurfaceHost().verify(previous.deployment.url,previous.id,previous.source_hash,true);
  return store.rollback(c.revision,c.active_id,{reason:'two_failed_public_health_checks',fallback:proof,at:new Date().toISOString()});
 }
 return {state:healthy?'healthy':'unavailable',id:r.id,failures:updated?.failures};
}
