import {Resolver} from 'node:dns/promises';
import {domainName} from '../src/domains/index.mjs';
import {requireThat} from '../src/shared/index.mjs';
export function domainPorts(env=process.env,{fetcher=fetch,resolver=new Resolver({timeout:3000,tries:1})}={}){
 const project=env.CLAUS_DOMAINS_HOST_PROJECT,team=env.CLAUS_DOMAINS_HOST_TEAM,token=env.CLAUS_DOMAINS_HOST_TOKEN;
 requireThat(/^prj_[a-zA-Z0-9]+$/.test(project??'')&&/^team_[a-zA-Z0-9]+$/.test(team??'')&&token,'domain_host_not_configured');
 const root='/v9/projects/'+project+'/domains/';
 async function request(path,{method='GET',body,missing=false}={}){const r=await fetcher('https://api.vercel.com'+path+(path.includes('?')?'&':'?')+'teamId='+team,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(8000)});if(missing&&r.status===404)return null;requireThat(r.ok,'domain_host_unavailable');const text=await r.text();requireThat(Buffer.byteLength(text)<=65536,'domain_host_response');return text?JSON.parse(text):{};}
 const lookup=h=>request(root+domainName(h),{missing:true});
 function belongs(row,h,intent){requireThat(row.name===h&&row.projectId===project&&!row.redirect&&!row.gitBranch&&!row.customEnvironmentId&&Number.isFinite(row.createdAt)&&row.createdAt>=intent.startedAt-2000,'domain_host_conflict');}
 const records=value=>Array.isArray(value)?value.slice(0,8).map(x=>({type:String(x.type??'').slice(0,20),domain:String(x.domain??'').slice(0,300),value:String(x.value??'').slice(0,1000)})):[];
 return {async proof(name,expected){requireThat(name==='_claus-site.'+domainName(name.slice(12)),'invalid_domain');try{const rows=await resolver.resolveTxt(name);requireThat(rows.length<=100,'domain_dns_response');return rows.some(parts=>parts.join('')===expected);}catch(e){if(['ENODATA','ENOTFOUND'].includes(e.code))return false;throw e;}},lookup,
  async attach(h,intent){domainName(h);let row=await lookup(h);if(!row){row=await request('/v10/projects/'+project+'/domains',{method:'POST',body:{name:h}});}belongs(row,h,intent);if(!row.verified){row=await request(root+h+'/verify',{method:'POST',body:{}});belongs(row,h,intent);}const config=await request('/v6/domains/'+h+'/config?projectIdOrName='+project);return {verified:row.verified===true,configured:config.misconfigured===false,verification:records(row.verification),dns:[{type:'CNAME',name:h,value:env.CLAUS_DOMAINS_CNAME??'cname.vercel-dns.com'}]};},
  async remove(h,intent){const row=await lookup(h);if(!row)return;belongs(row,h,intent);await request(root+h,{method:'DELETE'});}
 };
}
