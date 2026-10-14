import {createPublicClient,http,fallback,keccak256,encodeFunctionData}from'viem';
import {requireThat}from'../src/shared/index.mjs';
import {dealAbi}from'../src/deals/abi.mjs';
import {tokenDealAbi,paymentTokenAbi}from'../src/deals/token-abi.mjs';
import {dealAsset,isTokenDeal}from'../src/deals/assets.mjs';
const json=value=>JSON.parse(JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v));
const address=value=>/^0x[0-9a-fA-F]{40}$/.test(value??'')&&!/^0x0{40}$/i.test(value);
export function dealPorts(env=process.env,{clientFactory=createPublicClient,now=()=>Date.now()}={}){
 try{return configured(env,clientFactory,now);}catch{return{context:async()=>{throw Object.assign(Error('invalid_deal_pins'),{code:'invalid_deal_pins'});}};}
}
function configured(env,clientFactory,now){
 const pins=env.CLAUS_DEAL_PINS?JSON.parse(env.CLAUS_DEAL_PINS):[];requireThat(Array.isArray(pins)&&pins.length<=4,'invalid_deal_pins');const entries=new Map(),contracts=new Set();
 for(const p of pins){
  const asset=dealAsset(p.asset),key=p.chainId+':'+asset,contractKey=p.chainId+':'+p.contract?.toLowerCase();
  requireThat([1,11155111].includes(p.chainId)&&!entries.has(key)&&!contracts.has(contractKey)&&address(p.contract)&&/^0x[0-9a-fA-F]{64}$/.test(p.codeHash)&&address(p.arbiter)&&address(p.admissionController)&&/^[1-9][0-9]*$/.test(p.maximumDealWei??'')&&p.reviewed===true,'invalid_deal_pins');
  if(isTokenDeal(asset))requireThat(address(p.token)&&p.decimals===18&&/^[1-9][0-9]*$/.test(p.minimumReviewUnits??''),'invalid_deal_pins');
  const raw=p.chainId===1?env.CLAUS_MAINNET_RPC_URL:env.CLAUS_SEPOLIA_RPC_URL;requireThat(raw,'chain_not_configured');const url=new URL(raw);requireThat(url.protocol==='https:','invalid_deal_pins');
  const backup=p.chainId===1?'https://ethereum-rpc.publicnode.com':'https://ethereum-sepolia-rpc.publicnode.com';
  const urls=[...new Set([url.href,new URL(backup).href])];contracts.add(contractKey);
  entries.set(key,{pin:p,asset,abi:isTokenDeal(asset)?tokenDealAbi:dealAbi,client:clientFactory({transport:fallback(urls.map(u=>http(u,{retryCount:0,timeout:5000})),{retryCount:0,rank:false}),cacheTime:0}),immutable:null,cache:null,pending:null});
 }
 const call=(c,functionName,args=[])=>c.client.readContract({address:c.pin.contract,abi:c.abi,functionName,args,blockNumber:c.block.number});
 async function verified(entry,chainId,confirmations=1){
  requireThat([1,3].includes(confirmations),'invalid_confirmation_policy');
  const [actual,head]=await Promise.all([entry.client.getChainId(),entry.client.getBlock()]);requireThat(actual===chainId&&head.number!==null,'deal_pin_mismatch');
  const block=confirmations===1?head:await entry.client.getBlock({blockNumber:head.number-2n});const code=await entry.client.getBytecode({address:entry.pin.contract,blockNumber:block.number});
  requireThat(code&&keccak256(code).toLowerCase()===entry.pin.codeHash.toLowerCase(),'deal_pin_mismatch');const c={pin:entry.pin,client:entry.client,block,abi:entry.abi,asset:entry.asset};
  if(!entry.immutable){
   const [arbiter,admissionController,maximumDeal,maximumPrincipal]=await Promise.all(['arbiter','admissionController','maximumDeal','maximumPrincipal'].map(n=>call(c,n)));
   requireThat(arbiter.toLowerCase()===entry.pin.arbiter.toLowerCase()&&admissionController.toLowerCase()===entry.pin.admissionController.toLowerCase()&&String(maximumDeal)===entry.pin.maximumDealWei,'deal_pin_mismatch');
   let assetInfo={};
   if(isTokenDeal(entry.asset)){
    const token=await call(c,'token');requireThat(token.toLowerCase()===entry.pin.token.toLowerCase(),'deal_pin_mismatch');
    const decimals=await c.client.readContract({address:token,abi:paymentTokenAbi,functionName:'decimals',blockNumber:block.number});requireThat(decimals===18,'deal_pin_mismatch');
    assetInfo={asset:'CLAUS',token,decimals,minimumReviewUnits:entry.pin.minimumReviewUnits};
   }
   entry.immutable={arbiter,admissionController,maximumDealWei:String(maximumDeal),maximumPrincipalWei:String(maximumPrincipal),...assetInfo};
  }
  const enabled=await call(c,'fundingEnabled');return{...c,public:{enabled,chainId,contract:entry.pin.contract,codeHash:entry.pin.codeHash,...entry.immutable,blockNumber:String(block.number),blockHash:block.hash,observedBlockTime:String(block.timestamp),review:entry.pin.review??null}};
 }
 async function prepareAt(c,{sender,to,abi,method,args,value=0n}){
  let gas;try{await c.client.simulateContract({address:to,abi,functionName:method,args,account:sender,value,blockNumber:c.block.number});gas=await c.client.estimateContractGas({address:to,abi,functionName:method,args,account:sender,value});}catch{throw Object.assign(Error('deal_simulation_failed'),{code:'deal_simulation_failed'});}
  return{transaction:{chainId:c.pin.chainId,from:sender,to,data:encodeFunctionData({abi,functionName:method,args}),value:String(value)},gasEstimate:String(gas),simulationBlock:String(c.block.number),simulation:'Preflight only; state may change before your transaction is mined.'};
 }
 return {
  async context(chainId,{fresh=false,confirmations=1,asset='ETH'}={}){
   const entry=entries.get(chainId+':'+dealAsset(asset));requireThat(entry,'deals_not_enabled');if(fresh||confirmations!==1)return verified(entry,chainId,confirmations);
   if(entry.cache&&entry.cache.until>now())return entry.cache.value;if(entry.pending)return entry.pending;
   const pending=verified(entry,chainId).then(value=>{entry.cache={until:now()+1000,value};return value;});entry.pending=pending;try{return await pending;}finally{if(entry.pending===pending)entry.pending=null;}
  },
  async credit(c,account){return call(c,'credits',[account]);},
  async read(c,kind,id){const result=await call(c,kind==='deal'?'getDeal':'getPlan',[id]);requireThat(result.buyer!=='0x0000000000000000000000000000000000000000','not_found');return json(result);},
  async id(c,kind,sender,salt){return call(c,kind==='deal'?'dealId':'planId',[sender,salt]);},
  async approval(c,{sender,amount}){
   requireThat(isTokenDeal(c.asset)&&amount>0n&&amount<=BigInt(c.public.maximumPrincipalWei),'invalid_amount');
   const token=c.public.token,read=(functionName,args)=>c.client.readContract({address:token,abi:paymentTokenAbi,functionName,args,blockNumber:c.block.number});
   const [balance,allowance,locked,credits]=await Promise.all([read('balanceOf',[sender]),read('allowance',[sender,c.pin.contract]),call(c,'totalLocked'),call(c,'totalCredits')]);
   requireThat(balance>=amount,'insufficient_deal_token_balance');
   requireThat(locked+credits+amount<=BigInt(c.public.maximumPrincipalWei),'deal_capacity_reached');
   if(allowance>=amount)return null;
   return {...await prepareAt(c,{sender,to:token,abi:paymentTokenAbi,method:'approve',args:[c.pin.contract,amount]}),approval:{asset:'CLAUS',token,spender:c.pin.contract,amountUnits:String(amount)}};
  },
  async prepare(c,{sender,method,args,value}){return prepareAt(c,{sender,to:c.pin.contract,abi:c.abi,method,args,value});}
 };
}
