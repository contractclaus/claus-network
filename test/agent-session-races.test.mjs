import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentClient} from '../interfaces/agent-client.mjs';

function fixture(){
 const now=1800000000000,address='0x'+'1'.repeat(40),origin='https://claus.example';
 const state={sessions:0,signatures:0,reads:[],challenge:null,read:null};
 const challenge={id:'auth_fixture',chainId:1,expiresAt:now+300000};
 challenge.message=`claus.example wants you to sign in with your Ethereum account:\n${address}\n\nSign in to Claus Network. This does not authorize a blockchain transaction.\n\nURI: ${origin}/network\nVersion: 1\nChain ID: 1\nNonce: ${'a'.repeat(32)}\nIssued At: ${new Date(now).toISOString()}\nExpiration Time: ${new Date(challenge.expiresAt).toISOString()}\nRequest ID: ${challenge.id}`;
 const client=createAgentClient({origin,now:()=>now,account:{address,signMessage:async()=>{state.signatures++;return 'local-fixture-signature';}},fetch:async(url,options)=>{
  if(url.pathname==='/v1/auth/challenge')return state.challenge?state.challenge(challenge):Response.json(challenge);
  if(url.pathname==='/v1/auth/session'){state.sessions++;return Response.json({token:'cln_'+String(state.sessions).repeat(43),credential:{expiresAt:now+3600000}});}
  assert.equal(url.pathname,'/v1/projects');state.reads.push(options.headers.authorization);
  return state.read?state.read():Response.json({items:[]});
 }});
 return {client,state};
}

test('a late unauthorized response cannot clear a newer login',async()=>{
 const {client,state}=fixture();await client.call('project_list');
 const started=Promise.withResolvers(),response=Promise.withResolvers();
 state.read=()=>{state.read=null;started.resolve();return response.promise;};
 const old=client.call('project_list');await started.promise;
 client.clearSession();await client.call('project_list');
 response.resolve(Response.json({error:'unauthenticated'},{status:401}));await assert.rejects(old,{status:401});
 await client.call('project_list');assert.equal(state.sessions,2);
 assert.equal(state.reads.at(-1),state.reads.at(-2));
});

test('clearing a pending login prevents it restoring a session or dispatching the requested operation',async()=>{
 const {client,state}=fixture(),started=Promise.withResolvers(),response=Promise.withResolvers();
 state.challenge=body=>{state.challenge=null;started.resolve(body);return response.promise;};
 const old=client.call('project_list'),body=await started.promise;client.clearSession();
 response.resolve(Response.json(body));await assert.rejects(old,{code:'session_cleared'});
 assert.equal(state.signatures,0);assert.equal(state.sessions,0);assert.equal(state.reads.length,0);
 await Promise.all([client.call('project_list'),client.call('project_list')]);assert.equal(state.sessions,1);
});
