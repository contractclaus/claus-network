import {encodeFunctionData,parseAbi,keccak256} from 'viem';
import {WEATHER} from './weather-proof.js';

const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const manager='0x000000000004444c5dc75cb358380d2e3de08a90';
const fomo='0x72d94600a7a57afb6a2090e9739fd8ab21e02eb2';
const balanceAbi=parseAbi(['function balanceOf(address owner,uint256 id) view returns(uint256)']);
// Historical execution provenance, not permission to activate these implementations.
// Current signing still requires the independently configured live runtime hash.
const profiles=[
 {"direct":true,"base":"0xa62f9b597225779b430024398b70374e8468ce14","baseHash":"0x0135248dad9b583303bf5803c27523bc88fa012dd8823309c216423ca786dd89"},
 {"wrapper":"0xd770a418310bc8fd164aac5f1e1e3f4159102f2c","wrapperHash":"0x8dda0e80ba0a14af6102fc82777410b5266076e89d9785b82ebb8cab4ff7b846","base":"0x3b1b1a7c8db9bbbafa073996cfcf0b87d7b45ddd","baseHash":"0xb738d8780a47c0487cff7bf20d84072a6fe18ad6780f15f641c6be2633fafd53"},
 {direct:true,base:'0x3b1b1a7c8db9bbbafa073996cfcf0b87d7b45ddd',baseHash:'0xb738d8780a47c0487cff7bf20d84072a6fe18ad6780f15f641c6be2633fafd53'},
 {"wrapper":"0x19143522eab522bdd1ef0084223434c3de8fee5d","wrapperHash":"0x56c94696ac8efaf4cadf03ff6102383e294c5b8bfd732ed9a4da105cb322f296","base":"0x3b1b1a7c8db9bbbafa073996cfcf0b87d7b45ddd","baseHash":"0xb738d8780a47c0487cff7bf20d84072a6fe18ad6780f15f641c6be2633fafd53"},
 {"wrapper":"0xaa92235a30281cecc319cc778533e318421556f7","wrapperHash":"0x79a337676ef68082a107a5e3a78501da572cb2a97c04f04603262a6600dab3df","base":"0x2d80fdc6635a3f8e3c6657f48ea8a994fa3d48a6","baseHash":"0xb81cb8c70e8108a5bad70b652d3e542e6c937c6c70b91b5f8f071428ff6b2a37"},
 {wrapper:'0xfd00e716ca82bc06d889e5c3ea1993d55b8db189',wrapperHash:'0x23fb34250f05c786582a5b2a9201dc313afb5ae176fd35e46903f1225f85b916',base:'0x7cea48ada9d708983998b276d90f21724e5857d8',baseHash:'0x5e42d021ffabd29a7f21c2124edb0bc30daa3a881cc598cc736c0fa69c5cdbdb'},
 {wrapper:'0x1e0a0bac9f3894d37eb2225afd324ba5b6a2a3af',wrapperHash:'0xb93f8cccea24f71d0f702733721b2751adb8732e4e3bf56d9ca2bfd9ef7a9ca9',
  base:'0xd295a4c2eebed56da7f284d2723b58769de3360a',baseHash:'0x9eb42da573bd2be582653a40cfdfc12d64230c5bbf248cabc098f7935e59d8a7'},
 {wrapper:'0x8e53536400a15d7abb5daf4dfe34ed21c3652ea0',wrapperHash:'0xcff35f3f4b09afa3764b3e70b65decbcdac84c51d655419b24f0162abcaf166d',
  base:'0x24f1f46329ed3288b5d0975aca64e8d2050c3622',baseHash:'0xd2da43e43c2c03393274327c00446b0109a09787713b3bbcb5c1a109c9f0be26'},
 {wrapper:'0xaebda3764352a9467498d094e4bda35b3a77de8a',wrapperHash:'0x39d7a223cb175bfcfb11b8aea9cf351da8a214a8cbae55d5349ab168c18d229c',
  base:'0xa3c091c68f67d66edda4fbf167ff868fb361a74b',baseHash:'0x69c2b28cfbd9dcbadbb81f0b3b60dfe946f260d041605bb51e7390d1fab9691c'},
];

// InvalidBatch also means bad input, an empty reserve or an expired deadline.
// Only prove the observed balance-growth case, using reads *inside* execution:
// parent/end-of-block balances cannot establish the state at this transaction.
function guardedBatchEvidence(trace,args,timestamp,expired=false){
 try{
  if(trace.type!=='CALL'||!same(trace.to,WEATHER.hook)||trace.error!=='execution reverted'||
    !same(trace.output,'0x33b094a1')||trace.calls?.length!==1||args[0]<=0n||args[1]<=0n||
    (expired ? args[2]<=0n||timestamp<=args[2] : timestamp>args[2]||args[2]>timestamp+300n))return null;
  const wrapper=trace.calls[0],profile=profiles.find(p=>same(p.direct?p.base:p.wrapper,wrapper.to));
  if(!profile)return null;
  const delegates=wrapper.calls?.filter(c=>c.type==='DELEGATECALL')??[];
  if(!profile.direct&&delegates.length!==1)return null;
  const base=profile.direct?wrapper:delegates[0];
  const frames=profile.direct?[[base,profile.base]]:[[wrapper,profile.wrapper],[base,profile.base]];
  for(const [frame,to] of frames){
   if(frame.type!=='DELEGATECALL'||!same(frame.from,WEATHER.hook)||!same(frame.to,to)||
     !same(frame.input,trace.input)||frame.error!=='execution reverted'||!same(frame.output,'0x33b094a1')||
     BigInt(frame.value??'0x0')!==0n)return null;
  }
  if(base.calls?.length!==2)return null;
  const owners=[fomo,WEATHER.hook];let pending=0n;
  for(const owner of owners){
   const input=encodeFunctionData({abi:balanceAbi,functionName:'balanceOf',args:[owner,0n]});
   const matches=base.calls.filter(c=>same(c.input,input));
   if(matches.length!==1)return null;
   const frame=matches[0];
   if(frame.type!=='STATICCALL'||!same(frame.from,WEATHER.hook)||!same(frame.to,manager)||
     frame.error||frame.calls?.length||!/^0x[0-9a-fA-F]{64}$/.test(frame.output)||BigInt(frame.value??'0x0')!==0n)return null;
   pending+=BigInt(frame.output);
  }
  if(!expired&&pending<=args[1])return null;
  return {kind:expired?'expired_deadline':'pending_growth',pending,maximum:args[1],profile};
 }catch{return null;}
}

export const pendingGrowthEvidence=(trace,args,timestamp)=>guardedBatchEvidence(trace,args,timestamp);
export const expiredBatchEvidence=(trace,args,timestamp)=>guardedBatchEvidence(trace,args,timestamp,true);
export async function verifyPendingGrowth(client,trace,args,block){
 return verifyEvidence(client,pendingGrowthEvidence(trace,args,block.timestamp),block);
}
export async function verifyExpiredBatch(client,trace,args,block){
 return verifyEvidence(client,expiredBatchEvidence(trace,args,block.timestamp),block);
}
async function verifyEvidence(client,evidence,block){
 if(!evidence)return false;
 const p=evidence.profile;
 const runtimes=p.direct?[[p.base,p.baseHash]]:[[p.wrapper,p.wrapperHash],[p.base,p.baseHash]];
 const codes=await Promise.all(runtimes.map(([address])=>client.getCode({address,blockNumber:block.number})));
 return codes.every((code,i)=>!!code&&same(keccak256(code),runtimes[i][1]));
}
