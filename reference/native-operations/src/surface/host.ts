import type {SourceFile} from './source.js';

// Only fixed surface operations cross this boundary. No provider credential,
// arbitrary provider URL, environment or deployment settings enter the agent.
export class SurfaceHost {
 constructor(readonly request:typeof fetch=fetch,readonly secret=()=>process.env.PUBLISHER_SECRET){}
 private async call(operation:string,args:unknown[]){
  const secret=this.secret();if(!secret)throw Error('surface_host_not_connected');
  const response=await this.request('https://claus-inference.vercel.app/api/surface-publisher',{
   method:'POST',headers:{authorization:'Bearer '+secret,'content-type':'application/json'},
   body:JSON.stringify({operation,args}),redirect:'error',signal:AbortSignal.timeout(90000)
  });
  const body=await response.json();
  if(!response.ok)throw Error(/^surface_[a-z_0-9]+$/.test(body.error??'')?body.error:'surface_host_unavailable');
  return body.result;
 }
 async assertProject(projectId:string){return this.call('project',[projectId]);}
 async prepare(projectId:string,files:SourceFile[],id:string,hash:string){return this.call('prepare',[projectId,files,id,hash]);}
 async deploy(projectId:string,files:SourceFile[],id:string,hash:string){return this.call('deploy',[projectId,files,id,hash]);}
 async reconcile(projectId:string,id:string,hash:string,deploymentId?:string){return this.call('reconcile',[projectId,id,hash,deploymentId??null]);}
 async verifySource(deploymentId:string,files:SourceFile[],id:string,hash:string){return this.call('source',[deploymentId,files,id,hash]);}
 async verify(url:string,id:string,hash:string,data=false){return this.call('verify',[url,id,hash,data]);}
}
