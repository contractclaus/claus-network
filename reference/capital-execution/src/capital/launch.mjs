import fs from 'node:fs';
import {decodeFunctionData,decodeAbiParameters,keccak256,parseTransaction} from 'viem';
import {OWNER,LIMITS,check,same,digest} from './policy.mjs';
export const ROUTER='0xbe4bf6ac8c6f012e1c8f25747a9fbccb2fdac4c3';
export const FACTORY='0xb012e4a8f2c5fc4e8e4faca9d5ad6fff13fba887';
export const PINS={[ROUTER]:'0xf2d611fb92718c63cf5767300e79d7c9b49480b2e9001448b96c1385f4edb6f3',[FACTORY]:'0xd23692fae59331592048e71a96d4963e170ee56e449683dc9f7fa3f9470018b8'};
export const routerAbi=JSON.parse(fs.readFileSync(new URL('./router-abi.json',import.meta.url),'utf8'));
const field=(name,type)=>({name,type});
export const routeType={type:'tuple',components:[field('routeNamespace','bytes32'),field('routeNonce','bytes32'),field('topologyHash','bytes32'),field('graphCommitment','bytes32'),{name:'targets',type:'tuple[]',components:[field('targetIdHash','bytes32'),field('applicantSalt','bytes32'),field('deploymentValue','uint256'),field('initializerValue','uint256'),field('initCode','bytes'),field('initializerCalldata','bytes')]},{name:'expectedOutputs',type:'tuple[]',components:[field('targetIndex','uint8'),field('targetIdHash','bytes32'),field('account','address'),field('runtimeCodeHash','bytes32')]},field('expectedGraphDeploymentHash','bytes32')]};
export const launchId=value=>'capital-launch:'+value.execution.onchainLaunchId.slice(2);
export function exactLaunch(value,proof,resource,nowSeconds){
 const e=value.execution,o=resource.output;
 check(value.action==='launch'&&resource.launchId===e.providerLaunchId&&resource.requestHash===e.requestHash&&resource.onchainLaunchId===e.onchainLaunchId&&same(resource.ownerWallet,OWNER),'provider_binding');
 check(resource.status==='authorized'&&o?.stage==='router-transaction-required'&&o?.integrationState==='ready','launch_not_authorized');
 check(o.actionRequired?.artifactHash===e.artifactHash,'provider_artifact');
 const tx=o.actionRequired?.transaction;
 check(tx&&String(tx.chainId)==='1'&&same(tx.from,OWNER)&&same(tx.to,ROUTER)&&tx.valueWei===e.valueWei&&same(tx.calldata,e.calldata)&&keccak256(e.calldata)===e.calldataHash,'provider_transaction');
 const decoded=decodeFunctionData({abi:routerAbi,data:e.calldata});
 check(decoded.functionName==='launchAndStampV1','launch_function');
 const [permit,stamp,payload]=decoded.args;
 check(permit.chainId===1n&&same(permit.router,ROUTER)&&same(permit.launchWallet,OWNER)&&Number(permit.kind)===1&&permit.value===BigInt(e.valueWei)&&Number(permit.validAfter)<=nowSeconds&&Number(permit.deadline)>nowSeconds+15&&value.terms.expiresAt>nowSeconds+15,'launch_permit');
 check(keccak256(payload)===permit.routePayloadHash&&stamp.launchId===e.onchainLaunchId,'launch_payload');
 const [route]=decodeAbiParameters([routeType],payload);
 check(route.targets.length===e.components.length&&route.expectedOutputs.length===e.components.length,'launch_graph');
 for(const component of e.components){
  const target=route.targets[component.targetIndex],expected=route.expectedOutputs.find(x=>Number(x.targetIndex)===component.targetIndex),artifact=proof.artifacts[component.buildId];
  check(target&&expected&&same(expected.account,component.address)&&same(expected.runtimeCodeHash,component.runtimeHash)&&expected.targetIdHash===target.targetIdHash,'launch_output');
  check(artifact?.status==='compiled'&&same(target.initCode,artifact.creationBytecode+component.constructorArgs.slice(2))&&keccak256(target.initCode)===component.initCodeHash,'launch_creation_code');
 }
 check(new Set(route.expectedOutputs.map(x=>Number(x.targetIndex))).size===route.targets.length,'duplicate_graph_output');
 for(const c of stamp.components)check(e.components.some(x=>same(x.address,c.account)&&same(x.runtimeHash,c.runtimeCodeHash)),'unreviewed_stamp_component');
 check(e.components.some(x=>same(x.address,stamp.token)&&same(x.runtimeHash,stamp.tokenRuntimeCodeHash))&&e.components.some(x=>same(x.address,stamp.poolKey.hooks)&&same(x.runtimeHash,stamp.hookRuntimeCodeHash)),'unreviewed_token_hook');
 check(same(stamp.poolKey.currency0,'0x0000000000000000000000000000000000000000')&&same(stamp.poolKey.currency1,stamp.token),'native_pair_required');
 return {chainId:1,to:ROUTER,data:e.calldata,value:e.valueWei};
}
export async function launchPins(client){check(await client.getChainId()===1,'chain');for(const [address,hash] of Object.entries(PINS))check(keccak256(await client.getCode({address})??'0x')===hash,'provider_runtime_changed');}
export function launchCost(tx,expected,committed,balance){
 check(tx.chainId===1&&same(tx.to,ROUTER)&&same(tx.data,expected.data)&&BigInt(tx.value)===BigInt(expected.value)&&tx.gas>0n&&tx.maxFeePerGas>0n&&!tx.authorizationList?.length&&!tx.accessList?.length,'signature_transaction');
 const cost=tx.value+tx.gas*tx.maxFeePerGas;
 check(cost<=BigInt(LIMITS.perLaunch)&&committed+cost<=BigInt(LIMITS.launch),'launch_budget');
 check(balance-cost>=BigInt(LIMITS.ownerReserve),'owner_reserve');return cost;
}
export async function launchRegistered(client,value,receipt){
 check(receipt.status==='success','launch_reverted');
 const canonical=await client.getBlock({blockNumber:BigInt(receipt.blockNumber)});check(canonical.hash===receipt.blockHash,'launch_reorg');
 const e=value.execution,record=await client.readContract({address:ROUTER,abi:routerAbi,functionName:'launchStamp',args:[e.onchainLaunchId],blockNumber:BigInt(receipt.blockNumber)});
 check(same(record.launchWallet,OWNER)&&Number(record.kind)===1,'launch_stamp');
 for(const c of e.components){
  const code=await client.getCode({address:c.address,blockNumber:BigInt(receipt.blockNumber)});check(keccak256(code??'0x')===c.runtimeHash,'deployed_runtime');
 }
 const tokenId=await client.readContract({address:ROUTER,abi:routerAbi,functionName:'launchIdByToken',args:[record.token],blockNumber:BigInt(receipt.blockNumber)});check(tokenId===e.onchainLaunchId,'launch_registry');
 return {token:record.token,hook:record.hook,stampHash:record.stampHash,poolId:record.poolId,transactionHash:receipt.transactionHash,blockNumber:receipt.blockNumber};
}
export function launchCommitted(rows){return rows.reduce((n,r)=>{if(!r.signed)return n;const t=parseTransaction(r.signed.raw);return n+(t.value??0n)+t.gas*t.maxFeePerGas;},0n);}
