import type {Configuration} from './config.js';
const text={type:'string',minLength:1};
const object=(properties:any,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
export const capitalSchemas:Record<string,any>={overview:object({}),guide:object({}),template:object({}),source:object({files:{type:'array',minItems:1,maxItems:64,items:object({path:text,content:text})}}),evidence:object({projectId:text,caseId:text}),prepare:object({reference:object({projectId:text,caseId:text}),reportHash:text,reason:{type:'string',minLength:40,maxLength:4000},acknowledgedFindings:{type:'array',items:text}}),advance:object({id:text}),status:object({id:text})};
export const capitalDefinitions:any[]=[{type:'function',function:{name:'capital_execution',description:'Execute your owner-approved, independently reviewed third-party investment. Self-token launches are forbidden; the legacy fixed-owner launch adapter is disabled. Read guide and overview first. The single approved envelope is 100 Base USDC once (max25/project across tranches) ; historical .02 ETH launch allocation is not current launch permission; no recycling or refill. Existing operating reserves and unknown holds remain. These are not gifts or arbitrary wallet signatures. Use actual projects and consideration, never a demonstration investment or token. Source publishes Solidity through the existing official source publisher. Use build_network with the exact compiled snapshot, public review profile claus-capital-v1 and capitalJson as described in guide. Preserve original review IDs. evidence reads settled published independent review and finding hashes; prepare binds your assessment, exact terms, review and transaction. Investment template is a fixed Base-USDC agreement deployed/relayed by its real counterparty; funding and milestone release have separate reviewed decisions. advance returns only a payee-bound relay transaction for that escrow, never wallet keys. status(id) reconciles the original investment; use its signatureId for advance. Claus must not issue any additional token for himself, including via another name or an agent he controls. Only genuinely independent participants may issue future project tokens via the still-missing dedicated Programmable gateway. Launch status is retained solely for original receipt recovery; prepare/unsigned advance cannot launch. Repeat the same original ID after timeouts; do not create replacements or manually spend around a held operation. Research proposals alone are not investments; funds are never guaranteed to earn a return. Do not publish private deal terms or signatures.',parameters:object({operation:{type:'string',enum:Object.keys(capitalSchemas)},input:{type:'string'},describe:{type:'boolean'}},['operation'])}}];
export const capitalEnabled=(c:Configuration)=>c.settings.enabled&&c.policy.capabilities.networkBuild===true&&process.env.CLAUS_CAPITAL_EXECUTION_ENABLED==='true'&&!!process.env.CLAUS_CAPITAL_EXECUTION_SECRET;
export async function capitalTool(args:any){
 if(!args||Object.keys(args).some(k=>!['operation','input','describe'].includes(k))||!Object.hasOwn(capitalSchemas,args.operation))return {error:'capital_invalid_operation'};
 if(args.describe===true)return {operation:args.operation,inputSchema:capitalSchemas[args.operation]};
 try{
  const input=JSON.parse(args.input??'{}'),r=await fetch('https://claus-inference.vercel.app/api/capital',{method:'POST',redirect:'error',signal:AbortSignal.timeout(55000),headers:{authorization:'Bearer '+process.env.CLAUS_CAPITAL_EXECUTION_SECRET,'content-type':'application/json'},body:JSON.stringify({operation:args.operation,input})});
  const raw=await r.text();if(Buffer.byteLength(raw)>2000000)throw Error('size');return {operation:args.operation,httpStatus:r.status,result:JSON.parse(raw),observedAt:new Date().toISOString()};
 }catch{return {error:'capital_service_unavailable',outcome:'unknown',next:'Inspect the original decision/investment/launch ID. Never replace a potentially signed operation.'};}
}

// Only a finalized investment observation or verified live launch is completion evidence.
// Preparation and relay signatures remain private progress, not financial execution.
export function completedCapitalReceipt(value:any){
 if(value?.operation!=='status'||!Number.isInteger(value.httpStatus)||value.httpStatus<200||value.httpStatus>=300)return false;
 const result=value.result,word=(v:unknown)=>typeof v==='string'&&/^0x[a-f0-9]{64}$/i.test(v);
 if(/^capital-investment:[a-f0-9]{64}$/.test(result?.id??'')){
  const o=result.observation;
  return o?.finalized===true&&o.used===true&&[1,2,3].includes(o.state)&&word(o.blockHash)&&word(o.nonce)&&typeof o.blockNumber==='string'&&/^[1-9][0-9]*$/.test(o.blockNumber)&&typeof result.spent==='string'&&/^[1-9][0-9]*$/.test(result.spent);
 }
 if(/^capital-launch:[a-f0-9]{64}$/.test(result?.id??''))return result.live===true&&word(result.registration?.transactionHash)&&result.result?.result?.confirmation==='safe'&&result.result?.result?.receipt?.status==='success'&&Array.isArray(result.verification)&&result.verification.length>0&&result.verification.every((r:any)=>r.verified===true);
 return false;
}
