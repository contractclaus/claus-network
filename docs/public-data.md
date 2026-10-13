# Public data services

The existing `no-delegation` service policy is unchanged. The additional `public-data-v1` policy is for public inputs and public reuse of delivered outputs, including onchain publication. It still forbids providers from subdelegating the buyer's order.

Check `capabilities.publicDataServices.enabled` first. A manifest uses `dataPolicy: "public-data-v1"`; all other [provider lifecycle](services.md) rules, immutable version hashes, conformance probes, claim leases and delivery schemas remain the same. A probe reports transport compatibility, not data truth or approval of a provider.

## Publish one result

1. The buyer calls `service_quote`, inspects the terms and accepts the exact quote with `service_accept`. The first reference uses free pull services only.
2. The provider claims and delivers under its own project credential. The buyer reads `service_result` and accepts its exact hash with `service_accept_result`.
3. Both provider and buyer explicitly publish their project profiles. The service must also be publicly published and unexpired.
4. The buyer reads `service_result_publication`, then calls `service_result_publish` with `orderId`, `outputHash`, `published:true`, `expectedRevision` and `expiresAt` in Unix **milliseconds**. This needs `project.publish`, separately from permission to call a service. A service policy by itself never publishes private outputs.
5. `public_service_result` reads the output and provenance without a credential. It includes service/manifest/output hashes, provider/buyer project IDs, publication revision and expiry. It excludes access tokens, claim leases, private input and payment details.

To compose services, send the returned `{id,revision,outputHash}` in the next `service_quote.sourceResults` array and include the actual public observation in that service's schema-defined input. The quote binds both. Up to three input references and three lineage levels are supported. The original project credential is never passed to the next provider.

Withdrawal uses `service_result_publish` with `published:false` and the current revision. Changing or withdrawing a parent prevents new downstream reuse. Republishing it under a new revision does not revive older derivatives. Existing onchain copies remain public and immutable.

`reference/pulse-providers.mjs` supplies the three Network Pulse service definitions: Observer reads finalised chain data, Evaluator applies a pinned threshold, Consumer independently checks the result and publishes under its own signed grant. The serial coordinator preserves original quote, order, result and transaction IDs through interruption. These are Claus-operated reference projects, not independent customer adoption.

Current daily limits and availability come from `project_capabilities`; a published manifest cannot increase them. Operators can stop new work without deleting results or unresolved transaction reservations. Follow [signal feeds](signals.md) for the onchain step.

## Provider quickstart

Create a separate provider project through the [quickstart](quickstart.md), and give its agent only `project.read`, `project.publish`, `service.manage`, `service.read` and `service.provide`. Store its credential in a mode-0600 JSON file with a `token` property. The owner wallet does not belong in the provider process.

The following Node session starts a free Observer on Ethereum. Set `CLAUS_PROVIDER_PROJECT_ID`, `CLAUS_PROVIDER_CREDENTIAL_FILE`, `CLAUS_PROVIDER_STATE_FILE`, `CLAUS_PROVIDER_RECIPIENT`, `CLAUS_PRIMARY_RPC` and `CLAUS_SECONDARY_RPC` first. Both RPCs must be HTTPS endpoints from different operators. The recipient is an address, not a key; this free service receives no payment. The state file must live in your private directory and be retained across restarts.

```js
var {readFile,writeFile,stat}=await import('node:fs/promises');
var assert=(await import('node:assert/strict')).default;
var {createClient}=await import('./interfaces/sdk.mjs');
var {createPublicClient,http}=await import('viem');
var {pulseDefinitions,createPulseProvider,createPulseProviderWorker}=await import('./reference/pulse-providers.mjs');
var credentialFile=process.env.CLAUS_PROVIDER_CREDENTIAL_FILE;
assert.equal((await stat(credentialFile)).mode & 0o077,0);
var api=createClient({token:JSON.parse(await readFile(credentialFile,'utf8')).token});
var projectId=process.env.CLAUS_PROVIDER_PROJECT_ID;
assert.equal((await api.call('capabilities')).publicDataServices.enabled,true);
var stateFile=process.env.CLAUS_PROVIDER_STATE_FILE;
await stat(stateFile).then(s=>assert.equal(s.mode & 0o077,0)).catch(e=>{if(e.code!=='ENOENT')throw e;});
var state=await readFile(stateFile,'utf8').then(JSON.parse).catch(e=>{
  if(e.code!=='ENOENT')throw e;
  return {projectId,manifest:{...pulseDefinitions.observer,priceWei:'0',
    recipient:process.env.CLAUS_PROVIDER_RECIPIENT,maxDurationSeconds:1800,
    validUntil:Date.now()+7*86400000,dataPolicy:'public-data-v1'}};
});
assert.equal(state.projectId,projectId);
var save=()=>writeFile(stateFile,JSON.stringify(state,null,2)+'\n',{mode:0o600});
await save();
// The exact immutable manifest is the registration identity. Keep it on restart.
state.service=await api.call('service_register',{projectId,manifest:state.manifest});await save();
var urls=[process.env.CLAUS_PRIMARY_RPC,process.env.CLAUS_SECONDARY_RPC].map(s=>new URL(s));
urls.forEach(u=>assert.equal(u.protocol,'https:'));
assert.notEqual(urls[0].hostname,urls[1].hostname);
var clients=urls.map(u=>createPublicClient({transport:http(u.href,{retryCount:0,timeout:15000}),cacheTime:0}));
var provider=createPulseProvider({role:'observer',chainId:1,primary:clients[0],secondary:clients[1]});
var worker=createPulseProviderWorker({client:api,projectId,serviceId:state.service.id,provider});
await worker.tick(); // Handles the labelled, unpaid transport probe first.
var service=await api.call('service_get',{projectId,serviceId:state.service.id});
console.log(service.state);
```

A hosted probe may take a later tick to become `available`. Keep the process running and read the same service. After it is available, publish the provider's profile separately using `project_publish`, then publish this exact version with its current publication revision:

```js
var service=await api.call('service_get',{projectId,serviceId:state.service.id});
assert.equal(service.state,'available');
if(!service.publication.published)await api.call('service_publish',{
  projectId,serviceId:service.id,published:true,expectedRevision:service.publication.revision});
// One serial bounded tick; schedule this every minute in your own worker.
console.log(await worker.tick());
```

Repeat the last tick through your existing process supervisor or scheduler. It handles at most eight claimed orders, including four successful deliveries, per tick; an invalid observation does not prevent later valid orders from being processed. Transport failure leaves the original claim/order to reconcile under its lease and deadline. Watch both service availability and worker errors. Withdraw the service using `service_publish` with `published:false` before retiring the worker, and revoke its mandate separately. Existing accepted orders retain their terms.

For an Evaluator, create another project and credential and select `pulseDefinitions.evaluator` with `role:'evaluator'`. It independently checks the supplied observation against its configured secondary RPC. Neither data provider needs a publisher key. Onchain publication uses the consumer's separate [finite grant](signals.md).
