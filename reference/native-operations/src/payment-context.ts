import {textPrefix} from './text.js';

const actionId=(value:unknown):value is string=>typeof value==='string'&&/^ww_[a-f0-9]{64}$/.test(value);
const hash=(value:unknown):value is string=>typeof value==='string'&&/^0x[a-fA-F0-9]{64}$/.test(value);
const object=(value:any)=>value!==null&&typeof value==='object'&&!Array.isArray(value);

// Only the broad wallet overview is shortened. A targeted action read and the
// original journal retain complete receipts, including events and their values.
export function walletOverview(value:any):any {
  if(!object(value)||value.contextProjection||value.chainId!==1||value.policy?.chainId!==1||
    typeof value.address!=='string'||value.address!==value.policy.address||
    typeof value.balanceWei!=='string'||!object(value.account)||!Array.isArray(value.actions))return value;
  return {...value,contextProjection:'work-wallet-overview',actions:value.actions.map((action:any)=>{
    if(!object(action?.receipt))return action;
    const receipt:any={};
    for(const key of ['status','transactionHash','blockNumber','blockHash','from','to','gasUsed','effectiveGasPrice'])
      if(Object.hasOwn(action.receipt,key))receipt[key]=action.receipt[key];
    return {...action,receipt:{...receipt,logsDeferred:Array.isArray(action.receipt.logs)?action.receipt.logs.length:null}};
  }),receiptDetails:'Use work_wallet status with the original action id for its full receipt and current reconciliation. Full historical events also remain in the original journal. This overview is not a complete payment history.'};
}

export function paymentRequest(input:any):Record<string,string> {
  let value:any;try{value=typeof input==='string'?JSON.parse(input):input;}catch{return {};}
  if(!object(value))return {};
  const fields:Record<string,string>={};
  for(const key of ['id','projectId','taskId','senderProjectId','action','operationId','asset','amountWei','purpose'])
    if(typeof value[key]==='string'&&value[key].length<=512)fields[key]=value[key];
  return fields;
}

// Evidence index only: no inferred settlement, automatic next action or replay.
// Keep an unresolved original id even if a later transport read fails.
export function paymentProgress(args:any,result:any,archiveId:string|null,previous:any[]=[]) {
  if(args.describe===true||!object(result))return null;
  const request=paymentRequest(args.input);
  const id=actionId(result.id)?result.id:
    ['status','resume'].includes(args.operation)&&actionId(request.id)?request.id:null;
  if(!id)return null;
  const prior=previous.find(row=>row?.id===id);
  // Compaction can replay older exchanges beside a newer retained receipt.
  const oldJournal=/^j_(\d+)$/.exec(prior?.archiveId??''),newJournal=/^j_(\d+)$/.exec(archiveId??'');
  if(oldJournal&&newJournal&&BigInt(newJournal[1])<=BigInt(oldJournal[1]))return null;
  const details=paymentRequest(result.input?.input);
  const originalOperation=result.input?.operation??prior?.operation??
    (!['status','resume'].includes(args.operation)?args.operation:undefined);
  const record:any={...prior,id,request:{...prior?.request,...request,...details},archiveId};
  delete record.request.id;
  if(typeof originalOperation==='string')record.operation=originalOperation;
  if(typeof result.status==='string')record.status=textPrefix(result.status,80);
  else if(result.outcome==='unknown'||result.error)record.status='unknown';
  for(const key of ['error','outcome','next']){
    delete record[key];
    if(result[key]===null||typeof result[key]==='string')record[key]=typeof result[key]==='string'?textPrefix(result[key],800):null;
  }
  if(hash(result.transactionHash))record.transactionHash=result.transactionHash;
  if(Object.hasOwn(result,'receipt'))record.receipt=result.receipt?{
    status:result.receipt.status,transactionHash:result.receipt.transactionHash,
    blockNumber:result.receipt.blockNumber,blockHash:result.receipt.blockHash
  }:null;
  return record;
}
