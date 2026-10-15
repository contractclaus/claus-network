import {delivery,pendingReceipts,receiptInput} from './receipts.js';
import {createProgramVerifier} from './verification.js';
import {createPublicClient,http,encodeDeployData,keccak256,parseTransaction,zeroAddress} from 'viem';
import {mainnet} from 'viem/chains';
import {privateKeyToAccount} from 'viem/accounts';
import {neon} from '@neondatabase/serverless';
import fs from 'node:fs';
import {walletService} from '../wallet.js';
import {walletRepository} from '../wallet-store.js';
import {createNetworkAccess} from '../jobs-wallet/network.js';
import {readProgramEvidence,digest,validRef} from './evidence.js';
import {CORE,PROGRAM_ABI,readCore,same,selectTransaction,assertProgramSignature} from './policy.js';
import {programReadRoutes} from './read-routes.js';
const prefix='native-program:';
const programId=ref=>prefix+digest(validRef(ref)).slice(7);
const validId=id=>{if(typeof id!=='string'||!/^native-program:[a-f0-9]{64}$/.test(id))throw Error('program_invalid_id');return id;};
function gasLedger(){const sql=neon(process.env.DATABASE_URL);return {async spent(){
 const rows=await sql`SELECT signed,result FROM claus_wallet_actions WHERE id LIKE 'native-program:%' AND signed IS NOT NULL`;
 return rows.reduce((n,row)=>{const t=parseTransaction(row.signed.raw);return n+t.gas*t.maxFeePerGas;},0n);
}};}
export function createProgramService({network,repo,client,account,guard,limits,enabled,ledger,verifier,observeCore=readCore,now=()=>new Date().toISOString()}){
 async function bundle(id){const b=await repo.release(validId(id));if(!b||b.kind!=='native-program')throw Error('program_not_found');return b;}
 async function included(id){const row=await repo.get(id);if(!row)return null;const state=await observer.status(id);return state.status==='included'&&!state.observationError?state:null;}
 // Read-only reconciliation uses this instance. Only executeStep obtains the
 // guarded signTransaction closure; it never returns signatures or raw bytes.
 const observer=walletService({account:{address:account.address,signTransaction:async()=>{throw Error('program_signing_not_available');}},clients:{1:client},repository:repo,policy:async()=>({enabled:false})});
 async function fixedState(b){
  const current=await observeCore(client);
  if(!same(current.activeModule,b.previousModule))throw Error('program_selection_changed');
  return current;
 }
 async function stage(b,step){
  if(step==='deploy')return {chainId:1,value:'0',releaseId:b.id,artifact:'out/Program.json',constructorArgs:[]};
  const deployed=await included(b.id+':deploy');if(!deployed?.result?.receipt?.contractAddress)throw Error('program_deployment_not_verified');
  const program=deployed.result.receipt.contractAddress;
  const code=await client.getCode({address:program});
  const original=await repo.get(b.id+':deploy');
  if(!code||!same(code,original.signed.expectedRuntime))throw Error('program_runtime_changed');
  if(step==='adapter')return {chainId:1,value:'0',releaseId:b.id,artifact:'out/TreasuryProtectedProgram.json',constructorArgs:[program,keccak256(code)]};
  const wrapped=await included(b.id+':adapter');if(!wrapped?.result?.receipt?.contractAddress)throw Error('program_adapter_not_verified');
  const adapter=wrapped.result.receipt.contractAddress,adapterRow=await repo.get(b.id+':adapter');
  const [adapterCode,target,targetHash,treasuryPips]=await Promise.all([
   client.getCode({address:adapter}),client.readContract({address:adapter,abi:PROGRAM_ABI,functionName:'program'}),
   client.readContract({address:adapter,abi:PROGRAM_ABI,functionName:'programCodeHash'}),client.readContract({address:adapter,abi:PROGRAM_ABI,functionName:'TREASURY_PIPS'})
  ]);
  if(!same(adapterCode,adapterRow.signed.expectedRuntime)||!same(target,program)||targetHash!==keccak256(code)||treasuryPips!==13000n)throw Error('program_adapter_changed');
  if(step==='select')return selectTransaction(adapter);
  throw Error('program_invalid_stage');
 }
 async function executeStep(b,step,expected,receiptRequest){
  if(!enabled())throw Error('program_installation_disabled');
  if(b.guardHash!==digest(guard))throw Error('program_guard_changed');
  // Revocation also stops re-broadcast of an already signed original payload.
  // Its hash and nonce stay reserved for observation; no replacement is made.
  if(step!=='disable'){
   const proof=await readProgramEvidence(network,b.reference);
   if(proof.artifactHash!==b.proof.artifactHash||proof.reportArtifactHash!==b.proof.reportArtifactHash||proof.judgeHash!==b.proof.judgeHash)throw Error('program_review_changed');
  }
  const id=b.id+':'+step;
  const service=walletService({account:{...account,signTransaction:async tx=>{
   if(!enabled())throw Error('program_installation_disabled');
   const active=await repo.active(1);if(active!==id)throw Error('program_nonce_lock_required');
   const recorded=await repo.get(id);if(!recorded||recorded.status!=='signing'||recorded.signed)throw Error('program_action_changed');
   // Re-read the paid review and immutable artifact immediately before signing.
   if(step!=='disable'){const proof=await readProgramEvidence(network,b.reference);
    if(proof.artifactHash!==b.proof.artifactHash||proof.reportArtifactHash!==b.proof.reportArtifactHash||proof.judgeHash!==b.proof.judgeHash)throw Error('program_review_changed');}
   // Deactivation must survive a withdrawn review or a broken inner program.
   const live=await observeCore(client);
   const expectedModule=step==='disable'?b.selectedModule:b.previousModule;
   if(!receiptRequest&&!same(live.activeModule,expectedModule))throw Error('program_selection_changed');
   let exact;
   if(receiptRequest){const r=await delivery(client,receiptRequest.adapter,receiptRequest.input);if(r.consumed)throw Error('program_receipt_already_consumed');exact=r.transaction;}
   else exact=step==='disable'?selectTransaction(zeroAddress):await stage(b,step);
   const data=exact.to?exact.data:encodeDeployData({abi:b.artifacts.find(a=>a.path===exact.artifact).abi,bytecode:b.artifacts.find(a=>a.path===exact.artifact).bytecode,args:exact.constructorArgs});
   if(expected.data!==undefined&&!same(data,expected.data))throw Error('program_preparation_changed');
   assertProgramSignature(tx,{...exact,data},limits,await ledger.spent(),await client.getBalance({address:CORE.owner}));
   return account.signTransaction(tx);
  }},clients:{1:client},repository:repo,policy:async()=>({enabled:enabled(),mode:'production',chainWrite:true,externalTransfer:true,blockingRules:[],revision:'native-program-fixed-purpose-v1'})});
  // All retries use the same original stage id. A rejected unsigned attempt is
  // not silently recreated; signed/unknown actions only reconcile exact bytes.
  if(!await repo.get(id))await service.prepare(id,expected);
  return service.execute(id);
 }
 return {
  async prepare(input){
   if(!input||Object.keys(input).some(k=>!['projectId','caseId','reportHash','reason','acknowledgedFindings'].includes(k)))throw Error('program_invalid_decision');
   const reference=validRef({projectId:input.projectId,caseId:input.caseId}),id=programId(reference),proof=await readProgramEvidence(network,reference);
   if(proof.reportHash!==input.reportHash||typeof input.reason!=='string'||input.reason.trim().length<40||input.reason.length>4000||!Array.isArray(input.acknowledgedFindings)||
    digest([...input.acknowledgedFindings].sort())!==digest(proof.findings.map(digest).sort()))throw Error('program_decision_incomplete');
   const old=await repo.release(id);
   if(old){if(old.proof.artifactHash!==proof.artifactHash||old.proof.reportHash!==proof.reportHash)throw Error('program_original_conflict');return this.status(id);}
   const core=await observeCore(client);
   const value={kind:'native-program',id,reference,proof:{...proof,artifact:undefined},reason:input.reason,acknowledgedFindings:input.acknowledgedFindings,
    compiled:{program:proof.artifact,guard},guardHash:digest(guard),previousModule:core.activeModule,observedCore:core,createdAt:now(),passed:true,
    artifacts:[{path:'out/Program.json',abi:proof.artifact.abi,bytecode:proof.artifact.creationBytecode},
     {path:'out/TreasuryProtectedProgram.json',abi:guard.abi,bytecode:guard.creationBytecode}]};
   delete value.proof.artifact;
   await repo.attest(id,value);return this.status(id);
  },
  async evidence(reference){const {artifact,...proof}=await readProgramEvidence(network,reference);return {...proof,findingHashes:proof.findings.map(digest),installationAuthorized:false};},
  async status(id){
   const b=await bundle(id),steps={};for(const step of ['deploy','adapter','select','disable']){if(await repo.get(id+':'+step))steps[step]=await observer.status(id+':'+step);}
   return {id,reference:b.reference,artifactHash:b.proof.artifactHash,reportHash:b.proof.reportHash,previousModule:b.previousModule,steps,current:await observeCore(client),installationEnabled:enabled(),limits};
  },
  async advance(id){
   const b=await bundle(id);if(!enabled())throw Error('program_installation_disabled');
   for(const step of ['deploy','adapter','select']){
    const prior=await repo.get(id+':'+step);
    if(prior){const read=await observer.status(id+':'+step);if(read.observationError)return {id,step,result:read,next:'Reconcile this original action when its receipt is available.'};if(read.status==='included'){
     if(step!=='select'){
      if(typeof verifier!=='function')throw Error('program_verifier_unavailable');
      const tx=await stage(b,step),proof=await verifier({address:read.result.receipt.contractAddress,artifact:step==='deploy'?b.compiled.program:b.compiled.guard,args:tx.constructorArgs});
      if(!proof.verified)return {id,step,verification:proof,next:'Continue the same program after source verification.'};
     }
     continue;
    }if(['reverted','postcondition_failed','rejected'].includes(read.status))return {id,step,result:read,next:'Review this original outcome. No replacement was created.'};}
    await fixedState(b);const exact=await stage(b,step);return {id,step,result:await executeStep(b,step,exact)};
   }
   return this.status(id);
  },
  async receipts(id,fromBlock){
   const b=await bundle(id),wrapped=await included(id+':adapter');if(!wrapped?.result?.receipt?.contractAddress)throw Error('program_adapter_not_verified');
   return pendingReceipts(client,wrapped.result.receipt.contractAddress,fromBlock??wrapped.result.receipt.blockNumber);
  },
  async deliver(id,input){
   const b=await bundle(id);receiptInput(input);await stage(b,'select');
   const wrapped=await included(id+':adapter'),adapter=wrapped.result.receipt.contractAddress;
   const r=await delivery(client,adapter,input),step='receipt-'+r.receiptId;
   if(r.consumed)return {id,step,consumed:true,meaning:'The original host receipt is consumed. Read its original delivery transaction for the executor.'};
   const old=await repo.release(id+':'+step+':input');if(old&&digest(old)!==digest(input))throw Error('program_receipt_request_conflict');
   await repo.attest(id+':'+step+':input',input);
   return {id,step,result:await executeStep(b,step,r.transaction,{adapter,input})};
  },
  async disable(id){
   const b=await bundle(id);if(!enabled())throw Error('program_installation_disabled');
   const selected=await included(id+':select');if(!selected)throw Error('program_not_selected');
   const wrapped=await included(id+':adapter');if(!wrapped?.result?.receipt?.contractAddress)throw Error('program_adapter_not_verified');
   const decodedModule=wrapped.result.receipt.contractAddress;
   return {id,step:'disable',result:await executeStep({...b,selectedModule:decodedModule},'disable',selectTransaction(zeroAddress))};
  }
 };
}
export function productionPrograms(){
 const guard=JSON.parse(fs.readFileSync(new URL('../../config/native-program-guard.json',import.meta.url)));
 const limits=JSON.parse(fs.readFileSync(new URL('../../config/native-program-limits.json',import.meta.url)));
 const account=privateKeyToAccount(process.env.SIGNER_PRIVATE_KEY);
 if(!same(account.address,CORE.owner))throw Error('program_wallet_mismatch');
 return createProgramService({network:createNetworkAccess({extraRoutes:programReadRoutes,maximumResponseBytes:4100000}),repo:walletRepository(),
  client:createPublicClient({chain:mainnet,transport:http(process.env.ETHEREUM_RPC_URL,{retryCount:0,timeout:15000})}),account,guard,limits,
  enabled:()=>process.env.NATIVE_PROGRAM_INSTALL_ENABLED==='true',ledger:gasLedger(),verifier:createProgramVerifier({repositoryStore:walletRepository()})});
}
