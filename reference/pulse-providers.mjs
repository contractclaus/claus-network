import {encodeAbiParameters} from 'viem';
import {requireThat,digest} from '../src/shared/index.mjs';
const string=maxLength=>({type:'string',maxLength});
const integer={type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER};
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const status={...string(8),enum:['ok','probe']};
export const observationSchema=object({status,chainId:{type:'integer',minimum:1,maximum:11155111},blockNumber:integer,blockHash:string(66),
 observedAt:integer,baseFeeWei:string(78),finality:{...string(10),enum:['finalized','none']},onchainData:string(322)});
export const evaluationSchema=object({status,observation:observationSchema,aboveThreshold:{type:'boolean'},thresholdWei:string(78),
 ruleVersion:integer,onchainData:string(322)});
export const pulseDefinitions={
 observer:{name:'Network Pulse Observer',capability:'chain.observation.v1',version:'1.0.0',
  inputSchema:object({chainId:{type:'integer',minimum:1,maximum:11155111}}),outputSchema:observationSchema},
 evaluator:{name:'Network Pulse Evaluator',capability:'signal.evaluate.v1',version:'1.0.0',
  inputSchema:object({observation:observationSchema,thresholdWei:string(78),ruleVersion:integer}),outputSchema:evaluationSchema},
 consumer:{name:'Network Pulse Consumer',capability:'signal.consume.v1',version:'1.0.0',
  inputSchema:object({evaluation:evaluationSchema}),outputSchema:evaluationSchema}
};
const probeObservation=chainId=>({status:'probe',chainId,blockNumber:0,blockHash:'',observedAt:0,baseFeeWei:'0',finality:'none',onchainData:'0x'});
const uint=x=>typeof x==='string'&&/^(0|[1-9][0-9]{0,77})$/.test(x)&&BigInt(x)<2n**256n;
export function pulseData(observation){
 return encodeAbiParameters([{type:'uint256'},{type:'uint64'},{type:'bytes32'},{type:'uint64'},{type:'uint256'}],
  [BigInt(observation.chainId),BigInt(observation.blockNumber),observation.blockHash,BigInt(observation.observedAt),BigInt(observation.baseFeeWei)]);
}
function validObservation(o,chainId,now){
 requireThat(o?.status==='ok'&&o.chainId===chainId&&o.finality==='finalized'&&Number.isSafeInteger(o.blockNumber)&&o.blockNumber>0&&
  /^0x[0-9a-f]{64}$/.test(o.blockHash)&&uint(o.baseFeeWei)&&Number.isSafeInteger(o.observedAt)&&o.observedAt>0&&
  o.observedAt<=Math.floor(now()/1000)&&o.observedAt>Math.floor(now()/1000)-3600&&pulseData(o)===o.onchainData,'pulse_observation_invalid');
}
export function createPulseProvider({role,chainId,primary,secondary,now=Date.now}){
 requireThat(Object.hasOwn(pulseDefinitions,role)&&[1,11155111].includes(chainId),'invalid_reference_configuration');
 async function corroborate(o){
  validObservation(o,chainId,now);
  requireThat(await secondary.getChainId()===chainId,'wrong_chain');
  const [block,final]=await Promise.all([secondary.getBlock({blockNumber:BigInt(o.blockNumber)}),secondary.getBlock({blockTag:'finalized'})]);
  requireThat(block.hash===o.blockHash&&block.timestamp===BigInt(o.observedAt)&&block.baseFeePerGas===BigInt(o.baseFeeWei)&&
   final.number>=block.number,'pulse_source_mismatch');
 }
 return {async execute(input,{purpose}={}){
  if(purpose==='conformance')return role==='observer'?probeObservation(chainId):
   {status:'probe',observation:probeObservation(chainId),aboveThreshold:false,thresholdWei:'1',ruleVersion:1,onchainData:'0x'};
  if(role==='observer'){
   requireThat(input.chainId===chainId&&await primary.getChainId()===chainId,'wrong_chain');
   const b=await primary.getBlock({blockTag:'finalized'});
   const observation={status:'ok',chainId,blockNumber:Number(b.number),blockHash:b.hash,observedAt:Number(b.timestamp),
    baseFeeWei:String(b.baseFeePerGas),finality:'finalized'};observation.onchainData=pulseData(observation);
   await corroborate(observation);return observation;
  }
  const o=role==='evaluator'?input.observation:input.evaluation?.observation;
  validObservation(o,chainId,now);await corroborate(o);
  const e=role==='evaluator'?input:input.evaluation;
  requireThat(uint(e.thresholdWei)&&BigInt(e.thresholdWei)>0n&&Number.isSafeInteger(e.ruleVersion)&&e.ruleVersion>0,'pulse_rule_invalid');
  const output={status:'ok',observation:o,aboveThreshold:BigInt(o.baseFeeWei)>=BigInt(e.thresholdWei),thresholdWei:e.thresholdWei,
   ruleVersion:e.ruleVersion,onchainData:o.onchainData};
  if(role==='consumer')requireThat(digest(output)===digest(e),'pulse_evaluation_mismatch');
  return output;
 }};
}

// Each provider receives only its own API credential. Claims and redelivery
// retain their order identity; a lost lease waits for the same order to reopen.
export function createPulseProviderWorker({client,projectId,serviceId,provider,now=Date.now}){
 return {async tick(){
  let after='',delivered=0,failed=0;
  for(let pages=0;pages<10;pages++){
   const page=await client.call('provider_orders',{projectId,...(after?{after}:{}),limit:100});
   for(const order of page.orders){
    if(order.serviceId!==serviceId||order.leaseUntil>now())continue;
    let claim;try{claim=await client.call('provider_claim',{projectId,orderId:order.id});}
    catch(error){if(error.code==='service_order_busy')continue;throw error;}
    if(claim.state!=='working')continue;
    try {
     const output=await provider.execute(claim.input,{purpose:claim.purpose});
     await client.call('provider_deliver',{projectId,orderId:order.id,lease:claim.lease,output});
     delivered++;
    } catch { failed++; /* Retain the original order; its lease/deadline handles retry. */ }
    if(delivered===4||delivered+failed===8)return {state:failed?'degraded':'ready',delivered,failed};
   }
   if(!page.nextCursor)break;after=page.nextCursor;
  }
  return {state:failed?'degraded':'ready',delivered,failed};
 }};
}
