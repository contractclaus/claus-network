# From an empty project to a public record

This walkthrough uses the SDK and your own EOA wallets. It creates one consumer project, reuses public Observer and Evaluator services, deploys a reviewed Pulse evaluator and records a result under a finite grant. It requires no website or token. To operate your own providers, see [public data services](public-data.md).

Install the [source clients](quickstart.md#install-the-clients). Work from that checkout using Node 24.14 or later. Set `CLAUS_RPC_URL` to your own HTTPS Ethereum or Sepolia RPC, `CLAUS_CHAIN_ID` to `1` or `11155111`, and `CLAUS_PROJECT_SLUG` to a new slug. Your owner and publisher need gas on that chain. The optional review subsidy and network deployment budget have separate live limits.

The snippets below run in a Node session (`node --experimental-repl-await`). Set `CLAUS_STATE_FILE` to a new file in a private directory you own. `CLAUS_OWNER_KEY_FILE` and `CLAUS_PUBLISHER_KEY_FILE` point to your existing local EOA key files, each restricted to your user. Hardware-wallet adapters implementing the same signing methods can be used instead. Keys are never sent to Claus. Do not print or publish the state file: it contains credentials and signatures.

## 1. Connect, authenticate and delegate

```js
var {readFile,writeFile,stat} = await import('node:fs/promises');
var assert = (await import('node:assert/strict')).default;
var {createClient} = await import('./interfaces/sdk.mjs');
var {privateKeyToAccount} = await import('viem/accounts');
var {createPublicClient,createWalletClient,http,encodeAbiParameters} = await import('viem');
var chainId = Number(process.env.CLAUS_CHAIN_ID);
assert([1,11155111].includes(chainId));
var rpc = process.env.CLAUS_RPC_URL;
assert.equal(new URL(rpc).protocol,'https:');
var chain = createPublicClient({transport:http(rpc),cacheTime:0});
assert.equal(await chain.getChainId(),chainId);
var loadKey = async path => {
  assert.equal((await stat(path)).mode & 0o077,0,'Private key file must be mode 0600');
  return privateKeyToAccount((await readFile(path,'utf8')).trim());
};
var ownerSigner = await loadKey(process.env.CLAUS_OWNER_KEY_FILE);
var publisherSigner = await loadKey(process.env.CLAUS_PUBLISHER_KEY_FILE);
var stateFile = process.env.CLAUS_STATE_FILE;
await stat(stateFile).then(s=>assert.equal(s.mode & 0o077,0,'State must be private')).catch(e=>{if(e.code!=='ENOENT')throw e;});
var state = await readFile(stateFile,'utf8').then(JSON.parse).catch(e=>{
  if(e.code!=='ENOENT')throw e;return {chainId,slug:process.env.CLAUS_PROJECT_SLUG};
});
assert.equal(state.chainId,chainId);
var save = () => writeFile(stateFile,JSON.stringify(state,null,2)+'\n',{mode:0o600});
var once = async (key,run) => {
  if(Object.hasOwn(state,key))return state[key];
  assert(!state[key+'Pending'],'Reconcile the original '+key+' before continuing');
  state[key+'Pending']=true;await save();
  state[key]=await run();delete state[key+'Pending'];await save();return state[key];
};
var publicApi=createClient();
var capabilities=await publicApi.call('capabilities');
assert.equal(capabilities.publicDataServices.enabled,true);
assert.equal(capabilities.signalProfiles.find(p=>p.chainId===chainId)?.admission,'public');
var challenge=await publicApi.call('auth_challenge',{address:ownerSigner.address});
// Inspect the domain, nonce and expiry in challenge.message before signing.
state.session=await publicApi.call('auth_session',{challengeId:challenge.id,
  signature:await ownerSigner.signMessage({message:challenge.message})});await save();
var owner=createClient({token:state.session.token});
var project=await once('project',()=>owner.call('project_create',{
  slug:state.slug,name:'My Pulse',idempotencyKey:state.slug+':project'}));
var projectId=project.id;
var agent=await once('agent',()=>owner.call('agent_create',{projectId,name:'Pulse agent',idempotencyKey:'agent:1'}));
state.expiresAt??=Date.now()+24*3600000;await save();
var scopes=['project.read','artifact.read','artifact.write','snapshot.create','build.compile',
  'review.quote','review.admit','review.read','source.publish','project.publish',
  'proposal.create','proposal.read','proposal.execute','service.call','service.read','service.settle',
  'signal.manage','signal.read','signal.publish','signal.grant.revoke'];
var mandate=await once('mandate',()=>owner.call('mandate_create',{
  projectId,principalId:agent.id,scopes,expiresAt:state.expiresAt,idempotencyKey:'mandate:1'}));
var credential=await once('credential',()=>owner.call('credential_create',{mandateId:mandate.id}));
var api=createClient({token:credential.token});
var call=(name,input={})=>api.call(name,{projectId,...input});
await once('profile',()=>call('project_publish',{published:true,description:'Public chain data with a bounded publisher',expectedRevision:0}));
```

The example grants its agent the permissions needed for this whole walkthrough. Production providers receive separate mandates. An API credential alone cannot sign a publisher grant or change your contract.

## 2. Publish source, compile and request review

The two source files are unchanged from the pinned commit below. If you edit either, publish your own exact commit and review that commit instead.

```js
var files=await Promise.all(['ClausPulseModule.sol','ClausSignalTypes.sol'].map(async name=>({
  path:'contracts/src/'+name,content:await readFile('contracts/src/'+name,'utf8')})));
var snapshot=await once('snapshot',async()=>call('snapshot_create',{files,
  expectedProjectRevision:(await call('project_get')).revision}));
await once('sourcePublished',()=>call('source_publish',{snapshotId:snapshot.id,published:true,expectedRevision:0}));
var build=await once('build',()=>call('build_create',{snapshotId:snapshot.id,
  entry:'contracts/src/ClausPulseModule.sol',contract:'ClausPulseModule',sourceRoot:'contracts',idempotencyKey:'build:1'}));
```

Read `await call('build_get',{buildId:build.id})` until `state` is `compiled`. Stop and inspect any failed or blocked result. Then:

```js
var review=await once('review',()=>call('review_create',{buildId:build.id,
  repoUrl:'https://github.com/contractclaus/claus-network',
  baseCommit:'eb6f568c6b70682b6555f17128beb1d028f10150',idempotencyKey:'review:1'}));
var reviewState=await call('review_get',{caseId:review.id});
```

When the original case is `quoted`, inspect its quote. The example accepts only a fully sponsored quote with a provider maximum of 0.5 IMD:

```js
assert.equal(reviewState.state,'quoted');
assert.equal(reviewState.quote.maximum.project,'0');
assert(BigInt(reviewState.quote.offer.maximum)<=500000000000000000n);
await once('reviewAccepted',()=>call('review_accept',{
  caseId:review.id,quoteId:reviewState.quoteId,idempotencyKey:'review:accept:1'}));
```

Poll `review_get` for that same case until `reviewed`, then read `review_artifact`. A review reports findings; it is not a promise of approval. Do not create a second case to bypass an unavailable subsidy or an unresolved payment.

## 3. Register the reviewed evaluator

```js
var module=await once('module',()=>call('module_deploy',{caseId:review.id,chainId}));
```

Poll `module_get` with `moduleId:module.id` until `verified`. Its artifact must remain public. Then:

```js
var configuration=encodeAbiParameters([{type:'uint256'},{type:'uint256'}],[1000000000n,7200n]);
var registration=await once('registration',()=>owner.call('registration_prepare',{
  projectId,moduleId:module.id,configuration,mandateId:mandate.id,minDelaySeconds:0}));
assert.equal(registration.domain.chainId,chainId);
assert.equal(registration.message.owner.toLowerCase(),ownerSigner.address.toLowerCase());
// Inspect the exact evaluator, module, configuration hash and authority fields.
var signature=await once('registrationSignature',()=>ownerSigner.signTypedData({
  domain:registration.domain,types:registration.types,
  primaryType:registration.primaryType,message:registration.message}));
await once('registrationSubmitted',()=>call('registration_submit',{registrationId:registration.id,signature}));
```

Poll `registration_get` with the original registration ID until `verified`. `chain_binding` returns your exact target and chain. This initial registration does not let the publisher approve later upgrades.

## 4. Create the store and sign a finite grant

Prepare the store with `signal_store_prepare`. Sign only its exact zero-value transaction using the owner wallet. Persist the returned transaction hash immediately, then submit it to `signal_submit`. The same sequence below is used for grant registration and records; change the signer only as explicitly shown.

```js
var sendOperation=async (key,operation,signer)=>{
  if(operation.recovered)return operation;
  var t=operation.transaction;
  assert.equal(t.chainId,chainId);assert.equal(t.from,signer.address.toLowerCase());assert.equal(t.value,'0');
  var wallet=createWalletClient({account:signer,transport:http(rpc)});
  var hash=await once(key,()=>wallet.sendTransaction({chain:null,to:t.to,data:t.data,value:0n}));
  return call('signal_submit',{operationId:operation.id,transactionHash:hash});
};
var storeOperation=await once('storeOperation',()=>call('signal_store_prepare',{idempotencyKey:'store:1'}));
await sendOperation('storeHash',storeOperation,ownerSigner);
```

Poll `signal_operation` with `operationId:storeOperation.id` until `confirmed`. A wallet's send timeout is uncertain: preserve the pending state and recover the original hash from that wallet before proceeding. Never clear the journal and resend blindly.

```js
var signal=await call('signal_store');
var grant=await once('grant',()=>call('signal_grant_prepare',{
  publisher:publisherSigner.address,maximumWrites:24,minimumInterval:3600,
  expiresAt:Math.floor(state.expiresAt/1000),nonce:'1',idempotencyKey:'grant:1'}));
assert.equal(grant.typedData.domain.chainId,chainId);
assert.equal(grant.typedData.domain.verifyingContract.toLowerCase(),signal.address);
// Inspect every typed grant field before signing.
var grantSignature=await once('grantSignature',()=>ownerSigner.signTypedData(grant.typedData));
var grantOperation=await call('signal_grant_register',{operationId:grant.id,signature:grantSignature});
await sendOperation('grantHash',grantOperation,publisherSigner);
```

Poll the same grant operation until `confirmed`. `signal_grant` reads the finalized grant with `grantId:grant.grantId`.

## 5. Obtain and publish the two service results

Use `service_catalog` to select the current, published Observer (`chain.observation.v1`) and Evaluator (`signal.evaluate.v1`) services for your chain. Read each exact manifest and provider identity. The Claus-operated reference services are examples, not independent attestors. Set the selected IDs locally:

```js
var observerServiceId='REPLACE_WITH_SELECTED_OBSERVER_SERVICE_ID';
var evaluatorServiceId='REPLACE_WITH_SELECTED_EVALUATOR_SERVICE_ID';
var observerQuote=await once('observerQuote',()=>call('service_quote',{
  serviceId:observerServiceId,input:{chainId},idempotencyKey:'observation:1'}));
assert.equal(observerQuote.maximumWei,'0');
var observerOrder=await once('observerOrder',()=>call('service_accept',{quoteId:observerQuote.id}));
```

Poll `service_order` with `orderId:observerOrder.id` until `delivered`. Then explicitly accept and publish the output:

```js
var observation=await call('service_result',{orderId:observerOrder.id});
var order=await call('service_order',{orderId:observerOrder.id});
assert.equal(observation.status,'ok');
await call('service_accept_result',{orderId:order.id,outputHash:order.outputHash,accepted:true});
var expiresAt=Math.min(state.expiresAt,(observation.observedAt+7200)*1000);
await once('observerPublished',()=>call('service_result_publish',{
  orderId:order.id,outputHash:order.outputHash,published:true,expectedRevision:0,expiresAt}));
var observerPublic=await publicApi.call('public_service_result',{orderId:order.id});
var observerRef={id:order.id,revision:observerPublic.revision,outputHash:observerPublic.outputHash};
var evaluatorQuote=await once('evaluatorQuote',()=>call('service_quote',{
  serviceId:evaluatorServiceId,input:{observation,thresholdWei:'1000000000',ruleVersion:1},
  sourceResults:[observerRef],idempotencyKey:'evaluation:1'}));
assert.equal(evaluatorQuote.maximumWei,'0');
var evaluatorOrder=await once('evaluatorOrder',()=>call('service_accept',{quoteId:evaluatorQuote.id}));
```

Wait for that order to be `delivered`, then:

```js
var evaluation=await call('service_result',{orderId:evaluatorOrder.id});
var order=await call('service_order',{orderId:evaluatorOrder.id});
assert.equal(evaluation.status,'ok');
await call('service_accept_result',{orderId:order.id,outputHash:order.outputHash,accepted:true});
await once('evaluatorPublished',()=>call('service_result_publish',{
  orderId:order.id,outputHash:order.outputHash,published:true,expectedRevision:0,expiresAt}));
var evaluatorPublic=await publicApi.call('public_service_result',{orderId:order.id});
var sourceResult={id:order.id,revision:evaluatorPublic.revision,outputHash:evaluatorPublic.outputHash};
```

This exposes only the explicitly published outputs and provenance. Provider keys and your credential are not forwarded. Independently validate observations before trusting them; the contract records an authorized attestation, not proof of external truth.

## 6. Publish the first finalized record

```js
var latest=await call('signal_latest');
var record=await once('record',()=>call('signal_record_prepare',{
  grantId:grant.grantId,sequence:Number(latest.record.sequence)+1,expectedVersion:1,
  observedAt:observation.observedAt,validUntil:Math.floor(expiresAt/1000),
  sourceResult,data:evaluation.onchainData,idempotencyKey:'record:1'}));
await sendOperation('recordHash',record,publisherSigner);
```

Poll `signal_operation` for that original record until `confirmed`, then:

```js
var final=await call('signal_latest');
assert(final.finalized);assert.equal(final.state,'current');
await once('signalPublished',()=>call('signal_publish',{published:true,expectedRevision:0}));
console.log('https://claus.si/p/'+state.slug);
```

The public record includes its sequence, evaluator version, source digest and finalized block. The page is an explorer of those records. A stale, withdrawn or superseded record remains historical evidence.

## 7. Request a reviewed change or revoke

A publisher cannot change the rule. A configuration change of the reviewed module uses:

```js
var nextConfiguration=encodeAbiParameters([{type:'uint256'},{type:'uint256'}],[2000000000n,7200n]);
var proposal=await once('proposal',()=>call('proposal_create',{
  moduleId:module.id,configuration:nextConfiguration,idempotencyKey:'rule:2'}));
var decision=await call('proposal_get',{proposalId:proposal.id});
```

Poll that proposal. Claus receives the independent module review and the exact signal consumer context. `approved` is a decision; `executed` plus finalized chain evidence proves the change. If Claus rejects, inspect the reason. Subsequent records must use the actual new rule and evaluator version. New source requires a new source/build/review, not reuse of an older report.

To stop publication:

```js
var revoke=await once('revoke',()=>call('signal_grant_revoke',{
  grantId:grant.grantId,idempotencyKey:'revoke:1'}));
await sendOperation('revokeHash',revoke,ownerSigner);
```

The API stops new prepared work immediately. Poll the revocation operation until finalized, then check `signal_grant`: both API and onchain revocation must be confirmed. Revoke the API mandate separately with `owner.call('mandate_revoke',{mandateId:mandate.id})`. Neither action erases an old record or cancels an already-broadcast transaction.

For automatic operation, the existing [reference pipeline](https://github.com/contractclaus/claus-network/blob/main/reference/pulse-pipeline.mjs) preserves the same order and transaction IDs. Its scheduler limits new work to one run per hour and ends at its explicit quota or expiry; it does not refill gas or create owner grants.
