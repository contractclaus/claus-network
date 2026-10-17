import {createHash,createHmac} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {privateContextKey} from './private-context.mjs';

const publicRepository='contractclaus/claus-network';
const privateRepository='contractclaus/claus-private-builds';
const repositoryFor=c=>c?.privateSource===true?privateRepository:publicRepository;
const maxImageFor=c=>c?.privateSource===true?134217728:33554432;
const workflow='claus-oci.yml';
const hash=/^sha256:[a-f0-9]{64}$/;
const check=(v,c)=>{if(!v)throw Error('oci_'+c);};
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const sha=v=>createHash('sha256').update(v).digest('hex');

// Read one bounded receipt from an Actions ZIP without extracting any path.
export function receiptFromZip(bytes){
  check(Buffer.isBuffer(bytes)&&bytes.length<=65536,'receipt_archive_size');
  let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50){end=i;break;}
  check(end>=0&&bytes.readUInt16LE(end+10)===1,'receipt_archive_invalid');
  const at=bytes.readUInt32LE(end+16);check(at+46<=end&&bytes.readUInt32LE(at)===0x02014b50,'receipt_archive_invalid');
  const flags=bytes.readUInt16LE(at+8),method=bytes.readUInt16LE(at+10),size=bytes.readUInt32LE(at+20),rawSize=bytes.readUInt32LE(at+24),nameSize=bytes.readUInt16LE(at+28),offset=bytes.readUInt32LE(at+42);
  check(!(flags&1)&&[0,8].includes(method)&&size<=16384&&rawSize<=16384&&bytes.subarray(at+46,at+46+nameSize).toString()==='receipt.json','receipt_archive_invalid');
  check(offset+30<=at&&bytes.readUInt32LE(offset)===0x04034b50,'receipt_archive_invalid');
  const start=offset+30+bytes.readUInt16LE(offset+26)+bytes.readUInt16LE(offset+28);
  check(start+size<=at,'receipt_archive_invalid');const zipped=bytes.subarray(start,start+size);
  const raw=method===8?inflateRawSync(zipped,{maxOutputLength:16384}):zipped;check(raw.length===rawSize,'receipt_archive_invalid');return JSON.parse(raw.toString());
}

export function createOciBroker({token=()=>process.env.CLAUS_GITHUB_TOKEN,secret=()=>process.env.CLAUS_OCI_NETWORK_SECRET,config=()=>JSON.parse(process.env.CLAUS_OCI_RUNNER??'null'),request=fetch,ledger,now=()=>Date.now()}){
  async function body(r,max=1000000){const reader=r.body.getReader(),parts=[];let size=0;try{for(;;){const p=await reader.read();if(p.done)break;size+=p.value.length;check(size<=max,'provider_response_size');parts.push(p.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}return Buffer.concat(parts);}
  async function api(path,method='GET',data){
    check(token(),'not_configured');const r=await request('https://api.github.com'+path,{method,redirect:'manual',signal:AbortSignal.timeout(15000),headers:{authorization:'Bearer '+token(),accept:'application/vnd.github+json','x-github-api-version':'2022-11-28','user-agent':'contractclaus',...(data?{'content-type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});
    check(r.ok,'provider_'+r.status);return r.status===204?null:JSON.parse((await body(r)).toString());
  }
  function settings(work){const all=config(),c=work?.visibility==='private'?all?.private:all;check(c&&/^[a-f0-9]{40}$/.test(c.sha??'')&&/^claus-oci-v[0-9]+-[a-z0-9-]+$/.test(c.ref??''),'not_configured');return {...c,...(work?.visibility==='private'?{privateSource:true}:{})};}
  async function receiptFile(artifact,c){
    const repository=repositoryFor(c);
    check(hash.test(artifact.digest??'')&&artifact.size_in_bytes<=65536,'receipt_metadata_invalid');
    const r=await request('https://api.github.com/repos/'+repository+'/actions/artifacts/'+artifact.id+'/zip',{redirect:'manual',signal:AbortSignal.timeout(15000),headers:{authorization:'Bearer '+token(),accept:'application/vnd.github+json'}});
    check(r.status===302,'receipt_redirect_missing');const u=new URL(r.headers.get('location'));
    check(u.protocol==='https:'&&!u.username&&!u.password&&['.blob.core.windows.net','.githubusercontent.com'].some(s=>u.hostname.endsWith(s)),'receipt_redirect_invalid');
    const data=await request(u,{redirect:'error',signal:AbortSignal.timeout(15000)});check(data.ok,'receipt_unavailable');const bytes=await body(data,65536);
    check('sha256:'+sha(bytes)===artifact.digest,'receipt_hash_mismatch');return receiptFromZip(bytes);
  }
  function signed(work,result){
    const observationProof=createHmac('sha256',secret()).update(canonical({work,result})).digest('hex');
    // Retain the old receipt proof while the API deployment transitions.
    return {...result,observationProof,...(result.receipt?{proof:createHmac('sha256',secret()).update(canonical({receipt:result.receipt,runUrl:result.runUrl})).digest('hex')}:{})};
  }
  async function inspect(work){
    const key='oci:'+sha(work.id),prior=await ledger.get(key),checkpoint=prior?.result;
    if(!prior)return {buildId:work.id,state:'not_started'};
    if(checkpoint?.work)check(canonical(checkpoint.work)===canonical(work),'request_changed');
    if(checkpoint?.completed)return checkpoint.completed;
    if(checkpoint?.phase==='prepared')return {buildId:work.id,state:'not_started'};
    // Recovery uses the original runner even if current admission is disabled
    // or its configuration is unavailable. Legacy unknown intents stay unknown.
    const c=checkpoint?.runner??settings(work),repository=repositoryFor(c);
    const page=Number.isSafeInteger(checkpoint?.searchPage)?checkpoint.searchPage:1;
    const since=checkpoint?.createdAt?'&created='+encodeURIComponent('>='+new Date(checkpoint.createdAt-60000).toISOString()):'';
    const runs=checkpoint?.runId?{workflow_runs:[await api('/repos/'+repository+'/actions/runs/'+checkpoint.runId)]}:await api('/repos/'+repository+'/actions/workflows/'+workflow+'/runs?event=workflow_dispatch&head_sha='+c.sha+'&per_page=100&page='+page+since);
    const matches=(runs.workflow_runs??[]).filter(r=>r.display_title==='Claus OCI '+work.id&&r.head_sha===c.sha&&r.event==='workflow_dispatch');
    check(matches.length<=1,'duplicate_execution');
    if(!matches.length){
      if(checkpoint)await ledger.checkpoint(key,{...checkpoint,searchPage:(runs.workflow_runs??[]).length===100&&page<10?page+1:1});
      return {buildId:work.id,state:'unknown',error:'oci_dispatch_outcome_unknown'};
    }
    const run=matches[0];
    check(run.run_attempt===1&&run.repository?.full_name===repository,'runner_mismatch');
    const saved={...checkpoint,runId:run.id};
    if(!checkpoint?.runId&&checkpoint)await ledger.checkpoint(key,saved);
    const result={buildId:work.id,state:run.status==='completed'?'failed':'running',runUrl:run.html_url};
    const finish=async completed=>{if(checkpoint)await ledger.complete(key,{...saved,completed});return completed;};
    if(run.status!=='completed')return result;
    if(run.conclusion!=='success')return finish({...result,error:'oci_runner_'+run.conclusion});
    const list=await api('/repos/'+repository+'/actions/runs/'+run.id+'/artifacts?per_page=100');
    const receipts=(list.artifacts??[]).filter(a=>a.name==='oci-receipt'),archives=(list.artifacts??[]).filter(a=>a.name==='oci-image');
    const expired=a=>a.expired===true||(a.expires_at&&Date.parse(a.expires_at)<=now());
    if([...receipts,...archives].some(expired))return finish({...result,error:'oci_result_expired'});
    if(receipts.length!==1||archives.length!==1){
      // Allow artifact indexing to settle, but do not hold a completed job forever.
      if(Date.parse(run.updated_at)+300000<=now())return finish({...result,error:'oci_result_unavailable'});
      return {...result,state:'running',error:'oci_artifacts_pending'};
    }
    const receipt=await receiptFile(receipts[0],c),archive=archives[0];
    check(receipt.buildId===work.id&&receipt.projectId===work.projectId&&receipt.planId===work.planId&&receipt.sourceHash===work.sourceHash&&receipt.runId===String(run.id)&&receipt.runnerSha===c.sha&&receipt.evidence==='compiled_only','receipt_binding_mismatch');
    check(hash.test(receipt.imageDigest)&&hash.test(receipt.archiveHash)&&Number.isSafeInteger(receipt.archiveBytes)&&receipt.archiveBytes>0&&receipt.archiveBytes<=maxImageFor(c)&&Number.isSafeInteger(archive.id)&&archive.id>0&&hash.test(archive.digest??'')&&archive.size_in_bytes>0&&archive.size_in_bytes<=maxImageFor(c)+65536&&Number.isFinite(Date.parse(archive.expires_at)),'receipt_invalid');
    receipt.artifact={id:archive.id,digest:archive.digest,expiresAt:archive.expires_at,url:'https://github.com/'+repository+'/actions/runs/'+run.id+'/artifacts/'+archive.id};
    return finish({...result,state:'compiled',receipt});
  }
  async function download(work){
    const prior=await ledger.get('oci:'+sha(work.id)),checkpoint=prior?.result;
    check(checkpoint?.work&&canonical(checkpoint.work)===canonical(work),'request_changed');
    const completed=checkpoint.completed,receipt=completed?.receipt,repository=repositoryFor(checkpoint.runner);
    check(completed?.state==='compiled'&&receipt?.buildId===work.id&&receipt.projectId===work.projectId&&receipt.planId===work.planId&&receipt.sourceHash===work.sourceHash,'image_not_complete');
    check(Number.isSafeInteger(receipt.artifact?.id)&&receipt.artifact.id>0&&hash.test(receipt.artifact?.digest??''),'image_metadata_invalid');
    check(Date.parse(receipt.artifact.expiresAt)>now(),'result_expired');
    const r=await request('https://api.github.com/repos/'+repository+'/actions/artifacts/'+receipt.artifact.id+'/zip',{redirect:'manual',signal:AbortSignal.timeout(15000),headers:{authorization:'Bearer '+token(),accept:'application/vnd.github+json'}});
    check(![404,410].includes(r.status),'result_expired');check(r.status===302,'image_download_unavailable');
    const url=new URL(r.headers.get('location'));
    check(url.protocol==='https:'&&!url.username&&!url.password&&url.href.length<=12000&&['.blob.core.windows.net','.githubusercontent.com'].some(s=>url.hostname.endsWith(s)),'image_redirect_invalid');
    // Signed short-lived provider URL is returned only to the authenticated API.
    // It is never saved to the ledger or sent to a project owner.
    return {buildId:work.id,state:'compiled',receipt,url:url.href};
  }
  async function dispatch(work){
    const key='oci:'+sha(work.id),prior=await ledger.get(key);
    if(prior&&prior.result?.phase!=='prepared')return inspect(work);
    if(prior?.result?.work)check(canonical(prior.result.work)===canonical(work),'request_changed');
    let c;
    try{
      const current=settings(work);check(current.enabled===true,'not_enabled');c=prior?.result?.runner??current;const repository=repositoryFor(c);
      const ref=await api('/repos/'+repository+'/git/ref/tags/'+c.ref);check(ref.object?.sha===c.sha&&ref.object?.type==='commit','runner_changed');
      const account=await api('/repos/'+repository);check(account.private===(c.privateSource===true)&&account.owner?.login==='contractclaus','repository_changed');
      const publicResponse=await request('https://claus-network-api.vercel.app/v1/public/infrastructure/builds/'+encodeURIComponent(work.id)+'/source',{redirect:'error',signal:AbortSignal.timeout(15000)});check(publicResponse.ok,'source_unavailable');
      const source=JSON.parse((await body(publicResponse,work.visibility==='private'?4300000:3200000)).toString());
      if(c.privateSource){check(source.profile==='claus-private-context/1'&&canonical(source.scope)===canonical({...work,visibility:'private'}),'source_changed');}
      else check(source.buildId===work.id&&source.plan?.id===work.planId&&source.plan?.projectId===work.projectId&&source.plan?.sourceHash===work.sourceHash,'source_changed');
    }catch(e){
      const current=await inspect(work);
      return current.state==='not_started'?{...current,error:/^oci_[a-z0-9_]+$/.test(e.message)?e.message:'oci_preflight_unavailable'}:current;
    }
    await ledger.reserveOci(key,{work,runnerSha:c.sha,runnerRef:c.ref},{work,runner:c,phase:'prepared',createdAt:now(),runId:null});
    if(!await ledger.startOciDispatch(key))return inspect(work);
    // This CAS is the only path to an external dispatch. Even an expired API
    // lease, concurrent retry or lost acknowledgement cannot send it twice.
    try{await api('/repos/'+repositoryFor(c)+'/actions/workflows/'+workflow+'/dispatches','POST',{ref:c.ref,inputs:{build_id:work.id,...(c.privateSource?{context_key:privateContextKey(secret(),work).toString('hex')}:{})}});}catch{return {buildId:work.id,state:'unknown',error:'oci_dispatch_outcome_unknown'};}
    return {buildId:work.id,state:'running'};
  }
  return async({operation,work})=>{
    check(['dispatch','inspect','download'].includes(operation)&&work&&hash.test(work.id)&&hash.test(work.planId)&&hash.test(work.sourceHash)&&typeof work.projectId==='string'&&work.projectId.length<=128&&(work.visibility===undefined||work.visibility==='private'),'request_invalid');
    return signed(work,await(operation==='inspect'?inspect(work):operation==='download'?download(work):dispatch(work)));
  };
}
