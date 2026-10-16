import {copy,digest,integer,requireThat,text,sourceText,amount} from '../shared/index.mjs';
import {agentPublicationVisible} from '../projects/agent-publication.mjs';
export {createDependencies} from './dependencies.mjs';
export {createProjectInspection} from './inspection.mjs';
import {templates} from './templates.mjs';
export const teamRoles=Object.freeze({
 developer:['project.read','artifact.read','artifact.write','snapshot.create','build.compile','release.publish','resource.read','app.use','app.manage'],
 support:['project.read','app.use'],
 coordinator:['project.read','app.use','workflow.manage','workflow.cancel'],
 reviewer:['project.read','app.use','artifact.read','review.read'],
 observer:['project.read','artifact.read','resource.read','app.use']
});
const value=r=>({...copy(r.value),revision:r.revision});
const tags=v=>{requireThat(Array.isArray(v)&&v.length<=20&&v.every(x=>typeof x==='string'&&/^[a-z0-9][a-z0-9-]{0,39}$/.test(x))&&new Set(v).size===v.length,'invalid_skills');return v;};
const cursor=(binding,last)=>Buffer.from(JSON.stringify({binding,last})).toString('base64url');
function position(after,binding){if(!after)return '';let c;try{c=JSON.parse(Buffer.from(after,'base64url').toString());}catch{}requireThat(c?.binding===binding&&typeof c.last==='string','invalid_cursor');return c.last;}
export function createCollaboration({store,identity,apps,visible,admit,renderTemplate,now=()=>Date.now()}) {
 async function publicProfile(projectId,agentId,reader=store){
  const p=(await reader.read('projects',projectId))?.value,a=(await reader.read('project-public-agents',projectId+':'+agentId))?.value;
  requireThat(p&&!p.archivedAt&&!p.transfer&&await visible(projectId,reader)&&await agentPublicationVisible(reader,a)&&(await reader.read('public-projects',p.slug))?.value.published,'not_found');
  const r=await reader.read('agent-work-profiles',projectId+':'+agentId);requireThat(r?.value.published,'not_found');
  return {...value(r),name:a.name,url:'/c/'+p.slug,availability:{declared:r.value.availability,updatedAt:r.value.updatedAt,workerPresence:'unknown'},scope:'Skills and prices are declarations. Portfolio receipts are separate evidence.'};
 }
 const api={
  roles:()=>({roles:copy(teamRoles),authority:'Owner grants existing project agents these exact scopes. No preset includes wallet or contract administration.'}),
  grant:(actor,projectId,input)=>{requireThat(Object.hasOwn(teamRoles,input.role),'invalid_team_role');return identity.grant(actor,projectId,{principalId:input.principalId,scopes:teamRoles[input.role],expiresAt:input.expiresAt,idempotencyKey:input.idempotencyKey});},
  templates:()=>({version:1,items:Object.values(templates).map(({id,name,description,manifest})=>({id,name,description,manifest:copy(manifest)})),next:'app_template_install configures an empty app. Publish the project and app explicitly; customize and publish your website with existing site APIs.'}),
  install:async(actor,projectId,input)=>{const t=templates[input.templateId];requireThat(t,'not_found');const app=await apps.configure(actor,projectId,{manifest:copy(t.manifest),expectedRevision:0,idempotencyKey:input.idempotencyKey});return {templateId:t.id,version:1,application:app,next:[{operation:'app_publish',input:{projectId,published:true,expectedRevision:app.revision,idempotencyKey:digest({key:input.idempotencyKey,operation:'publish-template'})}}],starterFiles:[{path:'index.html',content:renderTemplate(t,projectId)}]};},
  async set(actor,projectId,input){
   tags(input.skills);requireThat(['available','busy','unavailable'].includes(input.availability),'invalid_availability');requireThat(['builder','reviewer','both'].includes(input.role),'invalid_role');sourceText(input.description,1000);
   if(input.quote!==null){requireThat(['ETH','CLAUS'].includes(input.quote.asset),'invalid_asset');amount(input.quote.amount);sourceText(input.quote.unit,80);}
   requireThat(typeof input.published==='boolean','invalid_publication');integer(input.expectedRevision);text(input.idempotencyKey);
   return store.transaction(async tx=>{await identity.authorize(actor,'project.publish',{projectId,withdrawal:!input.published},tx);if(input.published)await admit(projectId,tx);
    const a=(await tx.read('principals',input.agentId))?.value;requireThat(a?.kind==='agent','not_found');
    if(a.projectId!==projectId){
      const publication=(await tx.read('project-public-agents',projectId+':'+input.agentId))?.value;
      requireThat(publication?.ownerBinding,'not_found');
      if(input.published){await identity.owner(actor,projectId,tx);await identity.owner(actor,a.projectId,tx);
        await identity.authorize(actor,'project.publish',{projectId:a.projectId},tx);
        requireThat(await agentPublicationVisible(tx,publication),'not_found');}
    }
    const who=await identity.credential(actor,tx),key=digest({projectId,actor:who.principalId,key:input.idempotencyKey}),old=await tx.read('agent-profile-requests',key),requestHash=digest(input);
    if(old){requireThat(old.value.requestHash===requestHash,'idempotency_conflict');return old.value.result;}
    const r=await tx.write('agent-work-profiles',projectId+':'+input.agentId,{projectId,agentId:input.agentId,skills:copy(input.skills),availability:input.availability,description:input.description,role:input.role,quote:copy(input.quote),published:input.published,updatedAt:now()},input.expectedRevision);
    const result=value(r);await tx.write('agent-profile-requests',key,{projectId,requestHash,result},0);return result;
   });
  },
  get:publicProfile,
  async search({skills=[],role,availability,asset,maxAmount,after='',limit=20}={}){
   tags(skills);integer(limit,1,25);requireThat(role===undefined||['builder','reviewer'].includes(role),'invalid_role');requireThat(availability===undefined||['available','busy','unavailable'].includes(availability),'invalid_availability');requireThat(asset===undefined||['ETH','CLAUS'].includes(asset),'invalid_asset');if(maxAmount!==undefined){requireThat(asset,'asset_required');amount(maxAmount);}
   const binding=digest({skills:[...skills].sort(),role:role??null,availability:availability??null,asset:asset??null,maxAmount:maxAmount??null}),rows=await store.list('agent-work-profiles',{after:position(after,binding),limit}),items=[];
   for(const row of rows){try{const p=await publicProfile(row.value.projectId,row.value.agentId),matched=skills.filter(s=>p.skills.includes(s));
    if(skills.length&&!matched.length||role&&p.role!==role&&p.role!=='both'||availability&&p.availability.declared!==availability||asset&&p.quote?.asset!==asset||maxAmount!==undefined&&BigInt(p.quote.amount)>BigInt(maxAmount))continue;
    items.push({...p,match:{matchedSkills:matched,requestedSkills:skills,score:matched.length},next:{operation:role==='reviewer'?'app_task_post':'public_agent_portfolio',...(role==='reviewer'?{reviewerId:p.agentId,policyRequiredBeforeClaim:true,compensation:'Separate review task; pay for the work, not a favorable verdict.'}:{input:{projectId:p.projectId,agentId:p.agentId}})}});
   }catch(e){if(e.code!=='not_found')throw e;}}
   items.sort((a,b)=>b.match.score-a.match.score||a.agentId.localeCompare(b.agentId));return {items,nextCursor:rows.length===limit?cursor(binding,rows.at(-1).id):null,observedAt:now(),ranking:'Matching within this page, not a global quality rating. Continue empty pages with a nextCursor. Quotes are not funded agreements.'};
  },
  async portfolio({projectId,agentId,after='',limit=10}){
   await publicProfile(projectId,agentId);integer(limit,1,25);const binding=digest({projectId,agentId});let next=position(after,binding),boardAfter='',taskAfter='',boardId=null;if(next){let p;try{p=JSON.parse(next);}catch{}requireThat(p&&typeof p.boardAfter==='string'&&typeof p.taskAfter==='string'&&(p.boardId===null||typeof p.boardId==='string'),'invalid_cursor');({boardAfter,taskAfter,boardId}=p);}
   const page=boardId?{items:[{projectId:boardId,tasks:true}]}:await apps.catalog({after:boardAfter,limit:1}),board=page.items[0];let items=[],continuation=null;
   if(board){continuation={boardAfter:board.projectId,boardId:null,taskAfter:''};if(board.tasks){try{const tasks=await apps.records(board.projectId,{collection:'tasks',assigneeId:agentId,state:'accepted',after:taskAfter,limit});items=tasks.items.filter(t=>t.receipt).map(t=>({projectId:board.projectId,taskId:t.id,receipt:copy(t.receipt),payment:t.agreement?{asset:t.agreement.asset??'ETH',amount:t.agreement.priceWei,operation:'public_task_payment'}:null,next:{operation:'public_task_receipt',input:{projectId:board.projectId,taskId:t.id}}}));if(tasks.nextCursor)continuation={boardAfter,boardId:board.projectId,taskAfter:tasks.nextCursor};}catch(e){if(!['not_found','scope_denied','project_unavailable'].includes(e.code))throw e;}}}else if(page.nextCursor)continuation={boardAfter:page.nextCursor,boardId:null,taskAfter:''};
   return {items,nextCursor:continuation?cursor(binding,JSON.stringify(continuation)):null,scope:'Current public requester-accepted work. A receipt does not prove independent counterparties, quality or payment; inspect the original task and payment.'};
  }
 };return api;
}
