import {keccak256} from 'viem';
// Context validation is independent of admission. The controller must also
// check the exact allowed registry before requesting or signing any decision.
export function validateManagedContext(m:any,p:any,blockNumber:string,source:(s:any)=>void,hash:(v:any)=>string,canonical:(v:any)=>string) {
 const fail=()=>{throw Error('network_review_invalid_input');};
 const word=(v:any)=>typeof v==='string'&&/^0x[a-fA-F0-9]{64}$/.test(v);
 const address=(v:any)=>typeof v==='string'&&/^0x[a-fA-F0-9]{40}$/.test(v);
 const equal=(a:any,b:any)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
 const keys=(v:any,names:string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==names.sort().join(','))fail();};
 keys(m,['profile','target','targetCodeHash','registry','registryCodeHash','projectKey','version','implementation','codeHash','configuration','initial','previous']);
 if(m.profile!=='claus-managed-v1'||!equal(m.target,p.target)||!equal(m.registry,p.executor)||m.projectKey!==p.projectKey||
  m.version!==p.fromVersion||m.codeHash!==p.fromCodeHash||!address(m.implementation)||!word(m.targetCodeHash)||!word(m.registryCodeHash)||
  typeof m.configuration!=='string'||!/^0x(?:[a-f0-9]{2}){0,8192}$/i.test(m.configuration))fail();
 const i=m.initial;keys(i,['implementation','codeHash','initCallHash','createdAtBlock']);
 if(!address(i.implementation)||!word(i.codeHash)||!word(i.initCallHash)||typeof i.createdAtBlock!=='string'||
  !/^[1-9][0-9]{0,19}$/.test(i.createdAtBlock)||BigInt(i.createdAtBlock)>BigInt(blockNumber))fail();
 if(m.version===0){
  if(m.previous!==null||!/^0x0{40}$/i.test(m.implementation)||!/^0x0{64}$/i.test(m.codeHash)||m.configuration!=='0x'||
   !equal(i.implementation,p.implementation)||i.codeHash!==p.toCodeHash||i.initCallHash!==keccak256(p.configuration))fail();
  return;
 }
 const old=m.previous;keys(old,['build','source','implementation','code','codeHash']);source(old.source);
 const b=old.build,s=old.source;
 if(!equal(old.implementation,m.implementation)||old.codeHash!==m.codeHash||typeof old.code!=='string'||
  !/^0x(?:[a-f0-9]{2}){1,24576}$/i.test(old.code)||keccak256(old.code)!==old.codeHash||
  !b||hash(b)!==s.buildHash||b.status!=='compiled'||b.profile?.profile!=='solidity-managed-compile-v1'||b.standardInput?.settings?.metadata?.appendCBOR!==false||
  b.profile.compiler!=='0.8.27+commit.40a35a09.Emscripten.clang'||b.entry!==s.entry||hash(b.standardInput)!==b.inputHash||
  canonical(b.standardInput.sources)!==canonical(Object.fromEntries(s.files.filter((f:any)=>f.path.endsWith('.sol')).map((f:any)=>[f.path,{content:f.content}])))||
  !b.immutableReferences||Object.keys(b.immutableReferences).length!==0||b.runtimeTemplate!==old.code||b.runtimeTemplateHash!==old.codeHash||
  !b.storageLayout||!Array.isArray(b.storageLayout.storage))fail();
 const bytes=Buffer.from(old.code.slice(2),'hex');
 for(let n=0;n<bytes.length;n++){if([0xf2,0xf4,0xff].includes(bytes[n]))fail();if(bytes[n]>=0x60&&bytes[n]<=0x7f)n+=bytes[n]-0x5f;}
}
