import test from 'node:test';
import assert from 'node:assert/strict';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
import {verifyMessage} from 'viem';
import {openStore} from '../src/storage/index.mjs';
import {createIdentity} from '../src/identity/index.mjs';

async function fixture(t){
 const store=openStore(':memory:');t.after(()=>store.close());
 let time=1800000000000;
 const identity=createIdentity({store,now:()=>time,verifySignature:({address,message,signature})=>verifyMessage({address,message,signature})});
 const login=async()=>{
  const account=privateKeyToAccount(generatePrivateKey());
  const challenge=await identity.challenge({address:account.address});
  const signature=await account.signMessage({message:challenge.message});
  const session=await identity.session({challengeId:challenge.id,signature});
  return {account,challenge,signature,...session,actor:await identity.authenticate(session.token)};
 };
 return {store,identity,login,advance:ms=>{time+=ms;},now:()=>time};
}

test('real signed challenge is single-use, domain bound and expires',async t=>{
 const f=await fixture(t),alice=await f.login();
 assert.match(alice.challenge.message,/^claus\.si wants you to sign in/);
 await assert.rejects(f.identity.session({challengeId:alice.challenge.id,signature:alice.signature}),{code:'challenge_expired'});
 const c=await f.identity.challenge({address:alice.account.address});
 const wrong=privateKeyToAccount(generatePrivateKey());
 await assert.rejects(f.identity.session({challengeId:c.id,signature:await wrong.signMessage({message:c.message})}),{code:'invalid_signature'});
 f.advance(300001);
 await assert.rejects(f.identity.session({challengeId:c.id,signature:await alice.account.signMessage({message:c.message})}),{code:'challenge_expired'});
});

test('project isolation, bounded delegation, rotation and revoke survive independent requests',async t=>{
 const f=await fixture(t),a=await f.login(),b=await f.login();
 const project=await f.identity.createProject(a.actor,{slug:'alice-project',name:'Alice',idempotencyKey:'create-one'});
 assert.deepEqual(await f.identity.createProject(a.actor,{slug:'alice-project',name:'Alice',idempotencyKey:'create-one'}),project);
 await assert.rejects(f.identity.createProject(a.actor,{slug:'changed',name:'Alice',idempotencyKey:'create-one'}),{code:'idempotency_conflict'});
 await assert.rejects(f.identity.project(b.actor,project.id),{code:'scope_denied'});
 const agent=await f.identity.createAgent(a.actor,project.id,{name:'Build agent'});
 await assert.rejects(f.identity.grant(a.actor,project.id,{principalId:agent.id,scopes:['policy.activate'],expiresAt:f.now()+60000}),{code:'invalid_scopes'});
 const mandate=await f.identity.grant(a.actor,project.id,{principalId:agent.id,scopes:['project.read','review.read'],expiresAt:f.now()+60000});
 const key=await f.identity.issueCredential(a.actor,{mandateId:mandate.id});
 const actor=await f.identity.authenticate(key.token);
 assert.equal((await f.identity.project(actor,project.id)).id,project.id);
 assert.equal(await f.identity.allowed(actor,'review.admit',{projectId:project.id}),false);
 await assert.rejects(f.identity.createAgent(actor,project.id,{name:'Elevate'}),{code:'scope_denied'});
 const replacement=await f.identity.rotate(actor,key.credential.id);
 await assert.rejects(f.identity.authenticate(key.token),{code:'unauthenticated'});
 const newActor=await f.identity.authenticate(replacement.token);
 assert.equal(replacement.credential.expiresAt,key.credential.expiresAt);
 assert.deepEqual(replacement.credential.scopes,key.credential.scopes);
 await f.identity.revoke(a.actor,'mandate',mandate.id);
 assert.equal(await f.identity.allowed(newActor,'project.read',{projectId:project.id}),false);
 await assert.rejects(f.identity.rotate(newActor,replacement.credential.id),{code:'mandate_revoked'});
 const events=await f.store.events();
 assert.ok(!JSON.stringify(events).includes(key.token));
 assert.ok(!JSON.stringify(events).includes(a.token));
});

test('simultaneous logins cannot consume the same signed challenge twice',async t=>{
 const f=await fixture(t),account=privateKeyToAccount(generatePrivateKey());
 const c=await f.identity.challenge({address:account.address});
 const input={challengeId:c.id,signature:await account.signMessage({message:c.message})};
 const results=await Promise.allSettled([f.identity.session(input),f.identity.session(input)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.find(r=>r.status==='rejected').reason.code,'challenge_expired');
});

test('authorization checks see revocation inside the state transaction',async t=>{
 const f=await fixture(t),a=await f.login();
 const project=await f.identity.createProject(a.actor,{slug:'transaction-test',name:'Transaction',idempotencyKey:'one'});
 const agent=await f.identity.createAgent(a.actor,project.id,{name:'Agent'});
 const m=await f.identity.grant(a.actor,project.id,{principalId:agent.id,scopes:['review.admit'],expiresAt:f.now()+60000});
 const key=await f.identity.issueCredential(a.actor,{mandateId:m.id}),actor=await f.identity.authenticate(key.token);
 assert.equal(await f.identity.allowed(actor,'review.admit',{projectId:project.id}),true);
 await f.identity.revoke(a.actor,'mandate',m.id);
 await assert.rejects(f.store.transaction(tx=>f.identity.authorize(actor,'review.admit',{projectId:project.id},tx)),{code:'scope_denied'});
});
