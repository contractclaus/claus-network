import {digest} from './store.mjs';
const fail=c=>{throw Error('resource_procedure_'+c);};
const clean=(v,n)=>typeof v==='string'&&v.trim().length>0&&v.length<=n&&!/-----BEGIN|Bearer\s|(?:token|secret|password|api[-_]?key)\s*[=:]\s*\S{8}/i.test(v);
const name=v=>typeof v==='string'&&/^[a-z][a-z0-9-]{1,99}$/.test(v);
export const procedureInputs={procedures:['query','offset'],procedure_read:['name','revision'],procedure_save:['name','expectedRevision','summary','terms','steps','limitations','sources','status'],procedure_use:['name','revision','workId'],procedure_result:['useId','sources','assessment']};
export function managedProcedures({store,workStatus,now=Date.now}){
 const stamp=()=>new Date(now()).toISOString();
 async function evidence(ref){
  if(!ref||typeof ref!=='object'||Array.isArray(ref))fail('source_invalid');
  if(ref.kind==='endpoint'){
   if(!/^act_[a-f0-9]{24}$/.test(ref.actionId??'')||Object.keys(ref).some(k=>!['kind','actionId'].includes(k)))fail('source_invalid');
   const r=await store.get('endpoint-response',ref.actionId);if(!r)fail('source_unavailable');
   return {ref,sha256:r.digest,observedAt:r.at,outcome:r.status===202?'accepted':r.status>=200&&r.status<300?'succeeded':'failed',status:r.status};
  }
  if(ref.kind==='queue'){
   if(!/^res_[a-f0-9]{24}$/.test(ref.resourceId??'')||!/^job_[a-f0-9]{24}$/.test(ref.jobId??'')||Object.keys(ref).some(k=>!['kind','resourceId','jobId'].includes(k)))fail('source_invalid');
   const j=await store.get('job',ref.resourceId+':'+ref.jobId);if(!j||!['succeeded','failed','accepted'].includes(j.state))fail('source_unsettled');
   return {ref,sha256:digest(j.receipt),observedAt:j.receipt?.observedAt??j.updatedAt,outcome:j.state,workId:j.workId};
  }
  fail('source_invalid');
 }
 async function sources(v){if(!Array.isArray(v)||!v.length||v.length>10)fail('sources_required');const rows=[];for(const ref of v)rows.push(await evidence(ref));return rows;}
 const metadata=p=>({name:p.name,revision:p.revision,summary:p.summary,terms:p.terms,status:p.status,bodyHash:p.bodyHash,updatedAt:p.updatedAt,sourceOutcomes:p.sources.map(s=>s.outcome),instructionAuthority:false});
 async function head(id){if(!name(id))fail('name_invalid');const p=await store.get('procedure',id);if(!p)fail('not_found');return p;}
 async function call(operation,input,requestId){
  if(operation==='procedures'){
   const offset=input.offset??0;if(!Number.isSafeInteger(offset)||offset<0||input.query!==undefined&&!clean(input.query,240))fail('page_invalid');
   const p=await store.list('procedure',offset),terms=(input.query??'').toLowerCase().split(/\s+/).filter(Boolean);
   return {...p,items:p.items.filter(v=>v.status!=='retired'&&terms.every(t=>(v.name+' '+v.summary+' '+v.terms.join(' ')).toLowerCase().includes(t))).map(metadata),instructionAuthority:false};
  }
  if(operation==='procedure_read'){
   const p=await head(input.name);if(input.revision===undefined||input.revision===p.revision)return {...p,instructionAuthority:false};
   const old=await store.get('procedure-version',input.name+':'+input.revision);if(!old)fail('version_unavailable');return {...old,instructionAuthority:false,historical:true};
  }
  if(!clean(requestId,200))fail('request_invalid');
  const id='pru_'+digest(requestId).slice(0,24);
  if(operation==='procedure_save'){
   if(!name(input.name)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||!clean(input.summary,1200)||!clean(input.limitations,4000)||!['active','draft','retired'].includes(input.status)||!Array.isArray(input.terms)||!input.terms.length||input.terms.length>30||input.terms.some(t=>!clean(t,100))||!Array.isArray(input.steps)||!input.steps.length||input.steps.length>40||input.steps.some(t=>!clean(t,4000)))fail('definition_invalid');
   const before=await store.get('procedure',input.name),inputHash=digest(input);
   if(before?.lastRequestId===requestId){if(before.inputHash!==inputHash)fail('request_conflict');return before;}
   if((before?.revision??0)!==input.expectedRevision)fail('revision_conflict');
   const rows=await sources(input.sources),body={name:input.name,summary:input.summary,terms:input.terms,steps:input.steps,limitations:input.limitations,sources:rows,status:input.status};
   const value={...body,revision:input.expectedRevision+1,bodyHash:digest(body),inputHash,lastRequestId:requestId,updatedAt:stamp(),meaning:'Owner-recorded reusable procedure with actual source receipts. Activation is availability, not proof that its proposed steps succeeded.'};
   if(before){await store.put('procedure-version',before.name+':'+before.revision,before);await store.change('procedure',input.name,before.revision,value);}else{const saved=await store.put('procedure',input.name,value);if(saved.value.inputHash!==inputHash)fail('revision_conflict');}
   await store.put('procedure-version',input.name+':'+value.revision,value);return value;
  }
  if(operation==='procedure_use'){
   const previous=await store.get('procedure-use',id);if(previous){if(previous.inputHash!==digest(input))fail('request_conflict');return previous;}
   const p=await head(input.name);if(p.status!=='active'||p.revision!==input.revision||!/^nw_[a-z0-9_-]{1,80}$/.test(input.workId??'')||!['ready','working','waiting'].includes(await workStatus(input.workId)))fail('not_applicable');
   // Ensure the version survives a crash after head publication.
   await store.put('procedure-version',p.name+':'+p.revision,p);
   const value={id,workId:input.workId,procedure:p.name,revision:p.revision,bodyHash:p.bodyHash,inputHash:digest(input),recordedAt:stamp(),steps:p.steps,limitations:p.limitations,instructionAuthority:false,grantsPermissions:false};
   const saved=await store.put('procedure-use',id,value);if(saved.value.inputHash!==value.inputHash)fail('request_conflict');return saved.value;
  }
  if(operation==='procedure_result'){
   const use=await store.get('procedure-use',input.useId);if(!use||!clean(input.assessment,4000))fail('use_required');
   const rows=await sources(input.sources);
   if(rows.some(r=>!Number.isFinite(Date.parse(r.observedAt))||Date.parse(r.observedAt)<Date.parse(use.recordedAt)||r.workId&&r.workId!==use.workId))fail('fresh_matching_evidence_required');
   const value={useId:use.id,procedure:use.procedure,revision:use.revision,workId:use.workId,sources:rows,assessment:input.assessment,inputHash:digest(input),recordedAt:stamp(),meaning:'Claus assessment linked to later actual receipts; not independent proof of causality, user value or adoption.'};
   const saved=await store.put('procedure-result',use.id,value);if(saved.value.inputHash!==value.inputHash)fail('result_already_recorded');return saved.value;
  }
  fail('operation_invalid');
 }
 return {call,metadata};
}
