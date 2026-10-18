export async function confirmedNoExecution(response:Response,requestId:string,origin:string):Promise<boolean>{
 if(origin!=='https://claus-ecosystem-payments.vercel.app'||response.status!==404)return false;
 try{
  const value=await response.json();
  return value?.error==='not_found'&&value.id===requestId&&value.nonpayment?.version===1&&
   value.nonpayment.requestId===requestId&&value.nonpayment.amount==='0'&&
   value.nonpayment.basis==='durable_absence_fence'&&value.nonpayment.admissionFenced===true&&
   value.nonpayment.legacyFrozen===true;
 }catch{return false;}
}
