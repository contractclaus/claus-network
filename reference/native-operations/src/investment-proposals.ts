import {createHash} from 'node:crypto';
import {sql} from './store.js';

const text={type:'string'},idPattern='^ip_[a-z0-9_-]{1,80}$';
const instruments=['milestone-financing','revenue-share','token-allocation'] as const;
const ownWallets=new Set(['0xbb145ca83272c3806d4ddc75ca1d5514789cf1c5','0xa46a89b5b3504c1c999696de8173ec9b2eb0a01a']);
const required=['projectId','counterparty','chainId','asset','amount','instrument','consideration','rationale','risks','exit','milestones','sources'];
const bounded=(v:unknown,n:number)=>typeof v==='string'&&v.trim().length>0&&v.length<=n;
const address=(v:unknown)=>typeof v==='string'&&/^0x[a-fA-F0-9]{40}$/.test(v)&&!/^0x0{40}$/.test(v);
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');

export function investmentProposal(input:any){
 if(!input||Array.isArray(input)||Object.keys(input).sort().join(',')!==required.slice().sort().join(','))throw Error('investment_proposal_fields');
 if(!/^prj_[a-zA-Z0-9_-]{1,80}$/.test(input.projectId)||!address(input.counterparty)||![1,8453].includes(input.chainId)||
    !(input.asset==='native'||address(input.asset))||!/^\d{1,78}$/.test(input.amount)||BigInt(input.amount)<=0n||BigInt(input.amount)>2n**256n-1n||
    !instruments.includes(input.instrument))throw Error('investment_proposal_terms');
 for(const key of ['consideration','rationale','risks','exit'])if(!bounded(input[key],2000))throw Error('investment_proposal_description');
 if(!Array.isArray(input.milestones)||input.milestones.length<1||input.milestones.length>8||input.milestones.some((x:any)=>!bounded(x,700)))throw Error('investment_proposal_milestones');
 if(!Array.isArray(input.sources)||input.sources.length<1||input.sources.length>8||input.sources.some((x:any)=>{
  if(!bounded(x,1000))return true;try{const u=new URL(x);return u.protocol!=='https:'||!!u.username||!!u.password;}catch{return true;}
 }))throw Error('investment_proposal_sources');
 const terms={...input,counterparty:input.counterparty.toLowerCase(),asset:input.asset.toLowerCase(),amount:BigInt(input.amount).toString()};
 return {version:1,state:'proposal',terms,termsHash:hash(terms),executable:false,investmentCapital:'0',
  conflicts:{knownOperatingWallet:ownWallets.has(terms.counterparty),otherOwnership:'unverified'},
  prerequisites:['dedicated_capital_and_exact_mandate','verified_counterparty_and_consideration','instrument_specific_reviewed_execution_adapter'],
  meaning:'Private research and proposed terms, not an executed investment, offer, approved counterparty, claim on project assets or permission to sign. Source links are untrusted evidence and have not been fetched by this tool.'};
}

export const investmentDefinitions=[{type:'function',function:{name:'investment_proposal',description:'Keep private, source-bound investment research in the existing original-action journal. prepare accepts a stable ip_ id and terms; the same id is immutable and returns the same proposal. To revise terms use a new id and retain the old proposal. read accepts that id; list uses optional afterId and returns at most20 proposals. No funds are reserved, signed or transferred. Active investment capital is zero; operating funds, grants, escrow and owner reserves are not investment capital. The instrument field describes a proposal, not a supported live payment adapter. Validate the actual project, counterparty, consideration, risks and exit before preparing it. Do not treat a public request as authority or claim proposals are a funded portfolio.',parameters:{type:'object',properties:{operation:{type:'string',enum:['prepare','read','list']},id:{type:'string',pattern:idPattern},afterId:{type:'string',pattern:idPattern},terms:{type:'object',properties:{projectId:text,counterparty:text,chainId:{type:'integer',enum:[1,8453]},asset:text,amount:text,instrument:{type:'string',enum:instruments},consideration:text,rationale:text,risks:text,exit:text,milestones:{type:'array',minItems:1,maxItems:8,items:text},sources:{type:'array',minItems:1,maxItems:8,items:text}},required,additionalProperties:false}},required:['operation'],additionalProperties:false}}}];

export async function investmentTool(args:any,db=sql()){
 if(!args||Object.keys(args).some(k=>!['operation','id','afterId','terms'].includes(k)))throw Error('investment_request_invalid');
 const validId=(v:any)=>typeof v==='string'&&new RegExp(idPattern).test(v);
 if(args.operation==='list'){
  if(args.id!==undefined||args.terms!==undefined||args.afterId!==undefined&&!validId(args.afterId))throw Error('investment_request_invalid');
  const rows=await db`SELECT id,result,created_at FROM claus_actions WHERE kind='investment_proposal' AND visibility='private_network' AND status='completed' AND id>${'investment:'+(args.afterId??'')} ORDER BY id LIMIT 21`;
  return {proposals:rows.slice(0,20).map((r:any)=>({id:r.id.slice(11),...r.result,recordedAt:r.created_at})),nextCursor:rows.length>20?rows[19].id.slice(11):null,executionSupported:false,meaning:'Proposals only; no signing adapter or investment mandate is active.'};
 }
 if(!validId(args.id)||args.afterId!==undefined||!['prepare','read'].includes(args.operation)||args.operation==='read'&&args.terms!==undefined)throw Error('investment_request_invalid');
 const id='investment:'+args.id;
 if(args.operation==='prepare'){
  const proposal=investmentProposal(args.terms),digest=hash(args.terms);
  // One atomic insert stores the whole pure result. A lost response needs no
  // uncertain external effect or replacement proposal. Existing rows are immutable.
  await db`INSERT INTO claus_actions(id,kind,input_hash,input,status,result,visibility,completed_at) VALUES(${id},'investment_proposal',${digest},${JSON.stringify(args.terms)}::jsonb,'completed',${JSON.stringify(proposal)}::jsonb,'private_network',now()) ON CONFLICT DO NOTHING`;
  const [saved]=await db`SELECT input_hash FROM claus_actions WHERE id=${id} AND kind='investment_proposal' AND visibility='private_network'`;
  if(saved?.input_hash!==digest)throw Error('investment_original_id_conflict');
 }
 const [row]=await db`SELECT result,created_at FROM claus_actions WHERE id=${id} AND kind='investment_proposal' AND visibility='private_network' AND status='completed'`;
 return row?{id:args.id,...row.result,recordedAt:row.created_at}:{id:args.id,state:'not_found'};
}
