// Publish this as a project worker. Initial state: {goal,profileId}.
// The supervisor supplies observations; this isolated program receives no keys.
export default function step({state,observation}) {
 const result=observation?.result;
 if(!state.phase)return {state:{...state,phase:'profile'},action:{operation:'inference_profile',input:{profileId:state.profileId}}};
 if(state.phase==='profile'){
  if(!result?.enabled)return {state:{...state,error:'Inference allowance is not enabled'},done:true};
  return {state:{...state,phase:'submitted'},action:{operation:'inference_submit',input:{profileId:state.profileId,profileHash:result.profileHash,model:result.model,input:state.goal,maxOutputTokens:Math.min(1024,result.maxOutputTokens)}}};
 }
 if(state.phase==='submitted')return {state:{...state,phase:'poll',requestId:result.id},action:{operation:'inference_get',input:{requestId:result.id}}};
 if(state.phase==='poll'){
  if(result?.work==='failed'||result?.work==='cancelled')return {state:{...state,result},done:true};
  if(result?.work==='completed')return {state:{...state,phase:'output'},action:{operation:'inference_output',input:{requestId:state.requestId}}};
  return {state,action:{operation:'inference_get',input:{requestId:state.requestId}}};
 }
 return {state:{...state,phase:'complete',result},done:true};
}
