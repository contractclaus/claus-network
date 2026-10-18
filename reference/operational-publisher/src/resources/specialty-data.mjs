import {digest} from './store.mjs';
export const specialtyInputs={dependency_advisories:['ecosystem','packages','type','after']};
const fail=c=>{throw Error('resource_specialty_'+c);};
export function specialtyData({store,providers,now=Date.now}){
 return {async call(operation,input){
  if(operation!=='dependency_advisories')fail('operation_invalid');
  if(!['npm','pip','go','rust','actions','maven','nuget','composer','rubygems','swift'].includes(input.ecosystem)||!Array.isArray(input.packages)||!input.packages.length||input.packages.length>30||input.packages.some(x=>typeof x!=='string'||!x||x.length>180||/[\s,\x00-\x1f]/.test(x))||input.after!==undefined&&(typeof input.after!=='string'||input.after.length>500))fail('query_invalid');
  const type=input.type??'reviewed';if(!['reviewed','malware','unreviewed'].includes(type))fail('type_invalid');
  const q=new URLSearchParams({ecosystem:input.ecosystem,affects:input.packages.join(','),type,is_withdrawn:'false',per_page:'100',sort:'updated',direction:'desc'});if(input.after)q.set('after',input.after);
  const rows=await providers.call('github','/advisories?'+q);if(!Array.isArray(rows)||rows.length>100)fail('response_invalid');
  const items=rows.map(r=>{if(!/^GHSA-[a-z0-9-]+$/.test(r.ghsa_id??'')||!Array.isArray(r.vulnerabilities))fail('response_invalid');return {id:r.ghsa_id,cve:r.cve_id,url:r.html_url,summary:r.summary,severity:r.severity,type:r.type,updatedAt:r.updated_at,vulnerabilities:r.vulnerabilities,credits:r.credits?.map(c=>({name:c.user?.login,url:c.user?.html_url,type:c.type}))??[]};});
  const value={version:1,query:input,observedAt:new Date(now()).toISOString(),items,possiblyTruncated:rows.length===100,source:'GitHub Advisory Database',sourceUrl:'https://github.com/github/advisory-database',license:'CC-BY-4.0',licenseUrl:'https://github.com/github/advisory-database/blob/main/LICENSE.md',modifications:'Fields selected and grouped; descriptions omitted. Individual advisory URLs retain author attribution.',billing:'Public dataset through the existing GitHub account; no new subscription',meaning:'Affected versions from the selected advisory class. Empty results are not a security certification; request malware separately and preserve source attribution.'};
  const id=digest(value);await store.put('specialty-data-observation',id,value);return {id,...value};
 }};
}
