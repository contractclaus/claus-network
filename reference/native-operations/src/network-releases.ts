import {managedDatabase,managedSchemaReady} from './database-schema.js';
import {sql,once,configuration,journal,actionProgress,ConfirmedFailure} from './store.js';
import {digest,publicChannelBlocked,type Configuration} from './config.js';
import {validatePost,verifyX,xRequest} from './x.js';

// The authenticated operator attests releases. The separate native work lane
// can queue a completed, publicly evidenced work update; project text has no enqueue authority.
export type NetworkRelease={id:string;text:string;sourceHash:string;verifiedAt:string;urls:string[];facts:string[]};
export function validateNetworkRelease(value:unknown,now=Date.now()):NetworkRelease {
 const v=value as NetworkRelease;
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['id','text','sourceHash','verifiedAt','urls','facts'].includes(k))
   ||!/^network-[a-z0-9-]{1,90}$/.test(v.id)||!/^[a-f0-9]{64}$/.test(v.sourceHash)
   ||typeof v.verifiedAt!=='string'||!Number.isFinite(Date.parse(v.verifiedAt))||Date.parse(v.verifiedAt)>now+60000||Date.parse(v.verifiedAt)<now-86400000
   ||!Array.isArray(v.urls)||v.urls.length<1||v.urls.length>8||!Array.isArray(v.facts)||v.facts.length<1||v.facts.length>12
   ||v.facts.some(f=>typeof f!=='string'||!f.trim()||f.length>600))throw Error('network_release_invalid');
 for(const raw of v.urls){let u:URL;try{u=new URL(raw);}catch{throw Error('network_release_invalid');}if(u.protocol!=='https:'||u.hostname!=='claus.si'||u.username||u.password||u.port||u.hash||u.search||raw.length>400)throw Error('network_release_invalid');}
 validatePost(v.text,[],'original');if(v.text.length>1600)throw Error('network_release_invalid');return v;
}
export function announcementsEnabled(c:Configuration){return !!(c.settings.enabled&&c.policy.capabilities.xPublish&&!publicChannelBlocked(c.policy,'publish_post')&&c.policy.rules.some(r=>r.id==='network-release-announcements'&&r.enabled));}
export function createNetworkReleaseQueue({db=sql,config=configuration,publish=xRequest,account=verifyX,reserve=once,progress=actionProgress,log=journal}={}){
let initialized:Promise<unknown>|undefined;
function initializeNetworkReleases(){if(managedDatabase())return managedSchemaReady();return initialized??=db()`CREATE TABLE IF NOT EXISTS claus_network_releases(id text PRIMARY KEY,hash text NOT NULL,receipt jsonb NOT NULL,status text NOT NULL DEFAULT 'queued',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`.catch(e=>{initialized=undefined;throw e;});}
async function enqueueNetworkRelease(input:unknown){
 const receipt=validateNetworkRelease(input);await initializeNetworkReleases();
 await db()`INSERT INTO claus_network_releases(id,hash,receipt) VALUES(${receipt.id},${digest(receipt)},${JSON.stringify(receipt)}::jsonb) ON CONFLICT(id) DO NOTHING`;
 const [row]=await db()`SELECT * FROM claus_network_releases WHERE id=${receipt.id}`;if(row.hash!==digest(receipt))throw Error('network_release_conflict');return row;
}
async function withdrawNetworkRelease(id:string){await initializeNetworkReleases();const [row]=await db()`UPDATE claus_network_releases SET status='withdrawn',updated_at=now() WHERE id=${id} AND status='queued' RETURNING id,status`;if(!row)throw Error('network_release_not_queued');return row;}
async function networkReleaseFeed(publicOnly=false){
 await initializeNetworkReleases();return db()`SELECT r.id,r.receipt,r.status,r.updated_at,a.result FROM claus_network_releases r LEFT JOIN claus_actions a ON a.id='x_network_release_'||r.id WHERE (NOT ${publicOnly} OR r.status='published') ORDER BY r.created_at DESC LIMIT 30`;
}
async function networkReleasePending(){await initializeNetworkReleases();const rows=await db()`SELECT id FROM claus_network_releases WHERE status IN ('queued','dispatching') LIMIT 1`;return rows.length>0;}
async function publishNextNetworkRelease(){
 await initializeNetworkReleases();
 // Reconciliation owns uncertain sends. Never create a replacement action ID.
 await db()`UPDATE claus_network_releases r SET status=CASE WHEN a.status='completed' THEN 'published' ELSE 'blocked' END,updated_at=now() FROM claus_actions a WHERE a.id='x_network_release_'||r.id AND r.status='dispatching' AND a.status IN ('completed','failed')`;
 if(!announcementsEnabled(await config()))return {published:false};
 const verifiedAccount=await account();
 const [row]=await db()`UPDATE claus_network_releases SET status='dispatching',updated_at=now() WHERE id=(SELECT id FROM claus_network_releases WHERE status IN ('queued','dispatching') ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`;
 if(!row)return {published:false};
 const receipt=row.receipt as NetworkRelease,id='x_network_release_'+receipt.id;
 try{
  const result:any=await reserve(id,'x_post',{text:receipt.text,networkReleaseId:receipt.id,receiptHash:row.hash},async()=>{
   if(!announcementsEnabled(await config()))throw new ConfirmedFailure('publication_disabled');
   const r=await publish('tweets','POST',{text:receipt.text},undefined,id);if(!/^\d{1,19}$/.test(r.data?.id??''))throw Error('x_post_response_missing');
   await progress(id,{result:r});await log('x_post','Published a verified network release',{postId:r.data.id,account:verifiedAccount.username,networkReleaseId:receipt.id,sourceHash:receipt.sourceHash});return r;
  });
  await db()`UPDATE claus_network_releases SET status='published',updated_at=now() WHERE id=${receipt.id}`;return {published:true,postId:result.data.id,releaseId:receipt.id};
 }catch(e){if(e instanceof ConfirmedFailure)await db()`UPDATE claus_network_releases SET status='blocked',updated_at=now() WHERE id=${receipt.id}`;throw e;}
}

return {initializeNetworkReleases,enqueueNetworkRelease,withdrawNetworkRelease,networkReleaseFeed,networkReleasePending,publishNextNetworkRelease};
}
export const {initializeNetworkReleases,enqueueNetworkRelease,withdrawNetworkRelease,networkReleaseFeed,networkReleasePending,publishNextNetworkRelease}=createNetworkReleaseQueue();
