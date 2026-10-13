import {keccak256} from 'viem';

// Independent model-boundary validation. Only the exact reviewed immutable
// factory/store pair is admitted as a writing consumer of readonly evaluation.
export function validateNetworkSignalConsumer(v:any,p:any,projectId:string,hash:(v:any)=>string,canonical:(v:any)=>string) {
 const fail=()=>{throw Error('network_review_invalid_input');};
 const keys=(v:any,names:string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==names.length||names.some(k=>!Object.hasOwn(v,k)))fail();};
 const address=(x:any)=>typeof x==='string'&&/^0x[0-9a-f]{40}$/i.test(x)&&!/^0x0{40}$/i.test(x);
 const word=(x:any)=>typeof x==='string'&&/^0x[0-9a-f]{64}$/i.test(x);
 keys(v,['profile','projectId','store','factory','evaluator','executor','projectKey','feedId','schemaHash','limits','dataTrust','build','buildHash','factoryBuild','factoryBuildHash','review']);
 if(v.profile!=='claus-signal-v1'||v.projectId!==projectId||!address(v.evaluator)||!address(v.executor)||
  v.evaluator.toLowerCase()!==p.target.toLowerCase()||v.executor.toLowerCase()!==p.executor.toLowerCase()||
  v.projectKey!==p.projectKey||![v.feedId,v.schemaHash].every(word)||v.dataTrust!=='publisher-attested-public-data')fail();
 const expectedLimits={maximumInputBytes:2048,maximumOutputBytes:512,evaluationGas:200000,maximumWritesPerGrant:10000,
  maximumGrantSeconds:2592000,maximumDataSeconds:86400,minimumIntervalSeconds:1,multipleOwnerSignedGrants:true,assetCustody:false};
 if(canonical(v.limits)!==canonical(expectedLimits))fail();
 for(const c of [v.store,v.factory]) {
  keys(c,['address','code','codeHash']);
  if(!address(c.address)||typeof c.code!=='string'||!/^0x(?:[0-9a-f]{2}){1,24576}$/i.test(c.code)||keccak256(c.code)!==c.codeHash)fail();
 }
 for(const [b,h,name] of [[v.build,v.buildHash,'ClausSignalStore'],[v.factoryBuild,v.factoryBuildHash,'ClausSignalFactory']]) {
  if(!b||hash(b)!==h||b.status!=='compiled'||b.contract!==name||b.profile?.profile!=='solidity-static-compile-v1'||
   b.profile.compiler!=='0.8.27+commit.40a35a09.Emscripten.clang'||hash(b.standardInput)!==b.inputHash||
   !b.standardInput?.sources?.[b.entry]?.content||typeof b.runtimeTemplate!=='string'||
   !/^0x(?:[0-9a-f]{2}){1,24576}$/i.test(b.runtimeTemplate)||keccak256(b.runtimeTemplate)!==b.runtimeTemplateHash)fail();
 }
 if(hash(v.build.standardInput.sources)!==hash(v.factoryBuild.standardInput.sources))fail();
 const groups:any[]=Object.values(v.factoryBuild.immutableReferences??{});
 if(groups.length!==1||!Array.isArray(groups[0])||groups[0].length===0)fail();
 let expected=v.factoryBuild.runtimeTemplate.slice(2);
 for(const ref of groups[0]) {
  if(!Number.isSafeInteger(ref.start)||ref.start<0||ref.length!==32||(ref.start+32)*2>expected.length||
   !/^0{64}$/.test(expected.slice(ref.start*2,(ref.start+32)*2)))fail();
  expected=expected.slice(0,ref.start*2)+v.executor.toLowerCase().slice(2).padStart(64,'0')+expected.slice((ref.start+32)*2);
 }
 if('0x'+expected!==v.factory.code.toLowerCase())fail();
 let masked=v.store.code.slice(2).toLowerCase();const used=new Set();
 if(masked.length!==v.build.runtimeTemplate.length-2)fail();
 for(const refs of Object.values(v.build.immutableReferences??{}) as any[]) {
  if(!Array.isArray(refs)||refs.length===0)fail();let value;
  for(const ref of refs) {
   if(!Number.isSafeInteger(ref.start)||ref.start<0||ref.length!==32||(ref.start+32)*2>masked.length||
    !/^0{64}$/.test(v.build.runtimeTemplate.slice(2+ref.start*2,2+(ref.start+32)*2)))fail();
   const actual=masked.slice(ref.start*2,(ref.start+32)*2);
   if(value!==undefined&&actual!==value)fail();value=actual;
   for(let i=ref.start;i<ref.start+32;i++){if(used.has(i))fail();used.add(i);}
   masked=masked.slice(0,ref.start*2)+'0'.repeat(64)+masked.slice((ref.start+32)*2);
  }
 }
 if('0x'+masked!==v.build.runtimeTemplate.toLowerCase())fail();
 const r=v.review;keys(r,['provider','jobId','artifactHash','report','reportHash']);
 if(r.provider!=='imd-audit-v1'||typeof r.jobId!=='string'||!/^[a-z0-9-]{1,128}$/.test(r.jobId)||
  typeof r.artifactHash!=='string'||!/^sha256:[0-9a-f]{64}$/.test(r.artifactHash)||typeof r.report!=='string'||
  r.report.length<20||Buffer.byteLength(r.report)>80000||hash(r.report)!==r.reportHash)fail();
}
