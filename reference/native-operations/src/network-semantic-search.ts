// Only public catalogue fields are sent to this reviewed, self-hosted model.
export const semanticSearchRelease={
 projectId:'prj_de70d4aa-0804-4a94-8097-7a9a34f0a28a',
 releaseId:'sha256:ea3b4e5fcbb525931044f334f087e0b20626cdd05761160ec8b9a4c9d672d9de',
 image:'claus-network-api.vercel.app/claus/dcd63b69c0e34ace807da0077538d2b7e9f33c508b9d8b557d78b63a63d7de79@sha256:b3faaf7c3b10306693854108b3b4a55a11766921faa861077e5692c5f6ee6e35',
 model:'Xenova/all-MiniLM-L6-v2@751bff37182d3f1213fa05d7196b954e230abad9'
};
const slug=/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;
const id=/^prj_[A-Za-z0-9-]{1,120}$/;
type Dependencies={call:(name:string,input?:any)=>Promise<any>;post:(endpoint:string,body:any,signal:AbortSignal)=>Promise<any>;now?:()=>number};

export function semanticSearchEndpoint(approval:any,resources:any,now:number){
 const s=semanticSearchRelease;
 if(approval?.approved!==true||approval.releaseId!==s.releaseId||approval.projectId!==s.projectId||approval.image!==s.image)throw Error('semantic_search_release_not_approved');
 if(!Array.isArray(resources?.items)||resources.nextCursor!==null)throw Error('semantic_search_resource_discovery_incomplete');
 const active=resources.items.filter((r:any)=>r.projectId===s.projectId&&r.manifest?.releaseHash===s.releaseId&&r.desired==='running'&&r.terminal===false);
 if(active.length!==1)throw Error('semantic_search_resource_unavailable');
 const r=active[0];
 if(r.state!=='running'||r.manifest.image!==s.image||r.manifest.port!==8080||r.manifest.mode!=='model'||r.profileId!=='claus-runpod-cpu-v1'||r.requiresReconciliation===true||
  !Number.isSafeInteger(r.leaseUntil)||r.leaseUntil<=now||!Number.isSafeInteger(r.providerLeaseUntil)||r.providerLeaseUntil<=now)throw Error('semantic_search_resource_not_ready');
 if(typeof r.providerResourceId!=='string'||!/^[a-z0-9]{6,64}$/.test(r.providerResourceId))throw Error('semantic_search_endpoint_invalid');
 const endpoint='https://'+r.providerResourceId+'-8080.proxy.runpod.net';
 if(r.endpoint!==endpoint)throw Error('semantic_search_endpoint_invalid');
 return endpoint;
}

export async function semanticNetworkSearch(input:{query:string;after?:string;limit?:number},{call,post,now=Date.now}:Dependencies){
 const query=input.query?.trim(),limit=input.limit??5;
 if(!query||query.length>160||!Number.isInteger(limit)||limit<1||limit>10||input.after!==undefined&&!slug.test(input.after))throw Error('invalid_semantic_search_query');
 const s=semanticSearchRelease;
 const [approval,resources,inventory]=await Promise.all([
  call('public_resource_release',{releaseId:s.releaseId}),
  call('resource_instances',{projectId:s.projectId,limit:100}),
  call('network_overview',input.after?{after:input.after}:{})
 ]);
 const endpoint=semanticSearchEndpoint(approval,resources,now());
 if(inventory?.schemaVersion!=='claus-observation/1'||!Array.isArray(inventory.projects)||!Number.isFinite(inventory.observedAt)||
  inventory.nextCursor!==null&&!slug.test(inventory.nextCursor??''))throw Error('invalid_network_observation');
 const docs:{id:string;text:string;project:any}[]=[],seen=new Set<string>();let truncated=0;
 for(const p of inventory.projects){
  if(!id.test(p?.id??'')||!slug.test(p?.slug??'')||seen.has(p.id))throw Error('invalid_network_observation');
  seen.add(p.id);
  // No caller-supplied documents, conversations, private memory or credentials.
  const text=JSON.stringify({name:p.name,slug:p.slug,description:p.description,agents:p.agents,services:p.services,application:p.application});
  if(text.length>2048)truncated++;
  docs.push({id:p.id,text:text.slice(0,2048),project:p});
 }
 const ranked:{id:string;score:number}[]=[],signal=AbortSignal.timeout(20000);
 for(let offset=0;offset<docs.length;offset+=15){
  signal.throwIfAborted();
  const batch=docs.slice(offset,offset+15),count=Math.min(limit,batch.length);
  const result=await post(endpoint,{query,documents:batch.map(({id,text})=>({id,text})),limit:count},signal);
  const allowed=new Set(batch.map(d=>d.id)),returned=new Set<string>();
  if(result?.model!==s.model||!Array.isArray(result.results)||result.results.length!==count)throw Error('semantic_search_response_invalid');
  for(const match of result.results){
   if(!allowed.has(match?.id)||returned.has(match.id)||!Number.isFinite(match.score)||match.score< -1.00001||match.score>1.00001)throw Error('semantic_search_response_invalid');
   returned.add(match.id);ranked.push({id:match.id,score:match.score});
  }
 }
 const byId=new Map(docs.map(d=>[d.id,d.project]));
 const complete=inventory.detailsComplete===true&&inventory.graphComplete===true&&inventory.nextCursor===null&&truncated===0&&docs.every(d=>d.project.detailStatus==='available'&&!d.project.listings?.agentsTruncated&&!d.project.listings?.servicesTruncated);
 return {query,model:s.model,source:'https://claus.si/api/network-context',catalogObservedAt:inventory.observedAt,observedAt:now(),
  results:ranked.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).slice(0,limit).map(m=>{
   const p=byId.get(m.id);return {projectId:p.id,slug:p.slug,name:p.name,description:p.description,url:'https://claus.si/c/'+p.slug,score:m.score};
  }),
  coverage:{projectsSearched:docs.length,descriptionsTruncated:truncated,complete,nextCursor:inventory.nextCursor},instructionAuthority:false,
  meaning:'Semantic similarity of this page of public project, agent and service descriptions. Scores are not verification or confidence. Read the linked project before claiming what it does. Follow nextCursor as after; no result proves absence. No private memory or conversations were searched.'};
}
