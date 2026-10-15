import {encodeFunctionData} from 'viem';
const same=(a:any,b:any)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const requireThat=(v:any,code:string)=>{if(!v)throw Error('work_wallet_sponsor_'+code);};
// The caller selects only an existing public task, never a contract, wallet,
// raw transaction or amount. The fixed escrow decides its original recipient.
export function prepareGasSettlement(input:any,payment:any,address:string,policies:any,now=Date.now()){
 const a=payment?.agreement,asset=a?.asset??'ETH';requireThat(asset==='ETH'||asset==='CLAUS','asset');
 const p=asset==='CLAUS'?policies.token:policies.eth,abi=asset==='CLAUS'?policies.tokenAbi:policies.ethAbi;
 requireThat(a?.chainId===1&&a.appId===input.projectId&&same(a.contract,p.contract)&&same(a.codeHash,p.codeHash)&&/^0x[0-9a-f]{64}$/i.test(a.id??''),'agreement');
 if(asset==='CLAUS')requireThat(same(a.token,p.token),'token');
 let t;try{t=JSON.parse(a.terms?.text);}catch{throw Error('work_wallet_sponsor_terms');}
 requireThat(t.appId===input.projectId&&t.taskId===input.taskId&&same(t.buyer,a.buyer)&&same(t.worker,a.worker)&&t.priceWei===a.priceWei&&t.chainId===1&&same(t.contract,a.contract)&&t.deliveryDue===a.deliveryDue,'terms');
 if(asset==='CLAUS')requireThat(t.asset==='CLAUS'&&same(t.token,p.token),'token');
 const stamp=Number(payment.observedBlockTime)*1000;requireThat(Number.isFinite(stamp)&&stamp<=now+30000&&now-stamp<=180000,'stale');
 const v=payment.value;requireThat(v&&same(v.buyer,a.buyer)&&same(v.worker,a.worker)&&same(v.termsHash,a.termsHash)&&same(v.projectId,a.projectHash)&&String(v.amount)===a.priceWei&&Number(v.deliveryDue)===a.deliveryDue,'chain_binding');
 if(payment.onchainState===5)return {id:a.id,state:'already-recorded',payment,transaction:null};
 requireThat([1,2,3,4].includes(payment.onchainState)&&Number(v.state)===payment.onchainState&&payment.nextActions?.includes('settle'),'not_due');
 const due=payment.onchainState<=2?Number(v.deliveryDue):payment.onchainState===3?Number(v.reviewDue):Number(v.resolutionDue);
 requireThat(Number.isSafeInteger(due)&&due>0&&Number(payment.observedBlockTime)>due,'not_due');
 return {id:a.id,state:'settlement-ready',payment,transaction:{chainId:1,from:address,to:p.contract,data:encodeFunctionData({abi,functionName:'settleExpired',args:[a.id]}),value:'0'}};
}
