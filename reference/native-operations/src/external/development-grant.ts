import {DEVELOPMENT_LIMITS} from '../development-limits.js';
import {createHmac,timingSafeEqual} from 'node:crypto';
export type Grant={v:1;parent:string;expires:number};
const signature=(value:string,key:string)=>createHmac('sha256',key).update(value).digest('base64url');
export function mintDevelopmentGrant(parent:string,expires:number,key:string){
 if(key.length<32||!parent.startsWith('development:')||!Number.isSafeInteger(expires))throw Error('development_tool_grant_invalid');
 const body=Buffer.from(JSON.stringify({v:1,parent,expires})).toString('base64url');return body+'.'+signature(body,key);
}
export function readDevelopmentGrant(token:string,key:string,now=Date.now()):Grant{
 if(key.length<32||token.length>2000)throw Error('development_tool_grant_invalid');
 const [body,sig,extra]=token.split('.'),expected=signature(body??'',key);
 if(extra||!sig||sig.length!==expected.length||!timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))throw Error('development_tool_grant_invalid');
 const grant=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));
 if(grant.v!==1||typeof grant.parent!=='string'||!grant.parent.startsWith('development:')||!Number.isSafeInteger(grant.expires)||grant.expires<=now||grant.expires>now+(DEVELOPMENT_LIMITS.seconds+60)*1000)throw Error('development_tool_grant_expired');
 return grant;
}
export function developmentTools(id:string,deadline:string,env:NodeJS.ProcessEnv=process.env){
 const key=env.CLAUS_TOOL_GATEWAY_SECRET,origin=env.CLAUS_TOOL_GATEWAY_ORIGIN;
 if(!key||!origin)return null;
 const url=new URL(origin);if(url.protocol!=='https:'||url.origin!==origin||url.username||url.password)throw Error('development_tool_origin_invalid');
 return {host:url.hostname,url:origin+'/internal/development/tools',token:mintDevelopmentGrant(id,Date.parse(deadline),key)};
}
export const developmentToolClient=`// Server credentials never enter this client. The task grant expires with this run.
export async function tools(requestId, request) {
 if (!/^[a-zA-Z0-9_-]{1,80}$/.test(requestId)) throw Error('Use a stable request ID for this operation');
 const url=process.env.CLAUS_TOOLS_URL, token=process.env.CLAUS_TOOLS_TOKEN;
 if(!url||!token)throw Error('External tool bridge unavailable');
 const r=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({requestId,request}),signal:AbortSignal.timeout(55000)});
 const result=await r.json();if(!r.ok)throw Error(JSON.stringify(result));return result;
}
`;
