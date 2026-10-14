import {copy,digest,integer,requireThat} from '../shared/index.mjs';

// Live projections, not a second registry. Each page has a fixed scan budget;
// callers continue until nextCursor=null before interpreting absence.
export function createDiscovery({store,projects,apps,services,now=()=>Date.now()}) {
  return {async operations(){
    const roles=['compile','review','controller','executor','services','wallets','vaults','workflows','domains','workers'];
    const rows=await store.readMany('worker-health',roles),at=now();
    return {observedAt:at,workers:roles.map(role=>{const v=rows.get(role)?.value,age=Number.isFinite(v?.observedAt)?Math.max(0,at-v.observedAt):null;return {role,lastObservedAt:v?.observedAt??null,ageMs:age,status:age===null?'unknown':age<300000?'recent':'stale',release:v?.release??null,...(role==='workflows'?{lastBatch:v?{processed:v.processed??null,durationMs:v.durationMs??null,retries:v.retryCount??null}:null}:{})};}),scope:'Last host worker observations, not user-agent presence, independent uptime certification or an end-to-end SLA.'};
  },async search({kind='project',query='',after='',limit=20}={}) {
    requireThat(['project','app','service','agent'].includes(kind),'invalid_discovery_kind');
    requireThat(typeof query==='string'&&query.length<=120,'invalid_query');integer(limit,1,25);
    const needle=query.trim().toLocaleLowerCase('en'),binding=digest({kind,needle});let position='';
    if(after){let c;try{c=JSON.parse(Buffer.from(after,'base64url').toString());}catch{}requireThat(c?.binding===binding&&typeof c.position==='string','invalid_cursor');position=c.position;}
    const match=value=>!needle||JSON.stringify(value).toLocaleLowerCase('en').includes(needle);
    let candidates=[],next=null,scanned=0;
    if(kind==='project'){
      const page=await projects.graph({view:'projects',after:position,limit});next=page.nextCursor;scanned=limit;
      candidates=page.nodes.filter(n=>n.kind==='project').map(n=>({kind,id:n.id,projectId:n.id,name:n.label,description:n.description,url:n.href,version:n.revision,
        availability:{state:'published',scope:'project profile'},price:null,evidence:{type:'owner-published',claimOnly:true}}));
    } else if(kind==='app'){
      const page=await apps.catalog({after:position,limit});next=page.nextCursor;scanned=limit;
      candidates=page.items.map(a=>({...a,kind,id:a.projectId,availability:{state:'published',scope:'managed application',participation:a.participation},
        price:{amount:'0',scope:'managed app operations',asset:null},evidence:{type:'published-schema',claimOnly:true}}));
    } else if(kind==='service'){
      const page=await services.discovery({after:position,limit});next=page.nextCursor;scanned=limit;
      candidates=page.services.map(s=>({kind,id:s.id,projectId:s.projectId,name:s.manifest.name,capability:s.manifest.capability,version:s.manifest.version,
        price:{amount:s.manifest.priceWei,asset:'native',chainId:11155111,scope:'published provider price; obtain an exact current quote'},
        availability:{state:s.state,validUntil:s.manifest.validUntil,workerPresence:'unknown'},
        evidence:{type:'transport-and-schema',compatibility:copy(s.compatibility??null),independentSecurityReview:false}}));
    } else {
      const page=await projects.publicAgents({after:position,limit});next=page.nextCursor;scanned=limit;
      candidates=page.items.map(a=>({...a,kind,version:a.revision,availability:{state:'published-profile',workerPresence:'unknown'},price:null,
        evidence:{type:'project-owner-published',claimOnly:true}}));
    }
    return {items:candidates.filter(match),nextCursor:next?Buffer.from(JSON.stringify({binding,position:next})).toString('base64url'):null,
      observedAt:now(),scanLimit:scanned,complete:next===null,scope:'Public declarations and scoped evidence. Publication does not prove an active worker, accuracy, independence or safety.'};
  }};
}
