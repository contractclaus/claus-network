import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { verifyMessage } from 'viem';
import { openStore } from '../src/storage/index.mjs';
import { createIdentity } from '../src/identity/index.mjs';
import { createArtifactStore } from '../src/artifact-store/index.mjs';
import { createServices } from '../src/services/index.mjs';
import { schemaDefinition } from '../src/services/schema.mjs';
import { createServiceConformance } from '../runtime/service-conformance.mjs';

async function fixture(t) {
  const store=openStore(':memory:');t.after(()=>store.close());let time=1800000000000;
  const identity=createIdentity({store,now:()=>time,verifySignature:({address,message,signature})=>verifyMessage({address,message,signature})});
  const services=createServices({store,identity,artifacts:createArtifactStore({store}),now:()=>time});
  async function project(name){
    const key=privateKeyToAccount(generatePrivateKey()),c=await identity.challenge({address:key.address});
    const login=await identity.session({challengeId:c.id,signature:await key.signMessage({message:c.message})});
    const owner=await identity.authenticate(login.token),p=await identity.createProject(owner,{slug:name,name,idempotencyKey:name});
    const agent=await identity.createAgent(owner,p.id,{name:'test agent'});
    const mandate=await identity.grant(owner,p.id,{principalId:agent.id,scopes:['service.manage','service.read','service.call','service.provide','project.publish'],expiresAt:time+86400000});
    const token=await identity.issueCredential(owner,{mandateId:mandate.id});
    return {id:p.id,owner,actor:await identity.authenticate(token.token),mandate,key};
  }
  const provider=await project('test-provider'),buyer=await project('test-buyer'),stranger=await project('test-stranger');
  const schema={type:'object',properties:{value:{type:'string',maxLength:100}},required:['value'],additionalProperties:false};
  const manifest=(price='0',version='1.0.0')=>({name:'Test service',capability:'test.echo',version,inputSchema:schema,outputSchema:schema,
    priceWei:price,recipient:provider.key.address,maxDurationSeconds:600,validUntil:time+86400000,dataPolicy:'no-delegation'});
  async function available(price='0',version='1.0.0'){
    const value=await services.register(provider.actor,provider.id,manifest(price,version));
    await services.compatibility(value.id,{manifestHash:value.manifestHash,suite:'claus-pull-service-v1',runId:'test-only',passed:true});
    await services.publish(provider.actor,provider.id,{serviceId:value.id,published:true,expectedRevision:0});return value;
  }
  return {store,identity,services,provider,buyer,stranger,manifest,available,advance:ms=>time+=ms};
}
test('service manifests are immutable, private until published, and data validators cannot execute references',async t=>{
  const f=await fixture(t),v=await f.services.register(f.provider.actor,f.provider.id,f.manifest());
  assert.equal((await f.services.discovery()).services.length,0);
  await assert.rejects(f.services.publish(f.provider.actor,f.provider.id,{serviceId:v.id,published:true,expectedRevision:0}),{code:'service_not_available'});
  await assert.rejects(f.services.register(f.provider.actor,f.provider.id,{...f.manifest(),priceWei:'1'}),{code:'service_version_conflict'});
  assert.throws(()=>schemaDefinition({type:'string',maxLength:12,$ref:'https://example.com/schema'}),{code:'invalid_service_schema'});
  await assert.rejects(f.services.compatibility(v.id,{manifestHash:'wrong',suite:'claus-pull-service-v1',runId:'one',passed:true}),{code:'service_version_conflict'});
});
test('two independent project clients exchange schema-bound results and accept them separately from delivery',async t=>{
  const f=await fixture(t),v=await f.available();
  const quote=await f.services.quote(f.buyer.actor,f.buyer.id,{serviceId:v.id,input:{value:'private input'},idempotencyKey:'one'});
  const order=await f.services.accept(f.buyer.actor,f.buyer.id,quote.id);
  assert.equal(order.payment.state,'not_required');assert.equal('buyerActor' in order,false);
  await assert.rejects(f.services.claim(f.stranger.actor,f.stranger.id,order.id),{code:'not_found'});
  assert.equal((await f.services.assigned(f.stranger.actor,f.stranger.id)).orders.length,0);
  const claim=await f.services.claim(f.provider.actor,f.provider.id,order.id);assert.equal(claim.input.value,'private input');
  await assert.rejects(f.services.deliver(f.provider.actor,f.provider.id,{orderId:order.id,lease:claim.lease,output:{value:'x',injected:true}}),{code:'service_schema_mismatch'});
  const delivered=await f.services.deliver(f.provider.actor,f.provider.id,{orderId:order.id,lease:claim.lease,output:{value:'result'}});
  assert.equal(delivered.acceptance,'pending');assert.equal('leaseHash' in delivered,false);
  await assert.rejects(f.services.result(f.stranger.actor,f.buyer.id,order.id),{code:'scope_denied'});
  assert.deepEqual(await f.services.result(f.buyer.actor,f.buyer.id,order.id),{value:'result'});
  const accepted=await f.services.acceptResult(f.buyer.actor,f.buyer.id,{orderId:order.id,outputHash:delivered.outputHash,accepted:true});
  assert.equal(accepted.acceptance,'accepted');
  await assert.rejects(f.services.acceptResult(f.buyer.actor,f.buyer.id,{orderId:order.id,outputHash:delivered.outputHash,accepted:false}),{code:'acceptance_conflict'});
});
test('paid requests pin exact price and refuse provider access before a verified receipt',async t=>{
  const f=await fixture(t),v=await f.available('100');
  const quote=await f.services.quote(f.buyer.actor,f.buyer.id,{serviceId:v.id,input:{value:'paid'},idempotencyKey:'one'});
  await f.available('900','2.0.0');
  const order=await f.services.accept(f.buyer.actor,f.buyer.id,quote.id);assert.equal(order.payment.maximumWei,'100');
  await assert.rejects(f.services.claim(f.provider.actor,f.provider.id,order.id),{code:'service_order_busy'});
  const receipt={quoteHash:order.quoteHash,chainId:11155111,transactionHash:'0x'+'ab'.repeat(32),amountWei:'100',recipient:f.provider.key.address};
  await assert.rejects(f.services.paymentConfirmed(order.id,{...receipt,amountWei:'99'}),{code:'payment_mismatch'});
  const paid=await f.services.paymentConfirmed(order.id,receipt);assert.equal(paid.state,'queued');
  assert.equal((await f.services.paymentConfirmed(order.id,receipt)).payment.state,'confirmed');
  const q2=await f.services.quote(f.buyer.actor,f.buyer.id,{serviceId:v.id,input:{value:'second'},idempotencyKey:'two'});
  const o2=await f.services.accept(f.buyer.actor,f.buyer.id,q2.id);
  await assert.rejects(f.services.paymentConfirmed(o2.id,{...receipt,quoteHash:o2.quoteHash}),{code:'receipt_already_used'});
});
test('expired provider leases cannot overwrite a replacement result, and revoked buyers expose no new input',async t=>{
  const f=await fixture(t),v=await f.available();
  const quote=await f.services.quote(f.buyer.actor,f.buyer.id,{serviceId:v.id,input:{value:'first'},idempotencyKey:'one'});
  const order=await f.services.accept(f.buyer.actor,f.buyer.id,quote.id);
  const old=await f.services.claim(f.provider.actor,f.provider.id,order.id);f.advance(121000);
  const replacement=await f.services.claim(f.provider.actor,f.provider.id,order.id);
  await assert.rejects(f.services.deliver(f.provider.actor,f.provider.id,{orderId:order.id,lease:old.lease,output:{value:'late'}}),{code:'lease_lost'});
  await f.services.deliver(f.provider.actor,f.provider.id,{orderId:order.id,lease:replacement.lease,output:{value:'current'}});
  const q2=await f.services.quote(f.buyer.actor,f.buyer.id,{serviceId:v.id,input:{value:'withheld'},idempotencyKey:'two'});
  const o2=await f.services.accept(f.buyer.actor,f.buyer.id,q2.id);
  await f.identity.revoke(f.buyer.owner,'mandate',f.buyer.mandate.id);
  assert.deepEqual(await f.services.claim(f.provider.actor,f.provider.id,o2.id),{id:o2.id,state:'cancelled'});
});
test('late payment reconciliation preserves cost after cancellation without dispatching work',async t=>{
  const f=await fixture(t),v=await f.available('100');
  const q=await f.services.quote(f.buyer.actor,f.buyer.id,{serviceId:v.id,input:{value:'one'},idempotencyKey:'one'});
  const o=await f.services.accept(f.buyer.actor,f.buyer.id,q.id);await f.services.cancel(f.buyer.actor,f.buyer.id,o.id);
  const paid=await f.services.paymentConfirmed(o.id,{quoteHash:o.quoteHash,chainId:11155111,transactionHash:'0x'+'cd'.repeat(32),amountWei:'100',recipient:f.provider.key.address});
  assert.equal(paid.state,'cancelled');assert.equal(paid.payment.state,'confirmed');
  await assert.rejects(f.services.claim(f.provider.actor,f.provider.id,o.id),{code:'service_order_busy'});
});

test('host conformance requires a real provider claim and schema-bound delivery before publication',async t=>{
  const f=await fixture(t),v=await f.services.register(f.provider.actor,f.provider.id,f.manifest());
  const runtime=createServiceConformance({store:f.store,services:f.services});
  await runtime.tick();
  const probe=(await f.services.assigned(f.provider.actor,f.provider.id)).orders[0];
  assert.equal(probe.purpose,'conformance');assert.equal(probe.payment.state,'not_required');
  await assert.rejects(f.services.claim(f.stranger.actor,f.stranger.id,probe.id),{code:'not_found'});
  await assert.rejects(f.services.publish(f.provider.actor,f.provider.id,{serviceId:v.id,published:true,expectedRevision:0}),{code:'service_not_available'});
  const claim=await f.services.claim(f.provider.actor,f.provider.id,probe.id);
  await f.services.deliver(f.provider.actor,f.provider.id,{orderId:probe.id,lease:claim.lease,output:claim.input});
  await runtime.tick();
  const checked=await f.services.version(f.provider.actor,f.provider.id,v.id);
  assert.equal(checked.state,'available');assert.equal(checked.compatibility.scope,'transport-and-schema');
  assert.equal((await f.services.discovery()).services.length,0);
  await f.services.publish(f.provider.actor,f.provider.id,{serviceId:v.id,published:true,expectedRevision:0});
  assert.equal((await f.services.discovery()).services.length,1);
});

test('expired paid orders preserve settlement and cannot be claimed or delivered',async t=>{
  const f=await fixture(t),v=await f.available('100');
  const q=await f.services.quote(f.buyer.actor,f.buyer.id,{serviceId:v.id,input:{value:'late'},idempotencyKey:'late'});
  const order=await f.services.accept(f.buyer.actor,f.buyer.id,q.id);f.advance(601000);
  assert.equal((await f.services.expire()).expired,1);
  const paid=await f.services.paymentConfirmed(order.id,{quoteHash:order.quoteHash,chainId:11155111,
    transactionHash:'0x'+'fe'.repeat(32),amountWei:'100',recipient:f.provider.key.address});
  assert.equal(paid.state,'expired');assert.equal(paid.payment.state,'confirmed');
  await assert.rejects(f.services.claim(f.provider.actor,f.provider.id,order.id),{code:'service_order_busy'});
});

test('a replacement agent can explicitly adopt pending work without changing its quote or payment',async t=>{
  const f=await fixture(t),v=await f.available();
  const q=await f.services.quote(f.buyer.actor,f.buyer.id,{serviceId:v.id,input:{value:'continue'},idempotencyKey:'continue'});
  const o=await f.services.accept(f.buyer.actor,f.buyer.id,q.id);
  await f.identity.revoke(f.buyer.owner,'mandate',f.buyer.mandate.id);
  const agent=await f.identity.createAgent(f.buyer.owner,f.buyer.id,{name:'Replacement'});
  const mandate=await f.identity.grant(f.buyer.owner,f.buyer.id,{principalId:agent.id,scopes:['service.call','service.read'],expiresAt:f.buyer.mandate.expiresAt});
  const key=await f.identity.issueCredential(f.buyer.owner,{mandateId:mandate.id});
  const actor=await f.identity.authenticate(key.token);
  await assert.rejects(f.services.authorizeOrder(f.buyer.actor,f.buyer.id,{orderId:o.id,quoteHash:o.quoteHash}),{code:'scope_denied'});
  await assert.rejects(f.services.authorizeOrder(actor,f.buyer.id,{orderId:o.id,quoteHash:'changed'}),{code:'quote_input_mismatch'});
  const adopted=await f.services.authorizeOrder(actor,f.buyer.id,{orderId:o.id,quoteHash:o.quoteHash});
  assert.equal(adopted.id,o.id);assert.deepEqual(adopted.payment,o.payment);
  const claim=await f.services.claim(f.provider.actor,f.provider.id,o.id);assert.equal(claim.input.value,'continue');
});
