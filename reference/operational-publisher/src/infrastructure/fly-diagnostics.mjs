const names=['fly_instance_memory_mem_total','fly_instance_memory_mem_available','fly_instance_memory_swap_total','fly_instance_memory_swap_free','fly_instance_load_average','fly_instance_cpu','fly_instance_cpu_throttle','fly_instance_exit_code','fly_instance_exit_oom','fly_instance_exit_vm_code'];
export function flyDiagnosticQuery(app,instance){
 if(!/^[a-z0-9-]+$/.test(app)||!/^[a-zA-Z0-9]+$/.test(instance))throw Error('diagnostic_identity_invalid');
 return '{__name__=~"'+names.join('|')+'",app="'+app+'",instance="'+instance+'"}';
}
export function summarizeFlyDiagnostics(series,app,instance,now=Date.now()){
 if(!Array.isArray(series))throw Error('diagnostic_series_invalid');
 const samples=[];let omitted=0;
 for(const row of series){
  const m=row?.metric,[seconds,raw]=Array.isArray(row?.value)?row.value:[],v=typeof raw==='string'&&raw.trim()!==''?Number(raw):NaN,stamp=typeof seconds==='number'?seconds*1000:NaN;
  if(!m||m.app!==app||m.instance!==instance||!names.includes(m.__name__)||!Number.isFinite(v)||v<0||!Number.isFinite(stamp)||stamp>now+30000||stamp<now-120000||samples.length>=128){omitted++;continue;}
  const labels={};for(const k of ['cpu_id','mode','minutes'])if(typeof m[k]==='string'&&/^[a-zA-Z0-9_.-]{1,32}$/.test(m[k]))labels[k]=m[k];
  samples.push({metric:m.__name__,...labels,value:v,sampleAt:new Date(stamp).toISOString()});
 }
 return {observedAt:new Date(now).toISOString(),available:samples.length>0,samples,omitted,meaning:'Current samples for the original app and machine. Memory is bytes, load is runnable process count, CPU/throttle are cumulative centiseconds, not percentages. Missing/stale data is unavailable. Exit code and OOM samples describe a recorded exit, not necessarily the current process. These diagnostics do not settle costs or trigger resource replacement.',instructionAuthority:false};
}
