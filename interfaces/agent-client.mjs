import {createClient,DEFAULT_API_ORIGIN} from './sdk.mjs';

// The supplied signer belongs to the caller. No wallet transaction is signed.
export function createAgentClient({account,origin=DEFAULT_API_ORIGIN,fetch:request=globalThis.fetch,now=()=>Date.now()}={}) {
 if(!account?.address||typeof account.signMessage!=='function')throw Error('A local login signer is required');
 const base=new URL(origin),publicClient=createClient({origin,fetch:request});let session=null,pending=null;
 async function login(){
  const c=await publicClient.call('auth_challenge',{address:account.address}),domain=base.host;
  const prefix=`${domain} wants you to sign in with your Ethereum account:\n${account.address.toLowerCase()}\n\nSign in to Claus Network. This does not authorize a blockchain transaction.\n\nURI: https://${domain}/network\nVersion: 1\nChain ID: 1\nNonce: `;
  const match=typeof c.message==='string'&&c.message.startsWith(prefix)&&/^([a-f0-9]{32})\nIssued At: ([^\n]+)\nExpiration Time: ([^\n]+)\nRequest ID: (auth_[A-Za-z0-9-]+)$/.exec(c.message.slice(prefix.length));
  if(c.chainId!==1||!match||match[4]!==c.id||Date.parse(match[3])!==c.expiresAt||!Number.isFinite(Date.parse(match[2]))||Math.abs(now()-Date.parse(match[2]))>301000||!Number.isSafeInteger(c.expiresAt)||c.expiresAt<=now()||c.expiresAt>now()+301000)throw Error('Invalid login challenge');
  const result=await publicClient.call('auth_session',{challengeId:c.id,signature:await account.signMessage({message:c.message})});
  if(!/^cln_[A-Za-z0-9_-]{43}$/.test(result.token??'')||!Number.isSafeInteger(result.credential?.expiresAt)||result.credential.expiresAt<=now())throw Error('Invalid login session');
  session=result;return result.token;
 }
 const client=createClient({origin,fetch:request,token:async()=>{
  if(session?.credential.expiresAt>now()+30000)return session.token;
  if(!pending)pending=login().finally(()=>{pending=null;});return pending;
 }});
 return {async call(name,input={},options={}){try{return await client.call(name,input,options);}catch(e){if(e.status===401)session=null;throw e;}},
  identity:()=>({address:account.address}),clearSession:()=>{session=null;}};
}
