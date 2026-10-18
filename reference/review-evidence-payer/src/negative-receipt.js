// Call only after frozen-legacy absence and an atomic admission tombstone.
export function negativeReceipt(id){
 return {id,error:'not_found',nonpayment:{version:1,requestId:id,amount:'0',basis:'durable_absence_fence',admissionFenced:true,legacyFrozen:true}};
}
