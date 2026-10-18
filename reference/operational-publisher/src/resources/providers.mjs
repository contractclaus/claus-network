export const team='team_uolDmrwvORBaI3V7q4JVMKNS',owner='contractclaus';
export function validateSettings(input){const allowed=['framework','buildCommand','installCommand','outputDirectory','rootDirectory','serverlessFunctionRegion'];if(!input||Array.isArray(input)||!Object.keys(input).length||Object.keys(input).some(k=>!allowed.includes(k))||Object.values(input).some(v=>v!==null&&(typeof v!=='string'||v.length>2000)))throw Error('resource_settings_invalid');return input;}
export function retryTime(value,now=Date.now()){
 if(!value)return null;const n=Number(value);if(Number.isFinite(n)&&n>=0)return now+n*1000;const date=Date.parse(value);return Number.isFinite(date)?Math.max(now,date):null;
}
export class ResourceProviderError extends Error{constructor(status,provider,retryAt=null){super('resource_'+provider+'_'+status);this.status=status;this.provider=provider;this.retryAt=retryAt;}}
export function resourceProviders({request=fetch,env=process.env}={}){
 async function call(provider,path,{method='GET',body,missing=false}={}){
  const token=provider==='vercel'?(env.RESOURCE_VERCEL_TOKEN||env.OPERATIONS_WEB_TOKEN):env.CLAUS_GITHUB_TOKEN;
  if(!token)throw Error('resource_'+provider+'_not_connected');
  const origin=provider==='vercel'?'https://api.vercel.com':'https://api.github.com';
  const url=origin+path+(provider==='vercel'?(path.includes('?')?'&':'?')+'teamId='+team:'');
  const r=await request(url,{method,headers:{authorization:'Bearer '+token,accept:'application/json','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(25000)});
  if(missing&&r.status===404)return null;
  if(!r.ok)throw new ResourceProviderError(r.status,provider,retryTime(r.headers.get('retry-after')));
  if(r.status===204)return null;
  const text=await r.text();if(Buffer.byteLength(text)>4*1024*1024)throw Error('resource_response_too_large');return text?JSON.parse(text):null;
 }
 const vercel=(p,o)=>call('vercel',p,o),github=(p,o)=>call('github',p,o);
 function project(v){if(v.accountId!==team)throw Error('resource_owner_mismatch');return {provider:'vercel',providerId:v.id,name:v.name,owner:team,url:v.targets?.production?.url?'https://'+v.targets.production.url:null,deployment:v.targets?.production?.id??null};}
 function repository(v){if(v.owner?.login!==owner)throw Error('resource_owner_mismatch');return {provider:'github',providerId:String(v.id),name:v.name,owner,url:v.html_url,private:v.private,defaultBranch:v.default_branch};}
 return {
  call,
  configured:()=>({database:!!env.RESOURCE_DATABASE_URL,vercel:!!(env.RESOURCE_VERCEL_TOKEN||env.OPERATIONS_WEB_TOKEN),vercelProjectCreation:!!env.RESOURCE_VERCEL_TOKEN,github:!!env.CLAUS_GITHUB_TOKEN,cloudflareDns:!!env.WEBSITE_CLOUDFLARE_TOKEN,runpod:!!env.CLAUS_RUNPOD_API_KEY,vault:/^[a-f0-9]{64}$/.test(env.RESOURCE_VAULT_KEY??'')}),
  async identity(provider){
   if(provider==='github'){const v=await github('/user');if(v.login!==owner)throw Error('resource_owner_mismatch');return {provider,owner:v.login,id:v.id};}
   if(!env.RESOURCE_VERCEL_TOKEN){const v=project(await vercel('/v9/projects/prj_3EPhg3tuhf5oHU9sw2Butj9eRegy'));return {provider,owner:v.owner,project:v.providerId,scope:'single-project',canCreateProjects:false};}
   const v=await vercel('/v2/teams/'+team);if(v.id!==team)throw Error('resource_owner_mismatch');return {provider,owner:v.id,name:v.name,scope:'team',canCreateProjects:true};
  },
  async find(provider,name){const v=provider==='vercel'?await vercel('/v9/projects/'+encodeURIComponent(name),{missing:true}):await github('/repos/'+owner+'/'+encodeURIComponent(name),{missing:true});return v?(provider==='vercel'?project(v):repository(v)):null;},
  async create(provider,name,input){
   if(provider==='vercel'){
    if(!env.RESOURCE_VERCEL_TOKEN)throw Error('resource_vercel_team_access_missing');
    return project(await vercel('/v11/projects',{method:'POST',body:{name,framework:null,publicSource:false,resourceConfig:{buildMachineType:'basic',functionDefaultTimeout:60}}}));
   }
   await this.identity('github');return repository(await github('/user/repos',{method:'POST',body:{name,description:input.purpose,private:input.private!==false,auto_init:false}}));
  },
  async read(resource){return this.find(resource.provider,resource.name);},
  async envs(resource){return (await vercel('/v10/projects/'+resource.providerId+'/env')).envs??[];},
  async envValue(resource,id){return (await vercel('/v1/projects/'+resource.providerId+'/env/'+id)).value;},
  async setEnv(resource,name,value,prior){return vercel('/'+(prior?'v9':'v10')+'/projects/'+resource.providerId+'/env'+(prior?'/'+prior.id:''),{method:prior?'PATCH':'POST',body:{key:name,value,type:'encrypted',target:['production']}});},
  async removeEnv(resource,id){return vercel('/v9/projects/'+resource.providerId+'/env/'+id,{method:'DELETE'});},
  async readSettings(resource,keys){const v=await vercel('/v9/projects/'+resource.providerId);project(v);return Object.fromEntries(keys.map(k=>[k,v[k]??null]));},
  async settings(resource,input){validateSettings(input);const v=await vercel('/v9/projects/'+resource.providerId,{method:'PATCH',body:input});return project(v);},
  async deployments(resource){const v=await vercel('/v6/deployments?projectId='+resource.providerId+'&limit=30');return v.deployments.map(d=>({id:d.uid,state:d.state,url:d.url?'https://'+d.url:null,createdAt:d.created}));},
  async logs(resource,deploymentId){const d=await vercel('/v13/deployments/'+encodeURIComponent(deploymentId));if(d.projectId!==resource.providerId)throw Error('resource_deployment_mismatch');const events=await vercel('/v3/deployments/'+deploymentId+'/events?limit=100');return {id:deploymentId,state:d.readyState,events:(Array.isArray(events)?events:[]).map(e=>({type:e.type,created:e.created,text:String(e.text??'').slice(0,2000)}))};}
 };
}
