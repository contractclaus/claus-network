import type {FileRef} from './policy.js';
export class OperationsHostError extends Error {
 constructor(readonly status:number,readonly code:string|null){super('operations_host_'+status);}
 get rejected(){return [400,401,402,403,404,405,410,413,415,422].includes(this.status);}
}
export function sourceTree(tree:any[]):Record<string,string>{const out:Record<string,string>={};function walk(a:any[],prefix=''){for(const n of a)n.children?walk(n.children,prefix+n.name+'/'):out[prefix+n.name]=n.uid;}const root=tree.find(n=>n.name==='src');if(!root?.children)throw Error('operations_source_missing');walk(root.children);return out;}
export const publisherConnected=()=>!!process.env.PUBLISHER_SECRET;
// The native process carries a fixed-purpose broker credential only. Provider
// tokens and preview bypass credentials never cross this boundary.
export class OperationsHost{
 constructor(readonly fetcher:typeof fetch=fetch,readonly secret=()=>process.env.PUBLISHER_SECRET){}
 private async call(operation:string,scope:string,args:any[]){
  const secret=this.secret();if(!secret)throw Error('operations_host_not_connected');
  const r=await this.fetcher('https://claus-inference.vercel.app/api/publisher',{method:'POST',headers:{authorization:'Bearer '+secret,'content-type':'application/json'},body:JSON.stringify({operation,scope,args}),redirect:'error',signal:AbortSignal.timeout(90000)});
  const body=await r.json();if(!r.ok){if(body.error==='publisher_provider_error')throw new OperationsHostError(body.providerStatus,body.providerCode??null);throw Error(/^(publisher|operations|isolated)_[a-z_]+$/.test(body.error)?body.error:'operations_host_unavailable');}return body.result;
 }
 async activate(scope:string,id:string){return this.call('activate',scope,[id]);}
 async finishRollback(scope:string,id:string){return this.call('finishRollback',scope,[id]);}
 async adopt(deployment:string){return this.call('adopt','native',[deployment]);}
 async project(scope:string){return this.call('project',scope,[]);}
 async baseline(scope:string,deployment:string,manifest:FileRef[]){return this.call('baseline',scope,[deployment,manifest]);}
 async read(scope:string,deployment:string,file:FileRef){return this.call('read',scope,[deployment,file]);}
 async deployment(scope:string,id:string){return this.call('deployment',scope,[id]);}
 async deploy(scope:string,base:string,manifest:FileRef[],files:any[],id:string,sourceHash:string){return this.call('deploy',scope,[base,manifest,files,id,sourceHash]);}
 async reconcile(scope:string,id:string,hash:string,known?:string){return this.call('reconcile',scope,[id,hash,known??null]);}
 async verify(scope:string,deployment:any,manifest:FileRef[],production=false){return this.call('verify',scope,[deployment,manifest,production]);}
 async promote(scope:string,base:string,deployment:any){return this.call('promote',scope,[base,{id:deployment.id}]);}
 async restored(scope:string,id:string){return this.call('restored',scope,[id]);}
}
