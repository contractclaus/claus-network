import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {publicAddress} from '../research-transport.js';

export function browserOrigin(raw:string){
 const u=new URL(raw),host=u.hostname.toLowerCase().replace(/\.$/,'');
 if(raw!==u.origin||u.protocol!=='https:'||u.username||u.password||u.port||isIP(host)||!host.includes('.')||/\.(?:local|localhost|internal|invalid|test)$/.test(host))throw Error('browser_public_origin_required');
 return u.origin;
}
export async function publicBrowserOrigin(raw:string,resolve:any=lookup){
 const origin=browserOrigin(raw),host=new URL(origin).hostname;
 const addresses=await resolve(host,{all:true,family:4});
 if(!addresses.length||addresses.some((a:any)=>!publicAddress(a.address)))throw Error('browser_public_address_required');
 return origin;
}
// This checks public DNS before dispatch. Browserbase makes the browser's own
// DNS connection; this is not a claim that its remote address is pinned here.
export async function browserNavigation(policy:any,raw:string){
 const u=new URL(raw);
 if(u.protocol!=='https:'||u.username||u.password||!policy.browser?.origins.includes(u.origin))throw Error('browser_origin_not_authorized');
 await publicBrowserOrigin(u.origin);return u.href;
}
