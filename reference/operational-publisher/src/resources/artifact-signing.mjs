import {createHash,generateKeyPairSync,createPrivateKey,createPublicKey,sign} from 'node:crypto';
import {digest,sameValue} from './store.mjs';
const fail=c=>{throw Error('resource_artifact_'+c);};
export const artifactInputs={artifact_signer:[],artifact_signer_state:['expectedRevision','enabled'],artifact_sign:['resourceId','objectId','buildResourceId','buildActionId','version','workId']};
export function artifactSigning({store,seal,open,workStatus,invoke,now=Date.now}){
 const stamp=()=>new Date(now()).toISOString();const visible=k=>k?{publicKey:k.publicKey,fingerprint:k.fingerprint,enabled:k.enabled,revision:k.revision,algorithm:'Ed25519',use:'Claus owned artifact provenance only; no OS vendor certificate or store approval'}:{configured:false};
 async function key(){let k=await store.get('artifact-key','v1');if(!k){const pair=generateKeyPairSync('ed25519'),publicKey=pair.publicKey.export({type:'spki',format:'pem'}),privateKey=pair.privateKey.export({type:'pkcs8',format:'pem'});k=(await store.put('artifact-key','v1',{revision:1,enabled:true,publicKey,fingerprint:createHash('sha256').update(publicKey).digest('hex'),sealed:seal(privateKey,'artifact-key:v1'),createdAt:stamp()})).value;}if(!k.enabled)fail('signer_disabled');return k;}
 return {async call(operation,input,requestId){
  if(operation==='artifact_signer')return visible(await store.get('artifact-key','v1'));
  if(operation==='artifact_signer_state'){const k=await store.get('artifact-key','v1');if(!k||k.revision!==input.expectedRevision||typeof input.enabled!=='boolean')fail('revision_invalid');const next={...k,enabled:input.enabled,revision:k.revision+1};await store.change('artifact-key','v1',k.revision,next);return visible(next);}
  if(!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/.test(input.version??'')||!['ready','working','waiting'].includes(await workStatus(input.workId)))fail('active_work_and_version_required');
  if(typeof requestId!=='string'||!requestId||requestId.length>200)fail('request_invalid');
  const id='act_'+digest(['artifact-sign',requestId]).slice(0,24),prior=await store.get('action',id);if(prior&&(prior.operation!==operation||!sameValue(prior.input,input)))fail('request_conflict');if(prior?.output)return prior.output;
  const [r,o]=await Promise.all([store.get('resource',input.resourceId),store.get('object',input.objectId)]);
  if(r?.provider!=='r2'||r.status==='removed'||o?.resourceId!==r.id||o.state!=='ready'||!o.verifiedAt||!o.sha256||o.expiresAt&&Date.parse(o.expiresAt)<=now())fail('verified_owned_object_required');
  const b=await invoke('build_info',{resourceId:input.buildResourceId,actionId:input.buildActionId});
  if(b.conclusion!=='success'||b.attempt!==1)fail('successful_original_build_required');
  const k=await key(),statement={schema:'claus-artifact-signature-v1',resourceId:r.id,objectId:o.id,name:o.name,bytes:o.bytes,sha256:o.sha256,version:input.version,build:{resourceId:input.buildResourceId,actionId:b.actionId,runId:b.runId,sourceCommit:b.sourceCommit,workflowCommit:b.workflowCommit},signerFingerprint:k.fingerprint,issuedAt:stamp(),meaning:'Owner-attested association with this successful build. Object integrity is verified; build output equivalence requires separate artifact comparison.'};
  const a=prior??(await store.begin(id,operation,input,{statement})).row.result;const payload=JSON.stringify(a.prepared.statement),signature=sign(null,Buffer.from(payload),createPrivateKey(open(k.sealed,'artifact-key:v1'))).toString('base64');
  return store.complete(id,{id,statement:a.prepared.statement,payload,signature,algorithm:'Ed25519',signer:visible(k)});
 }};
}
