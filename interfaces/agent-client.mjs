import {createClient,DEFAULT_API_ORIGIN,ClausNetworkError} from './sdk.mjs';

// The supplied signer belongs to the caller. No wallet transaction is signed.
export function createAgentClient({account,origin=DEFAULT_API_ORIGIN,fetch:request=globalThis.fetch,now=()=>Date.now()}={}) {
 if(!account?.address||typeof account.signMessage!=='function')throw Error('A local login signer is required');
 const base=new URL(origin),publicClient=createClient({origin,fetch:request});let session=null,pending=null,generation=0;
 const current=epoch=>{if(epoch!==generation)throw new ClausNetworkError('session_cleared',0,{outcome:'rejected',automaticRetry:false});};
 async function login(epoch){
  const c=await publicClient.call('auth_challenge',{address:account.address}),domain=base.host;
  current(epoch);
  const prefix=`${domain} wants you to sign in with your Ethereum account:\n${account.address.toLowerCase()}\n\nSign in to Claus Network. This does not authorize a blockchain transaction.\n\nURI: https://${domain}/network\nVersion: 1\nChain ID: 1\nNonce: `;
  const match=typeof c.message==='string'&&c.message.startsWith(prefix)&&/^([a-f0-9]{32})\nIssued At: ([^\n]+)\nExpiration Time: ([^\n]+)\nRequest ID: (auth_[A-Za-z0-9-]+)$/.exec(c.message.slice(prefix.length));
  if(c.chainId!==1||!match||match[4]!==c.id||Date.parse(match[3])!==c.expiresAt||!Number.isFinite(Date.parse(match[2]))||Math.abs(now()-Date.parse(match[2]))>301000||!Number.isSafeInteger(c.expiresAt)||c.expiresAt<=now()||c.expiresAt>now()+301000)throw Error('Invalid login challenge');
  const signature=await account.signMessage({message:c.message});current(epoch);
  const result=await publicClient.call('auth_session',{challengeId:c.id,signature});current(epoch);
  if(!/^cln_[A-Za-z0-9_-]{43}$/.test(result.token??'')||!Number.isSafeInteger(result.credential?.expiresAt)||result.credential.expiresAt<=now())throw Error('Invalid login session');
  session=result;return result.token;
 }
 async function token(){
  if(session?.credential.expiresAt>now()+30000)return session.token;
  if(!pending){const attempt=login(generation).finally(()=>{if(pending===attempt)pending=null;});pending=attempt;}return pending;
 }
 return {async call(name,input={},options={}){
   let used;
   const client=createClient({origin,fetch:request,token:async()=>{used=await token();return used;}});
   try{return await client.call(name,input,options);}catch(e){if(e.status===401&&used&&session?.token===used)session=null;throw e;}
  },identity:()=>({address:account.address}),clearSession:()=>{generation++;session=null;pending=null;}};
}
