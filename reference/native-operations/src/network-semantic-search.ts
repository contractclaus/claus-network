// Only public catalogue fields are sent to this reviewed, self-hosted model.
export const semanticSearchRelease={
 projectId:'prj_de70d4aa-0804-4a94-8097-7a9a34f0a28a',
 releaseId:'sha256:d7b3dc015e611fa0acc0ae37ea914af91e73cce2b0a47c27b6736a99cdd51d2a',
 image:'claus-network-api.vercel.app/claus/db43bef944d0dd00414dea3ff60da6f600d6a3f4ab6693105c6dbc9ed4b8a468@sha256:c98c8f1772a206050e6ab0e70a7b00d37b02c178a1b966bd28d6edac636ff73b',
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
  docs.push({id:p.id,text:text.slice(0,2048).replace(/[\uD800-\uDBFF]$/,''),project:p});
 }
 const ranked:{id:string;score:number}[]=[],signal=AbortSignal.timeout(20000);
 for(let offset=0;offset<docs.length;){
  signal.throwIfAborted();
  const batch=docs.slice(offset,offset+15);
  const body=()=>({query,documents:batch.map(({id,text})=>({id,text})),limit:Math.min(limit,batch.length)});
  while(batch.length>1&&Buffer.byteLength(JSON.stringify(body()),'utf8')>65536)batch.pop();
  if(Buffer.byteLength(JSON.stringify(body()),'utf8')>65536)throw Error('semantic_search_request_too_large');
  const count=Math.min(limit,batch.length);
  const result=await post(endpoint,body(),signal);
  offset+=batch.length;
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
