import {createPublicClient,http,keccak256,encodeFunctionData}from'viem';
import {requireThat}from'../src/shared/index.mjs';
import {dealAbi}from'../src/deals/index.mjs';
const json=value=>JSON.parse(JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v));
// A bad optional deal configuration disables only deal operations.
export function dealPorts(env=process.env,{clientFactory=createPublicClient,now=()=>Date.now()}={}){
 try{return configured(env,clientFactory,now);}catch{return{context:async()=>{throw Object.assign(Error('invalid_deal_pins'),{code:'invalid_deal_pins'});}};}
}
function configured(env,clientFactory,now){
 const pins=env.CLAUS_DEAL_PINS?JSON.parse(env.CLAUS_DEAL_PINS):[];requireThat(Array.isArray(pins)&&pins.length<=2,'invalid_deal_pins');const chains=new Map();
 for(const p of pins){requireThat([1,11155111].includes(p.chainId)&&!chains.has(p.chainId)&&/^0x[0-9a-fA-F]{40}$/.test(p.contract)&&/^0x[0-9a-fA-F]{64}$/.test(p.codeHash)&&/^0x[0-9a-fA-F]{40}$/.test(p.arbiter)&&/^0x[0-9a-fA-F]{40}$/.test(p.admissionController)&&/^[1-9][0-9]*$/.test(p.maximumDealWei??'')&&p.reviewed===true,'invalid_deal_pins');const raw=p.chainId===1?env.CLAUS_MAINNET_RPC_URL:env.CLAUS_SEPOLIA_RPC_URL;requireThat(raw,'chain_not_configured');const url=new URL(raw);requireThat(url.protocol==='https:','invalid_deal_pins');chains.set(p.chainId,{pin:p,client:clientFactory({transport:http(url.href,{retryCount:0,timeout:10000}),cacheTime:0}),immutable:null,cache:null,pending:null});}
 const call=(c,functionName,args=[])=>c.client.readContract({address:c.pin.contract,abi:dealAbi,functionName,args,blockNumber:c.block.number});
 async function verified(entry,chainId,confirmations=1){
  requireThat([1,3].includes(confirmations),'invalid_confirmation_policy');
  const [actual,head]=await Promise.all([entry.client.getChainId(),entry.client.getBlock()]);requireThat(actual===chainId&&head.number!==null,'deal_pin_mismatch');const block=confirmations===1?head:await entry.client.getBlock({blockNumber:head.number-2n});const code=await entry.client.getBytecode({address:entry.pin.contract,blockNumber:block.number});requireThat(code&&keccak256(code).toLowerCase()===entry.pin.codeHash.toLowerCase(),'deal_pin_mismatch');const c={pin:entry.pin,client:entry.client,block};
  if(!entry.immutable){const [arbiter,admissionController,maximumDeal,maximumPrincipal]=await Promise.all(['arbiter','admissionController','maximumDeal','maximumPrincipal'].map(n=>call(c,n)));requireThat(arbiter.toLowerCase()===entry.pin.arbiter.toLowerCase()&&admissionController.toLowerCase()===entry.pin.admissionController.toLowerCase()&&String(maximumDeal)===entry.pin.maximumDealWei,'deal_pin_mismatch');entry.immutable={arbiter,admissionController,maximumDealWei:String(maximumDeal),maximumPrincipalWei:String(maximumPrincipal)};}
  const enabled=await call(c,'fundingEnabled');return{...c,public:{enabled,chainId,contract:entry.pin.contract,codeHash:entry.pin.codeHash,...entry.immutable,blockNumber:String(block.number),blockHash:block.hash,observedBlockTime:String(block.timestamp),review:entry.pin.review??null}};
 }
 return {async context(chainId,{fresh=false,confirmations=1}={}){
  const entry=chains.get(chainId);requireThat(entry,'deals_not_enabled');if(fresh||confirmations!==1)return verified(entry,chainId,confirmations);if(entry.cache&&entry.cache.until>now())return entry.cache.value;if(entry.pending)return entry.pending;const pending=verified(entry,chainId).then(value=>{entry.cache={until:now()+1000,value};return value;});entry.pending=pending;try{return await pending;}finally{if(entry.pending===pending)entry.pending=null;}
 },async credit(c,account){return call(c,'credits',[account]);},async read(c,kind,id){const result=await call(c,kind==='deal'?'getDeal':'getPlan',[id]);requireThat(result.buyer!=='0x0000000000000000000000000000000000000000','not_found');return json(result);},
 async id(c,kind,sender,salt){return call(c,kind==='deal'?'dealId':'planId',[sender,salt]);},
 async prepare(c,{sender,method,args,value}){let gas;try{await c.client.simulateContract({address:c.pin.contract,abi:dealAbi,functionName:method,args,account:sender,value,blockNumber:c.block.number});gas=await c.client.estimateContractGas({address:c.pin.contract,abi:dealAbi,functionName:method,args,account:sender,value});}catch{throw Object.assign(Error('deal_simulation_failed'),{code:'deal_simulation_failed'});}return{transaction:{chainId:c.pin.chainId,from:sender,to:c.pin.contract,data:encodeFunctionData({abi:dealAbi,functionName:method,args}),value:String(value)},gasEstimate:String(gas),simulationBlock:String(c.block.number),simulation:'Preflight only; state may change before your transaction is mined.'};}
 };
}
