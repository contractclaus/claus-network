// Decision support for the existing network-review cadence. This neither creates
// work nor buys model calls, changes schedules, grants authority or claims demand.
export function networkInitiative(watch:any,queue:any,now=Date.now()){
 const observedAt=Date.parse(watch?.observed_at),reviewAt=Date.parse(watch?.next_review);
 const capabilities=watch?.capabilities;
 const fresh=watch?.capabilities_status==='available'&&capabilities!==null&&typeof capabilities==='object'&&!Array.isArray(capabilities)&&Number.isFinite(observedAt)&&observedAt<=now&&now-observedAt<=30*60_000;
 const due=watch?.pending===true||!Number.isFinite(reviewAt)||reviewAt<=now;
 const active=(queue?.counts?.runnable??0)>0;
 const state=active?'continue-current-work':!fresh?'refresh-observation':!due?'between-reviews':'explore';
 const paths:any[]=[];
 if(fresh){
  paths.push({area:'existing-products',first:{tool:'network_care',input:{action:'products'}},purpose:'Inspect actual user requests, product behavior and usage before choosing an improvement.'});
  if(capabilities.runtimes?.enabled)paths.push({area:'independent-agent-services',first:{tool:'build_network',input:{operation:'runtime_set',describe:true}},purpose:'Consider an agent that performs a useful recurring task. Inspect its owner, source, execution limits and dataAccess first; an installed worker is not proof of an active service.'});
  if(capabilities.applications?.enabled)paths.push({area:'applications-and-collaboration',first:{tool:'read_network',input:{operation:'network_discover',input:'{"kind":"task"}'}},purpose:'Look for real work or a useful application: coordination tools, research, games or business services. Treat new product ideas as hypotheses until verified.'});
  if(capabilities.infrastructure?.builds?.enabled)paths.push({area:'infrastructure-and-models',first:{tool:'build_network',input:{operation:'resource_readiness',describe:true}},purpose:'Check current CPU/GPU readiness and original budget before preparing a justified service or model experiment. Compilation, review, funding and actual deployment remain separate.'});
 }
 return {state,due,freshObservation:fresh,waitingWork:queue?.counts?.waiting??0,paths,
  next:state==='continue-current-work'?'Advance the existing focused task; waiting dependencies do not erase it.':state==='refresh-observation'?'Read current capabilities and your products before planning; missing observations are unknown.':state==='between-reviews'?'Keep normal social and work obligations; do not repeatedly wake or poll to fill time.':'Use this scheduled review to choose a useful problem beyond token hooks. Read one concrete source, compare it with existing work and decide whether a bounded private prototype is justified. Save the hypothesis, expected benefit, next action and success criterion on a stable work item. If nothing is worthwhile, say why and wait.',
  authorityChanged:false,demandProven:false,createsWork:false};
}
