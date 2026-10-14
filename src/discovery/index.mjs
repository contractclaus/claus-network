import {copy,digest,integer,requireThat} from '../shared/index.mjs';

// Live projections, not a second registry. Each page has a fixed scan budget;
// callers continue until nextCursor=null before interpreting absence.
export function createDiscovery({store,projects,apps,services,now=()=>Date.now()}) {
  return {async operations(){
    const roles=['compile','review','controller','executor','services','wallets','vaults','workflows','domains','workers','deals'];
    const rows=await store.readMany('worker-health',roles),at=now();
    return {observedAt:at,workers:roles.map(role=>{const v=rows.get(role)?.value,age=Number.isFinite(v?.observedAt)?Math.max(0,at-v.observedAt):null;return {role,lastObservedAt:v?.observedAt??null,ageMs:age,status:age===null?'unknown':age<300000?'recent':'stale',release:v?.release??null,...(role==='workflows'?{lastBatch:v?{processed:v.processed??null,durationMs:v.durationMs??null,retries:v.retryCount??null}:null}:{})};}),scope:'Last host worker observations, not user-agent presence, independent uptime certification or an end-to-end SLA.'};
  },async search({kind='project',query='',after='',limit=20,state}={}) {
    requireThat(['project','app','service','agent','task'].includes(kind),'invalid_discovery_kind');
    requireThat(typeof query==='string'&&query.length<=120,'invalid_query');integer(limit,1,25);
    requireThat(state===undefined||kind==='task'&&['open','claimed','submitted','accepted','cancelled'].includes(state),'invalid_discovery_state');
    const taskState=kind==='task'?(state??'open'):null;
    const needle=query.trim().toLocaleLowerCase('en'),binding=digest({kind,needle,...(kind==='task'?{state:taskState}:{})});let position='',resume=null;
    if(after){let c;try{c=JSON.parse(Buffer.from(after,'base64url').toString());}catch{}requireThat(c?.binding===binding&&typeof c.position==='string','invalid_cursor');position=c.position;if(c.board!==undefined){requireThat(kind==='task'&&typeof c.board==='string'&&typeof c.taskAfter==='string','invalid_cursor');resume=c;}}
    const match=value=>!needle||JSON.stringify(value).toLocaleLowerCase('en').includes(needle);
    let candidates=[],next=null,scanned=0;
    if(kind==='task'){
      const page=resume?{items:[{projectId:resume.board,tasks:true}]}:await apps.catalog({after:position,limit:1});
      const board=page.items[0];
      if(!board){next=page.nextCursor??null;}
      else{
        next=board.projectId;
        if(board.tasks){
          try{
            const records=await apps.records(board.projectId,{collection:'tasks',state:taskState,after:resume?.taskAfter??'',limit});
            scanned=records.items.length;const project=(await store.read('projects',board.projectId))?.value;
            const url=project?.slug?'/c/'+project.slug:null;
            candidates=records.items.map(t=>({kind,id:t.id,projectId:board.projectId,name:typeof t.input?.title==='string'?t.input.title:'Task',description:typeof t.input?.brief==='string'?t.input.brief.slice(0,500):'',category:t.input?.category??null,
              url:url?url+'#task='+encodeURIComponent(t.id):null,version:t.revision,authorId:t.authorId,assigneeId:t.assigneeId??null,
              availability:{state:t.state,claimExpiresAt:t.agreement?null:t.leaseUntil??null},price:t.agreement?{amount:t.agreement.priceWei,asset:t.agreement.asset??'ETH',scope:'bound agreement; read live funding'}:null,
              evidence:t.receipt?{type:'requester-acceptance',receipt:copy(t.receipt),independentSecurityReview:false}:{type:'public-task',claimOnly:true},
              next:{operation:'public_task_progress',input:{projectId:board.projectId,taskId:t.id}},updatedAt:t.updatedAt}));
            if(records.nextCursor)return {items:candidates.filter(match),nextCursor:Buffer.from(JSON.stringify({binding,position,board:board.projectId,taskAfter:records.nextCursor})).toString('base64url'),observedAt:now(),scanLimit:limit,complete:false,scope:'Public task records. No agreement means payment is not established; a posted offer is not funded work.'};
          }catch(e){if(!['not_found','project_unavailable','scope_denied'].includes(e.code))throw e;}
        }
      }
    }else if(kind==='project'){
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
        next:{operation:'service_quote',requiredInput:['projectId','serviceId','input','idempotencyKey']},
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
