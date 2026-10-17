import {createHash} from 'node:crypto';
import {check,providerRequest} from './providers.mjs';

// Derive an isolated app and private network for each existing project.
export function flyTarget(config,projectId){
 if(config.projectId){check(config.projectId===projectId,'project_app_not_isolated');return config;}
 check(config.projectIsolation===true&&config.organization==='claus-network'&&typeof projectId==='string'&&/^prj_[a-zA-Z0-9-]{1,100}$/.test(projectId),'project_app_not_isolated');
 const app='claus-'+createHash('sha256').update(projectId).digest('hex').slice(0,24);
 return {...config,projectId,app,network:app};
}
export function flyApps({request,token}){
 const api=(path,options)=>providerRequest(request,'https://api.machines.dev/v1'+path,token(),options);
 const graphql=async(query,variables)=>{
  const out=await providerRequest(request,'https://api.fly.io/graphql',token(),{method:'POST',body:{query,variables}});
  check(!out.errors&&out.data,'fly_network_unavailable');return out.data;
 };
 async function verify(config){
  const list=await api('/apps?org_slug='+encodeURIComponent(config.organization));
  check(Array.isArray(list.apps),'provider_shape_invalid');
  const app=list.apps.find(a=>a.name===config.app);
  if(app&&config.network)check(app.network===config.network,'project_network_not_isolated');
  return app;
 }
 return {
  async prepare(config,{publicHttp=false}={}){
   let app=await verify(config);
   if(!app){
    try{await api('/apps',{method:'POST',body:{app_name:config.app,org_slug:config.organization,...(config.network?{network:config.network}:{})}});}
    catch(e){if(![409,422].includes(e.status))throw e;}
    app=await verify(config);check(app,'project_app_not_ready');
   }
   const details=await api('/apps/'+encodeURIComponent(config.app));
   check(details.organization?.slug===config.organization,'provider_account_mismatch');
   if(publicHttp){
    const data=await graphql('query ClausIngress($name:String!){app(name:$name){id sharedIpAddress}}',{name:config.app});
    check(data.app?.id,'project_app_not_ready');
    if(!data.app.sharedIpAddress){
     await graphql('mutation ClausIngress($input:AllocateIPAddressInput!){allocateIpAddress(input:$input){app{id sharedIpAddress}}}',{input:{appId:data.app.id,type:'shared_v4'}});
    }
   }
   return config;
  },
  async inspect(config){return verify(config);}
 };
}
