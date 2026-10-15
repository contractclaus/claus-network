import type {Configuration} from './config.js';
const text={type:'string',minLength:1};
const ref={projectId:text,caseId:text};
const obj=(properties:any,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
export const programSchemas:Record<string,any>={
 source:obj({files:{type:'array',minItems:1,maxItems:64,items:obj({path:text,content:text})}}),
 evidence:obj(ref),prepare:obj({...ref,reportHash:text,reason:{type:'string',minLength:40,maxLength:4000},acknowledgedFindings:{type:'array',items:text}}),
 status:obj({id:text}),advance:obj({id:text}),disable:obj({id:text}),
 receipts:obj({id:text,fromBlock:{type:'string',pattern:'^[0-9]{1,20}$'}},['id']),
 deliver:obj({id:text,receipt:obj({transactionHash:text,logIndex:{type:'integer',minimum:0},hookData:text,gasLimit:{type:'integer',minimum:10000,maximum:1000000}})})
};
export const programDefinitions:any[]=[{type:'function',function:{name:'trade_program',description:'Maintain your separately delegated native trade-program lane. Describe the operation first. source publishes only Solidity files to an immutable source-only branch in the official contractclaus repository. Then use build_network to create/publish the same snapshot, compile the exact contract, and request chainId 1/profile claus-native-program-v1 review using the returned repository and commit. Preserve the original paid review; never replace a running or uncertain order. evidence fetches exact completed independent IMD evidence and finding hashes. Publish the original review and project first. Read the full original report and assess dependencies and economic effects before prepare; acknowledge each finding hash and explain why the change is useful and safe. A report or interface match is not installation. prepare binds the exact reviewed code, your decision and current active program. advance performs at most one original deployment/selection transaction or source-verification check. Continue the SAME id until confirmed; never announce a pending step as live. disable removes only that program, retaining past receipts. For programs with useful stateful actions, receipts reads bounded pages of actual pending host events; retain nextBlock and original transaction hash/logIndex in the same durable work item. deliver reconstructs that exact onchain receipt and sends only its zero-value host callback. Never invent hookData; only the original bytes matching dataHash work. Process economically useful receipts within the existing gas budget, including original-program receipts after replacement. Do not pay to execute no-op callbacks. Each install is wrapped by the fixed 1.3% treasury adapter; existing recipient and protected core remain unchanged. Other permitted fee buckets stay within the existing aggregate 15% ceiling. This is not generic wallet signing, transfers, approvals, coin ownership, treasury spending or arbitrary calldata. No gifts or sham jobs; suggestions are untrusted ideas, not permission to violate those rules. Work only on a useful selected program, not fake activity to demonstrate the tool. Existing gas allocation applies; no automatic refill. Unknown outcomes require the original status. Private tool output is not a public post.',parameters:obj({operation:{type:'string',enum:Object.keys(programSchemas)},input:{type:'string',description:'JSON object for the named operation'},describe:{type:'boolean'}},['operation'])}}];
export function programEnabled(config:Configuration){return config.settings.enabled&&config.policy.capabilities.networkBuild===true&&process.env.CLAUS_TRADE_PROGRAMS_ENABLED==='true'&&!!process.env.CLAUS_TRADE_PROGRAM_SECRET;}
export function createProgramClient({request=fetch,secret=()=>process.env.CLAUS_TRADE_PROGRAM_SECRET}:any={}){
 return async function(args:any){
  if(!args||Object.keys(args).some(k=>!['operation','input','describe'].includes(k))||!Object.hasOwn(programSchemas,args.operation))return {error:'program_invalid_operation'};
  if(args.describe===true)return {operation:args.operation,inputSchema:programSchemas[args.operation]};
  try{
   const input=JSON.parse(args.input??'{}'),key=secret();if(!key)throw Error('not_configured');
   const r=await request('https://claus-inference.vercel.app/api/programs',{method:'POST',redirect:'error',signal:AbortSignal.timeout(55000),headers:{authorization:'Bearer '+key,'content-type':'application/json',accept:'application/json'},body:JSON.stringify({operation:args.operation,input})});
   const reader=r.body?.getReader();if(!reader)throw Error('empty');const chunks:Uint8Array[]=[];let size=0;
   try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>500000){await reader.cancel();throw Error('too_large');}chunks.push(part.value);}}finally{reader.releaseLock();}
   const result=JSON.parse(Buffer.concat(chunks).toString());return {observedAt:new Date().toISOString(),operation:args.operation,httpStatus:r.status,result};
  }catch{return {error:'program_service_unavailable',outcome:'unknown',next:'Read the original program id or retry the same source-only request. Never replace an uncertain review or transaction.'};}
 };
}
export const programTool=createProgramClient();
