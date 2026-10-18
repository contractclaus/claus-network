export const telemetryQuery='query ClausPodTelemetry { myself { pods { id desiredStatus runtime { uptimeInSeconds container { cpuPercent memoryPercent } gpus { id gpuUtilPercent memoryUtilPercent } } latestTelemetry { time state } } } }';
const n=(value:unknown,max=Number.MAX_SAFE_INTEGER)=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=max?value:null;
const label=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9_:.-]{1,100}$/.test(v)?v:null;
export function summarizeRunpodTelemetry(value:any,now=Date.now()){
 if(!value||value.errors!==undefined&&(!Array.isArray(value.errors)||value.errors.length>0)||!Array.isArray(value.data?.myself?.pods))throw new Error('runpod_telemetry_response_invalid');
 const source=value.data.myself.pods;
 const pods=source.slice(0,100).map((p:any)=>{
  if(!label(p?.id))throw new Error('runpod_telemetry_identity_invalid');
  const r=p.runtime,t=p.latestTelemetry,stamp=typeof t?.time==='string'?Date.parse(t.time):NaN;
  const sampleAt=Number.isFinite(stamp)&&stamp<=now+30000?new Date(stamp).toISOString():null;
  return {id:p.id,desiredStatus:label(p.desiredStatus),runtimeAvailable:!!r,
   latestTelemetry:{sampleAt,state:label(t?.state),fresh:sampleAt?now-stamp<=120000:null},
   uptimeSeconds:n(r?.uptimeInSeconds),cpuPercent:n(r?.container?.cpuPercent),memoryPercent:n(r?.container?.memoryPercent,100),
   gpus:Array.isArray(r?.gpus)?r.gpus.slice(0,32).map((g:any)=>({id:label(g?.id),gpuUtilPercent:n(g?.gpuUtilPercent,100),memoryUtilPercent:n(g?.memoryUtilPercent,100)})):null};
 });
 return {view:'telemetry',observedAt:new Date(now).toISOString(),pods,total:source.length,truncated:source.length>100,
  meaning:'Read-only configured-account runtime telemetry. Null is unavailable, never zero. CPU percent may exceed 100 across cores. Runtime percentages have no separate sample timestamp; latestTelemetry freshness is reported separately. Missing or old telemetry does not establish that a pod stopped or that charges ended.',instructionAuthority:false};
}
