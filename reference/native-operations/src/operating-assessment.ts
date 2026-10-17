const units=(v:unknown)=>typeof v==='string'&&/^[0-9]{1,40}$/.test(v)?BigInt(v):null;

// Planning observations never expand a grant or assume future revenue.
export function operatingAssessment(resources:any,history:any[]=[],now=Date.now()){
 const capital=resources?.capital,cash=units(resources?.onchain?.usdcMicro),available=units(capital?.availableMicroUsdc),reserve=units(capital?.cashReserveMicroUsdc),held=units(resources?.budget?.heldMicroUsdc),settled=units(resources?.budget?.settledMicroUsdc);
 if(!Number.isSafeInteger(now)||resources?.state!=='available'||resources?.complete!==true||capital?.state!=='active'||resources?.onchain?.state!=='available'||[cash,available,reserve,held,settled].some(v=>v===null))return {state:'unknown',observedAt:now,next:'Read the existing payer resources again; unavailable data does not authorize spending.',authorityChanged:false};
 const buffer=cash!-reserve!-held!,cashBuffer=buffer>0n?buffer:0n;
 const effective=available!<cashBuffer?available!:cashBuffer;
 const policyHash=capital.policyHash??null;
 const samples=history.map(row=>row.document??row).filter(v=>Number.isSafeInteger(v?.observedAt)&&v.observedAt<now&&v.observedAt>=now-7*86400000&&units(v.settledMicroUsdc)!==null&&(v.policyHash??null)===policyHash).sort((a,b)=>a.observedAt-b.observedAt);
 const baseline=[...samples].reverse().find(v=>v.observedAt<=now-6*3600000);
 const previous=units(baseline?.settledMicroUsdc),elapsed=baseline?now-baseline.observedAt:0;
 const window=baseline?[...samples.filter(v=>v.observedAt>=baseline.observedAt).map(v=>units(v.settledMicroUsdc)!),settled!]:[];
 const monotonic=window.every((value,i)=>i===0||value>=window[i-1]);
 const ready=!!baseline&&monotonic;
 const spent=ready?settled!-previous!:null;
 // Round positive sub-micro daily costs up, so a nonzero expense is not shown as zero.
 const dailyCost=spent!==null?(spent*86400000n+BigInt(elapsed)-1n)/BigInt(elapsed):null;
 const state=effective===0n?'exhausted':effective<6000000n?'low':'available';
 const paymentRail=resources.paymentRail??{state:'unknown',ready:false,reason:'payment_rail_not_observed'};
 return {state,paymentRail,nativePaymentReady:paymentRail.ready===true,operatingMode:state==='exhausted'?'reconciliation_only':state==='low'?'existing_obligations_first':'normal',forecastReady:ready,forecastReason:!baseline?'insufficient_comparable_history':!monotonic?'settled_counter_decreased':spent===0n?'no_settled_cost_in_window':'observed_cost',policyHash,observedAt:now,availableMicroUsdc:String(available),effectiveHeadroomMicroUsdc:String(effective),heldMicroUsdc:String(held),cashReserveMicroUsdc:String(reserve),cashBufferBeforeOtherCommitmentsMicroUsdc:String(cashBuffer),settledMicroUsdc:String(settled),sampleWindowMs:baseline?elapsed:null,observedDailyCostMicroUsdc:dailyCost===null?null:String(dailyCost),cashRunwayDaysBeforeOtherCommitments:dailyCost&&dailyCost>0n?Number(cashBuffer*100n/dailyCost)/100:null,automaticComputeFunding:resources.computeFunding?.enabled===true&&resources.computeFunding?.state==='available',futureRevenueCoverage:'unknown',authorityChanged:false,next:state==='exhausted'?'Reconcile original obligations and inspect existing compute funding. Defer new optional commitments; do not reset limits or replay payments.':state==='low'?'Prioritize active obligations and reuse completed research before opening optional work.':'Continue within the existing rolling budget. Prefer useful work over repeated status-only model calls.',meaning:'Operating cash and authorization are separate. Forecast needs at least six hours of comparable settled-cost history; it excludes future revenue and does not prove profitability or authorize transfers.'};
}
