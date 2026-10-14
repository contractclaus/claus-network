import {createHash} from 'node:crypto';
const stable=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
// Resume an existing manifest without changing its schema or overwriting edits.
export async function configureApp(client,{projectId,manifest}){
 let prior;
 try{prior=await client.call('app_get',{projectId});}catch(e){if(e.code!=='not_found')throw e;}
 if(prior&&stable(prior.manifest)!==stable(manifest))throw Error('App already exists with a different manifest; review the migration explicitly');
 const hash=createHash('sha256').update(stable(manifest)).digest('hex');
 prior??=await client.call('app_configure',{projectId,manifest,expectedRevision:0,idempotencyKey:'template:'+hash});
 if(!prior.published)prior=await client.call('app_publish',{projectId,published:true,expectedRevision:prior.revision,idempotencyKey:'template-publish:'+hash+':'+prior.revision});
 return {projectId,version:prior.version,published:prior.published};
}
