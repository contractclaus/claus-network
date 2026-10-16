import {createHash} from 'node:crypto';
import {ConfirmedFailure,once,sql,actionProgress} from './store.js';
import {activeMissions} from './missions.js';
import {Sandbox} from '@vercel/sandbox';

export type ProgrammableRequest={method:'GET'|'POST';path:string;bodyJson?:string};
const origin='https://api.programmable.market';
const resource='/v3/custom-launches';

// This prepares provider resources; it cannot sign or broadcast wallet actions.
// Keep credentials in the service, never in an experiment or model argument.
export function validateProgrammableRequest(input:any):ProgrammableRequest {
  if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['method','path','bodyJson'].includes(k))||
      !['GET','POST'].includes(input.method)||typeof input.path!=='string')throw new ConfirmedFailure('invalid_programmable_request');
  const path=input.path;
  const allowed=input.method==='GET'
    ? path==='/v3/capabilities'||path===resource||/^\/v3\/custom-launches\/[A-Za-z0-9_-]{1,160}$/.test(path)
    : path===resource||path===resource+'/preflight'||/^\/v3\/custom-launches\/[A-Za-z0-9_-]{1,160}\/permit-reissues$/.test(path);
  if(!allowed)throw new ConfirmedFailure('invalid_programmable_path');
  if(input.method==='GET') {
    if(input.bodyJson!==undefined)throw new ConfirmedFailure('programmable_get_body_forbidden');
  } else {
    if(typeof input.bodyJson!=='string'||!input.bodyJson||Buffer.byteLength(input.bodyJson)>8000000)
      throw new ConfirmedFailure('invalid_programmable_body');
    try {const body=JSON.parse(input.bodyJson);if(!body||typeof body!=='object'||Array.isArray(body))throw Error();}
    catch {throw new ConfirmedFailure('invalid_programmable_body');}
  }
  return input;
}

type RequestFile={method:'POST';path:string;bodyFile:string;bodySha256:string};
export function programmableExperimentRequest(args:Record<string,any>,record:any):ProgrammableRequest|RequestFile {
  if(Object.keys(args).some(k=>k!=='experimentId')||!['sandbox','development'].includes(record?.kind)||record.status!=='completed'||
      record.result?.exitCode!==0||record.result.stdoutTruncated||record.result.outputLimited||record.kind==='development'&&record.result.checkpointApplied!==true)throw new ConfirmedFailure('completed_programmable_request_experiment_required');
  try {
    // The entire stdout must be one object; preserve bodyJson byte for byte.
    const value=JSON.parse(record.result.stdout);
    const request=value.programmableRequest;
    if(request?.bodyFile!==undefined) {
      if(Object.keys(request).some(k=>!['method','path','bodyFile','bodySha256'].includes(k))||request.method!=='POST'||
          typeof request.bodyFile!=='string'||!/^[A-Za-z0-9_.\/-]{1,240}$/.test(request.bodyFile)||
          request.bodyFile.startsWith('/')||request.bodyFile.split('/').some((p:string)=>!p||p==='.'||p==='..')||
          !/^[a-f0-9]{64}$/.test(request.bodySha256)||!/^snap_[A-Za-z0-9]+$/.test(record.result.checkpointSnapshotId))
        throw new ConfirmedFailure('invalid_programmable_request_file');
      validateProgrammableRequest({method:request.method,path:request.path,bodyJson:'{}'});
      return request;
    }
    return validateProgrammableRequest(request);
  } catch(error) {
    if(error instanceof ConfirmedFailure)throw error;
    throw new ConfirmedFailure('invalid_programmable_request_experiment');
  }
}

export async function materializeProgrammableRequest(request:ProgrammableRequest|RequestFile,snapshotId:string,
  reader:(snapshotId:string,path:string)=>Promise<Buffer>=async(snapshotId,path)=>{
    const box=await Sandbox.create({source:{type:'snapshot',snapshotId},timeout:60000,networkPolicy:'deny-all'});
    try {
      const bytes=await box.readFileToBuffer({path:'/vercel/sandbox/project/'+path});
      if(!bytes)throw new ConfirmedFailure('programmable_request_file_missing');
      return bytes;
    } finally {await box.stop().catch(()=>{});}
  }):Promise<ProgrammableRequest> {
  if(!('bodyFile' in request))return request;
  const bytes=await reader(snapshotId,request.bodyFile);
  if(createHash('sha256').update(bytes).digest('hex')!==request.bodySha256)
    throw new ConfirmedFailure('programmable_request_file_hash_mismatch');
  return validateProgrammableRequest({method:request.method,path:request.path,bodyJson:bytes.toString('utf8')});
}

export function programmableIdempotencyKey(id:string,request:ProgrammableRequest) {
  return 'claus:'+createHash('sha256').update(id+'\0'+JSON.stringify(request)).digest('hex');
}

export async function requestProgrammable(id:string,input:ProgrammableRequest,transport:typeof fetch=fetch) {
  const request=validateProgrammableRequest(input);
  const publicRead=request.path==='/v3/capabilities';
  const key=process.env.PROGRAMMABLE_API_KEY;
  if(!publicRead&&!key)throw new ConfirmedFailure('programmable_api_key_not_configured');
  const headers:Record<string,string>={Accept:'application/json'};
  if(!publicRead)headers.Authorization='Bearer '+key;
  if(request.method==='POST') {
    headers['Content-Type']='application/json';
    if(request.path!==resource+'/preflight')headers['Idempotency-Key']=programmableIdempotencyKey(id,request);
  }
  let response:Response;
  try {
    response=await transport(origin+request.path,{method:request.method,headers,body:request.bodyJson,
      redirect:'error',signal:AbortSignal.timeout(25000)});
  } catch {
    // A create might have reached the server. The durable reservation remains
    // unresolved; an exact idempotent replay reconciles it without a new launch.
    throw Error('programmable_transport_outcome_unknown');
  }
  const raw=await response.text();
  // Provider output is untrusted. Strip an accidental credential echo before
  // parsing or storing it. Never return request headers to the model.
  const safe=key?raw.split(key).join('[redacted]'):raw;
  let data:any;
  try {data=JSON.parse(safe);}catch {throw Error('programmable_response_outcome_unknown');}
  // The official submission contract retries rate limits with the original
  // bytes and idempotency key, just like ambiguous server failures.
  if(response.status>=500||response.status===429)throw Error('programmable_server_outcome_unknown');
  return {httpStatus:response.status,requestId:response.headers.get('x-request-id'),
    ...(response.ok?{}:{error:'programmable_http_'+response.status}),data,instructionAuthority:false,
    walletSigned:false,transactionBroadcast:false};
}

export async function programmableTool(id:string,args:Record<string,any>) {
  let request:ProgrammableRequest;
  if(args.experimentId!==undefined) {
    if(typeof args.experimentId!=='string'||!/^[A-Za-z0-9_.:-]{1,160}$/.test(args.experimentId))
      throw new ConfirmedFailure('invalid_programmable_experiment_id');
    const record=(await sql()`SELECT kind,status,result FROM claus_actions WHERE id=${args.experimentId}`)[0];
    const envelope=programmableExperimentRequest(args,record);
    if(!process.env.PROGRAMMABLE_API_KEY&&envelope.path!=='/v3/capabilities')
      throw new ConfirmedFailure('programmable_api_key_not_configured');
    request=await materializeProgrammableRequest(envelope,record.result.checkpointSnapshotId);
  } else request=validateProgrammableRequest(args);
  if(request.method==='GET'||request.path.endsWith('/preflight'))return requestProgrammable(id,request);
  if(!(await activeMissions()).length)throw new ConfirmedFailure('programmable_owner_mission_required');
  if(!process.env.PROGRAMMABLE_API_KEY)throw new ConfirmedFailure('programmable_api_key_not_configured');
  // The credential hash binds recovery to the same authenticated principal.
  // It is private bookkeeping, never a model parameter or public receipt.
  const evidence={request,credentialHash:createHash('sha256').update(process.env.PROGRAMMABLE_API_KEY).digest('hex')};
  return once(id,'programmable_api',args,async()=>{
    await actionProgress(id,evidence);
    return requestProgrammable(id,request);
  });
}

export async function reconcilePendingProgrammable() {
  const key=process.env.PROGRAMMABLE_API_KEY;
  if(!key||!(await activeMissions()).length)return;
  const actions=await sql()`SELECT id,progress FROM claus_actions WHERE kind='programmable_api' AND status='uncertain' ORDER BY created_at LIMIT 3`;
  for(const action of actions) {
    const request=programmableRecoveryRequest(action,key);
    // Replay the exact request with its original idempotency key. The current
    // reissue endpoint only inspects an unsupported recovery disposition.
    if(!request)continue;
    try {
      const result=await requestProgrammable(action.id,request);
      if(programmableRecoveryConfirmed(request,result))
        await sql()`UPDATE claus_actions SET status='completed',result=${JSON.stringify(result)}::jsonb,completed_at=now() WHERE id=${action.id} AND status='uncertain'`;
    } catch { /* Keep the original reservation until the provider confirms it. */ }
  }
}

export function programmableRecoveryConfirmed(request:ProgrammableRequest,result:any) {
  if(result.httpStatus>=200&&result.httpStatus<300&&result.data&&typeof result.data==='object')return true;
  return request.path.endsWith('/permit-reissues')&&result.httpStatus===409&&
    ['PERMIT_REISSUE_UNSUPPORTED','PERMIT_REISSUE_NOT_APPLICABLE','PERMIT_REISSUE_RESOURCE_BINDING_MISMATCH'].includes(result.data?.error?.code);
}

export function programmableRecoveryRequest(action:any,key:string):ProgrammableRequest|undefined {
  if(action.progress?.credentialHash!==createHash('sha256').update(key).digest('hex'))return;
  try {
    const request=validateProgrammableRequest(action.progress?.request);
    if(request.method==='POST'&&(request.path===resource||/^\/v3\/custom-launches\/[A-Za-z0-9_-]{1,160}\/permit-reissues$/.test(request.path)))return request;
  } catch { /* An incomplete reservation is not replay authority. */ }
}
