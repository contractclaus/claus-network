import {neon} from '@neondatabase/serverless';
import {continuityGate,postgresBarriers,continuityMiddleware} from './continuity-gate.mjs';
export function nativeContinuity<T>(component:'native'|'lab',kind:string,originalId:string|null,input:any,run:()=>Promise<T>):Promise<T>{
 return continuityGate({component,writeBarriers:postgresBarriers({agent:(query:string,params:any[])=>neon(process.env.DATABASE_URL!).query(query,params)})})({kind,originalId,input},run);
}

export const nativeMiddleware=(c:any,next:any)=>continuityMiddleware({component:'native',gate:(context:any,run:any)=>nativeContinuity('native',context.kind,context.originalId,context.input,run),mutating:(c:any)=>['POST','PUT','PATCH','DELETE'].includes(c.req.method)||/\/recover$/.test(c.req.path)})(c,next);
