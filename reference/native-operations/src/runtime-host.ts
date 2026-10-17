import {productionLabDatabase,type LabQuery} from './lab-db.js';
const identity=()=>({role:process.env.CLAUS_RUNTIME_HOST==='standby'?'standby':'primary',executor:process.env.CLAUS_RUNTIME_EXECUTOR??'',epoch:process.env.CLAUS_RUNTIME_EPOCH?Number(process.env.CLAUS_RUNTIME_EPOCH):null});
export async function runtimeHostPermit(generation:number,db:LabQuery=productionLabDatabase()){
 const x=identity();const r=await db.query('SELECT public.claus_native_host_permit($1,$2,$3,$4) AS allowed',[x.role,x.executor,generation,x.epoch]);return r.rows[0]?.allowed===true;
}
export async function runtimeHostPulse(generation:number,db:LabQuery=productionLabDatabase()){
 const x=identity();const r=await db.query('SELECT public.claus_native_host_pulse($1,$2,$3,$4,$5) AS allowed',[x.role,x.executor,generation,x.epoch,process.env.VERCEL_DEPLOYMENT_ID??'']);return r.rows[0]?.allowed===true;
}
export async function resumePrimaryHost(db:LabQuery=productionLabDatabase()){
 const r=await db.query('SELECT public.claus_native_host_resume_primary($1) AS result',[process.env.VERCEL_DEPLOYMENT_ID??'']);return r.rows[0]?.result??{status:'paused'};
}
