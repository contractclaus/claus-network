import { canonical, copy, digest, integer, requireThat, sourcePath, sourceText, text } from '../shared/index.mjs';

export function createContentAdmin({store,identity,artifacts,now=()=>Date.now(),origin='https://claus-network-sites.vercel.app'}) {
  async function operator(actor,reader=store,action='inspect',ownerOnly=false){
    const who=await identity.credential(actor,reader),p=(await reader.read('principals',who.principalId))?.value,a=(await reader.read('network','authority'))?.value;
    if(who.kind==='owner'&&p?.chainId===1&&p.address===a?.ownerAddress)return who.principalId;
    const grant=(await reader.read('content-operators',who.principalId))?.value;
    requireThat(!ownerOnly&&who.kind==='owner'&&grant?.active&&(grant.expiresAt===null||grant.expiresAt>now())&&grant.scopes.includes(action),'scope_denied');return who.principalId;
  }
  const reasonCheck=reason=>requireThat(typeof reason==='string'&&reason.trim().length>0&&reason.length<=500,'invalid_reason');
  async function audit(tx,actorId,projectId,action,key,value){const id=digest({actorId,projectId,action,key}),old=await tx.read('content-audit',id);if(old){const {id:ignored,projectId:p,actorId:a,action:t,at,...recorded}=old.value;requireThat(digest(recorded)===digest(value),'idempotency_conflict');}else await tx.write('content-audit',id,{id,projectId,actorId,action,at:now(),...copy(value)},0);return id;}
  return {
    authorize:operator,
    async grant(actor,{principalId,active,scopes,expiresAt,expectedRevision,reason}) {
      reasonCheck(reason);requireThat(typeof active==='boolean'&&Array.isArray(scopes)&&scopes.length<=3&&scopes.every(x=>['inspect','moderate','publish'].includes(x))&&new Set(scopes).size===scopes.length,'invalid_operator_grant');
      requireThat(expiresAt===null||Number.isSafeInteger(expiresAt)&&expiresAt>now(),'invalid_operator_expiry');
      return store.transaction(async tx=>{const op=await operator(actor,tx,'inspect',true);const principal=(await tx.read('principals',principalId))?.value;requireThat(principal?.address&&principal.chainId===1,'not_found');
        const before=await tx.read('content-operators',principalId),saved=await tx.write('content-operators',principalId,{principalId,active,scopes,expiresAt},expectedRevision);
        await audit(tx,op,'network','grant',principalId+':'+saved.revision,{reason,before,after:saved});return {...saved.value,revision:saved.revision};});
    },
    visible:async(projectId,reader=store)=>!(await reader.read('content-controls',projectId))?.value.held,
    async control(actor,projectId,{held,releaseId,reason,expectedRevision,idempotencyKey}){reasonCheck(reason);text(idempotencyKey);integer(expectedRevision);requireThat(typeof held==='boolean'&&(releaseId===null||typeof releaseId==='string'),'invalid_content_control');return store.transaction(async tx=>{
      const op=await operator(actor,tx,'publish');requireThat(await tx.read('projects',projectId),'not_found');
      const hash=digest({held,releaseId,reason,expectedRevision}),key=digest({projectId,op,idempotencyKey,action:'control'}),oldRequest=await tx.read('content-requests',key);
      if(oldRequest){requireThat(oldRequest.value.hash===hash,'idempotency_conflict');return oldRequest.value.result;}
      if(releaseId!==null){const release=(await tx.read('project-releases',releaseId))?.value,pub=(await tx.read('release-publications',releaseId))?.value;requireThat(release?.projectId===projectId&&pub?.published&&pub.expiresAt>now(),'not_found');}
      const old=await tx.read('content-controls',projectId),value={held,releaseId,reason,actorId:op,updatedAt:now()};
      const saved=await tx.write('content-controls',projectId,value,expectedRevision),result={projectId,...saved.value,revision:saved.revision};
      await audit(tx,op,projectId,'control',idempotencyKey,{reason,before:old,after:result});await tx.write('content-requests',key,{hash,result},0);await tx.event({type:'content.moderated',projectId,held,at:now()});return result;
    });},
    async inspect(actor,projectId,{kind,id,after='',reason,idempotencyKey}){reasonCheck(reason);text(idempotencyKey);requireThat(['profile','release','snapshot','audit'].includes(kind),'invalid_content_kind');return store.transaction(async tx=>{
      const op=await operator(actor,tx);requireThat(await tx.read('projects',projectId),'not_found');await audit(tx,op,projectId,'inspect',idempotencyKey,{kind,id:id??null,reason,after});
      if(kind==='profile')return {project:(await tx.read('projects',projectId)).value,control:await tx.read('content-controls',projectId)};
      if(kind==='audit')return tx.list('content-audit',{projectId,after,limit:50});
      const value=(await tx.read(kind==='release'?'project-releases':'snapshots',kind==='release'?text(id):digest({projectId,id:text(id)})))?.value;requireThat(value?.projectId===projectId,'not_found');
      if(kind==='release')return {...value,files:await artifacts.get(projectId,value.contentHash,tx)};
      const files=[];for(const entry of value.files)files.push((await tx.read('artifacts',digest({projectId,id:entry.hash}))).value);return {...value,files};
    });},
    async correct(actor,projectId,{files,reason,expectedRevision,idempotencyKey}){reasonCheck(reason);text(idempotencyKey);integer(expectedRevision);requireThat(Array.isArray(files)&&files.length>0&&files.length<=32,'invalid_files');
      const clean=files.map(f=>{requireThat(Object.keys(f).length===2,'invalid_file');const path=sourcePath(f.path),content=sourceText(f.content,48000);requireThat(/\.(html|css|js|json|svg)$/.test(path)&&Buffer.byteLength(content)<=48000,'invalid_file');return {path,content,hash:digest({path,content})};}).sort((a,b)=>a.path.localeCompare(b.path,'en'));
      requireThat(clean.some(f=>f.path==='index.html')&&new Set(clean.map(f=>f.path)).size===clean.length&&Buffer.byteLength(canonical(clean))<=192000,'invalid_release_files');
      return store.transaction(async tx=>{const op=await operator(actor,tx,'publish');requireThat(await tx.read('projects',projectId),'not_found');const key=digest({projectId,op,idempotencyKey,action:'correct'}),hash=digest({clean,reason,expectedRevision}),prior=await tx.read('content-requests',key);if(prior){requireThat(prior.value.hash===hash,'idempotency_conflict');return prior.value.result;}
        const old=await tx.read('content-controls',projectId);requireThat((old?.revision??0)===expectedRevision,'revision_conflict');const usage=await tx.read('content-capacity',projectId);requireThat((usage?.value.count??0)<32,'capacity_reached');
        const releaseId=digest({projectId,key,hash}),contentHash=await artifacts.put(tx,projectId,clean),expiresAt=now()+30*86400000;
        await tx.write('project-releases',releaseId,{id:releaseId,projectId,snapshotId:null,contentHash,paths:clean.map(f=>f.path),createdAt:now(),isolation:'opaque-origin-static-v1',url:origin+'/r/'+releaseId.slice(7)+'/index.html',administration:{actorId:op,reason}},0);
        await tx.write('release-publications',releaseId,{projectId,published:true,expiresAt,updatedAt:now()},0);await tx.write('project-public-releases',projectId+':'+releaseId,{releaseId,published:true,expiresAt},0);
        const control=await tx.write('content-controls',projectId,{held:old?.value.held??false,releaseId,actorId:op,reason,updatedAt:now()},expectedRevision);
        const result={projectId,releaseId,expiresAt,revision:control.revision,held:control.value.held};await audit(tx,op,projectId,'correct',idempotencyKey,{reason,before:old,after:result});await tx.write('content-capacity',projectId,{count:(usage?.value.count??0)+1},usage?.revision??0);await tx.write('content-requests',key,{hash,result},0);return result;
      });}
  };
}
