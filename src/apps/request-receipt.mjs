import {copy,digest,requireThat} from '../shared/index.mjs';

// Original results belong to the authenticated principal, including after
// project access is withdrawn. This reads only an existing immutable receipt.
// It neither reauthorizes the old operation nor reveals current project data.
export async function readAppRequestReceipt({storage,identity},actor,projectId,{operation,idempotencyKey,requestHash}) {
 requireThat(typeof operation==='string'&&/^(?:configure|publish|withdraw|(?:record|service|service\.configure):[a-z][a-z0-9_-]{0,47})$/.test(operation),'invalid_receipt_operation');
 requireThat(typeof idempotencyKey==='string'&&idempotencyKey.length>0&&idempotencyKey.length<=128,'invalid_receipt_key');
 requireThat(/^sha256:[a-f0-9]{64}$/.test(requestHash??''),'invalid_receipt_hash');
 const who=await identity.credential(actor);
 requireThat(who.kind!=='app','scope_denied');
 const key=digest({p:who.principalId,op:operation,key:idempotencyKey});
 const row=await storage.reader(projectId).read('requests',key);
 const result={profile:'claus-app-request-receipt/1',projectId,operation,idempotencyKey,requestHash};
 if(!row)return {...result,state:'not_observed',retryAuthorized:false};
 requireThat(row.value.hash===requestHash,'idempotency_conflict');
 return {...result,state:'completed',result:copy(row.value.result)};
}
