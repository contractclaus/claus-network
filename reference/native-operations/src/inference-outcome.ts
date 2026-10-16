// A terminal model failure is not proof of payment or nonpayment. The payer
// retains its original row and full reservation until settlement is verified.
export function terminalInferenceFailure(body:any,requestedModel:string){
 const outcome=body?.outcome;
 if(body?.status!=='uncertain'||body.response!=null||
    outcome?.providerResponseReceived!==true||outcome.responseStatus!=='failed'||
    outcome.failure!=='provider_response_invalid'||outcome.providerCode!=='invalid_model_response'||
    typeof requestedModel!=='string'||outcome.returnedModel!==requestedModel)return null;
 return {failure:'provider_model_failed',providerResponseReceived:true,responseStatus:'failed',
  returnedModel:requestedModel,payment:'unresolved',paymentReservation:'retained',
  originalRequestOnly:true,automaticReplacement:false};
}
