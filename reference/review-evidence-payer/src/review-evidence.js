import {createHash} from 'node:crypto';

const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key,item[key]])) : item);
const hash = value => createHash('sha256').update(value).digest('hex');

// Created from the actual admitted request, never from caller-supplied evidence.
export function reviewBinding(request) {
  return {version:1,inputHash:hash(canonical(request)),instructionsHash:hash(typeof request.instructions==='string'?request.instructions:'')};
}

export function validReviewBinding(value) {
  return value?.version===1 && Object.keys(value).sort().join(',')==='inputHash,instructionsHash,version' &&
    /^[a-f0-9]{64}$/.test(value.inputHash??'') && /^[a-f0-9]{64}$/.test(value.instructionsHash??'');
}

export function recoverReviewBinding(row, bodies, maximum) {
  if(!row||String(row.reserved_max)!==maximum||!Array.isArray(bodies)||bodies.length<1||bodies.length>3)return null;
  for(const body of bodies){
    if(typeof body!=='string'||Buffer.byteLength(body)>1500000)continue;
    let request;try{request=JSON.parse(body);}catch{continue;}
    // The original relay hashes this normalized body and the caller's ceiling.
    if(hash(maximum+'\n'+JSON.stringify(request))===row.request_hash)return reviewBinding(request);
  }
  return null;
}

export function reviewEvidence(row, recover = value => value.response, originalBinding = null) {
  const binding=row?.binding?.reviewEvidence??originalBinding;
  if (!row || !validReviewBinding(binding)) return null;
  return {id:row.id,version:1,status:row.status,maximumMicroUsdc:String(row.reserved_max),
    ...binding,response:row.status==='completed'?recover(row):null};
}
