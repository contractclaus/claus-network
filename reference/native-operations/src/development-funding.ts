export async function fundDevelopment(actionId:string,vcpus:number,seconds:number){
 const secret=process.env.PUBLISHER_SECRET;if(!secret)throw Error('development_funding_unavailable');
 const r=await fetch('https://claus-inference.vercel.app/api/resources',{method:'POST',headers:{authorization:'Bearer '+secret,'content-type':'application/json'},body:JSON.stringify({operation:'development_fund',input:{actionId,vcpus,seconds},requestId:'development-fund:'+actionId}),redirect:'error',signal:AbortSignal.timeout(30000)});
 const value=await r.json();if(!r.ok||value.result?.actionId!==actionId||!/^[1-9][0-9]*$/.test(value.result.maximumMicroUsd))throw Error('development_funding_unconfirmed');return value.result;
}
