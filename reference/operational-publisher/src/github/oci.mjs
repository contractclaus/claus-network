import {createHash,createHmac} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';

const repository='contractclaus/claus-network';
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

export function createOciBroker({token=()=>process.env.CLAUS_GITHUB_TOKEN,secret=()=>process.env.CLAUS_OCI_NETWORK_SECRET,config=()=>JSON.parse(process.env.CLAUS_OCI_RUNNER??'null'),request=fetch,ledger}){
  async function body(r,max=1000000){const reader=r.body.getReader(),parts=[];let size=0;try{for(;;){const p=await reader.read();if(p.done)break;size+=p.value.length;check(size<=max,'provider_response_size');parts.push(p.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}return Buffer.concat(parts);}
  async function api(path,method='GET',data){
    check(token(),'not_configured');const r=await request('https://api.github.com'+path,{method,redirect:'manual',signal:AbortSignal.timeout(15000),headers:{authorization:'Bearer '+token(),accept:'application/vnd.github+json','x-github-api-version':'2022-11-28','user-agent':'contractclaus',...(data?{'content-type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});
    check(r.ok,'provider_'+r.status);return r.status===204?null:JSON.parse((await body(r)).toString());
  }
  function settings(){const c=config();check(c&&/^[a-f0-9]{40}$/.test(c.sha??'')&&/^claus-oci-v[0-9]+-[a-z0-9-]+$/.test(c.ref??''),'not_configured');return c;}
  async function receiptFile(artifact){
    check(hash.test(artifact.digest??'')&&artifact.size_in_bytes<=65536,'receipt_metadata_invalid');
    const r=await request('https://api.github.com/repos/'+repository+'/actions/artifacts/'+artifact.id+'/zip',{redirect:'manual',signal:AbortSignal.timeout(15000),headers:{authorization:'Bearer '+token(),accept:'application/vnd.github+json'}});
    check(r.status===302,'receipt_redirect_missing');const u=new URL(r.headers.get('location'));
    check(u.protocol==='https:'&&!u.username&&!u.password&&['.blob.core.windows.net','.githubusercontent.com'].some(s=>u.hostname.endsWith(s)),'receipt_redirect_invalid');
    const data=await request(u,{redirect:'error',signal:AbortSignal.timeout(15000)});check(data.ok,'receipt_unavailable');const bytes=await body(data,65536);
    check('sha256:'+sha(bytes)===artifact.digest,'receipt_hash_mismatch');return receiptFromZip(bytes);
  }
  async function inspect(work,c){
    const key='oci:'+sha(work.id),prior=await ledger.get(key),checkpoint=prior?.result;
    if(checkpoint?.work){check(canonical(checkpoint.work)===canonical(work),'request_changed');c=checkpoint.runner;}
    if(checkpoint?.completed){const result=checkpoint.completed;return {...result,...(result.receipt?{proof:createHmac('sha256',secret()).update(canonical({receipt:result.receipt,runUrl:result.runUrl})).digest('hex')}:{})};}
    const runs=checkpoint?.runId?{workflow_runs:[await api('/repos/'+repository+'/actions/runs/'+checkpoint.runId)]}:await api('/repos/'+repository+'/actions/workflows/'+workflow+'/runs?event=workflow_dispatch&head_sha='+c.sha+'&per_page=100');
    const matches=(runs.workflow_runs??[]).filter(r=>r.display_title==='Claus OCI '+work.id&&r.head_sha===c.sha&&r.event==='workflow_dispatch');
    check(matches.length<=1,'duplicate_execution');
    if(!matches.length)return {buildId:work.id,state:'unknown'};
    const run=matches[0];if(!checkpoint?.runId&&checkpoint)await ledger.checkpoint(key,{...checkpoint,runId:run.id});check(run.run_attempt===1&&run.repository?.full_name===repository,'runner_mismatch');
    const result={buildId:work.id,state:run.status==='completed'?'failed':'running',runUrl:run.html_url};
    if(run.status!=='completed')return result;
    if(run.conclusion!=='success'){const completed={...result,error:'oci_runner_'+run.conclusion};if(checkpoint)await ledger.complete(key,{...checkpoint,runId:run.id,completed});return completed;}
    const list=await api('/repos/'+repository+'/actions/runs/'+run.id+'/artifacts?per_page=100');
    const receipts=list.artifacts.filter(a=>a.name==='oci-receipt'&&!a.expired),archives=list.artifacts.filter(a=>a.name==='oci-image'&&!a.expired);
    check(receipts.length===1&&archives.length===1,'artifacts_missing');
    const receipt=await receiptFile(receipts[0]),archive=archives[0];
    check(receipt.buildId===work.id&&receipt.projectId===work.projectId&&receipt.planId===work.planId&&receipt.sourceHash===work.sourceHash&&receipt.runId===String(run.id)&&receipt.runnerSha===c.sha&&receipt.evidence==='compiled_only','receipt_binding_mismatch');
    check(hash.test(receipt.imageDigest)&&hash.test(receipt.archiveHash)&&Number.isSafeInteger(receipt.archiveBytes)&&receipt.archiveBytes>0&&receipt.archiveBytes<=33554432&&archive.size_in_bytes<=34000000,'receipt_invalid');
    receipt.artifact={id:archive.id,digest:archive.digest,expiresAt:archive.expires_at,url:'https://github.com/'+repository+'/actions/runs/'+run.id+'/artifacts/'+archive.id};
    result.state='compiled';result.receipt=receipt;
    if(checkpoint)await ledger.complete(key,{...checkpoint,runId:run.id,completed:result});
    result.proof=createHmac('sha256',secret()).update(canonical({receipt,runUrl:result.runUrl})).digest('hex');return result;
  }
  return async({operation,work})=>{
    check(['dispatch','inspect'].includes(operation)&&work&&hash.test(work.id)&&hash.test(work.planId)&&hash.test(work.sourceHash)&&typeof work.projectId==='string'&&work.projectId.length<=128,'request_invalid');
    const c=settings();
    if(operation==='inspect')return inspect(work,c);
    check(c.enabled===true,'not_enabled');
    // The immutable runner ref is checked before reserving or dispatching.
    const ref=await api('/repos/'+repository+'/git/ref/tags/'+c.ref);check(ref.object?.sha===c.sha&&ref.object?.type==='commit','runner_changed');
    const account=await api('/repos/'+repository);check(account.private===false&&account.owner?.login==='contractclaus','repository_changed');
    const publicResponse=await request('https://claus-network-api.vercel.app/v1/public/infrastructure/builds/'+encodeURIComponent(work.id)+'/source',{redirect:'error',signal:AbortSignal.timeout(15000)});check(publicResponse.ok,'source_unavailable');
    const source=JSON.parse((await body(publicResponse,3200000)).toString());
    check(source.buildId===work.id&&source.plan?.id===work.planId&&source.plan?.projectId===work.projectId&&source.plan?.sourceHash===work.sourceHash,'source_changed');
    const saved=await ledger.reserve('oci:'+sha(work.id),{work,runnerSha:c.sha,runnerRef:c.ref});
    if(!saved.created)return inspect(work,c);
    await ledger.checkpoint('oci:'+sha(work.id),{work,runner:c,runId:null});
    // Intent is durable before the external effect. No replacement dispatch,
    // even when GitHub accepted the request but the response was lost.
    try{await api('/repos/'+repository+'/actions/workflows/'+workflow+'/dispatches','POST',{ref:c.ref,inputs:{build_id:work.id}});}catch{return {buildId:work.id,state:'unknown'};}
    return {buildId:work.id,state:'running'};
  };
}
