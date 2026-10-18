import {createHmac,timingSafeEqual} from 'node:crypto';
const stable=v=>JSON.stringify(v&&typeof v==='object'?(Array.isArray(v)?v.map(x=>JSON.parse(stable(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(stable(v[k]))]))):v);
const mac=(proof,secret)=>createHmac('sha256',secret).update('claus-database-retirement-v1\n'+stable(proof)).digest();
export function signRetirementProof(proof,secret){return {proof,signature:mac(proof,secret).toString('hex')};}
export function verifyRetirementProof(value,expected,secret,now=Date.now()){
 const fail=()=>{throw Error('resource_retirement_export_proof_invalid');};
 if(!secret||!value?.proof||!/^[a-f0-9]{64}$/.test(value.signature??''))fail();
 const p=value.proof;
 if(!timingSafeEqual(mac(p,secret),Buffer.from(value.signature,'hex')))fail();
 if(p.version!==1||p.kind!=='claus-database-retirement'||p.resourceId!==expected.resourceId||p.planId!==expected.planId||p.schema!==expected.schema||p.fenceRevision!==expected.fenceRevision||p.sourceId!==expected.sourceId||p.archiveScope!=='full-applications-database'||p.remoteDigestsVerified!==true)fail();
 const frozen=Date.parse(p.frozenAt),snapshot=Date.parse(p.snapshotAt),expires=Date.parse(p.expiresAt);
 if(![frozen,snapshot,expires].every(Number.isFinite)||frozen!==Date.parse(expected.frozenAt)||snapshot<frozen||snapshot>now+60000||expires<now+86400000||expires>snapshot+31*86400000)fail();
 if(!Number.isSafeInteger(p.slot)||p.slot<0||p.bucket!==expected.bucket)fail();
 for(const [name,suffix] of [['dump','applications.dump.cbk'],['checkpoint','applications.checkpoint.cbk']]){
  const f=p[name];if(!f||f.key!=='objects/recurring-v5/snapshots/'+p.slot+'/'+suffix||!Number.isSafeInteger(f.bytes)||f.bytes<=0||f.bytes>513*1024**2||!/^[a-f0-9]{64}$/.test(f.sha256??'')||!/^"[a-f0-9-]{32,80}"$/.test(f.etag??''))fail();
 }
 if(!Number.isSafeInteger(p.tables)||p.tables<1)fail();
 return p;
}
