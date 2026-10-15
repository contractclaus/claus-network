import {createHmac,randomBytes} from 'node:crypto';
import {SocialError} from './policy.js';
const encode=(s)=>encodeURIComponent(s).replace(/[!'()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function oauthHeader(method,url,credentials,nonce=randomBytes(16).toString('hex'),timestamp=String(Math.floor(Date.now()/1000))) {
  const target=new URL(url);
  const oauth={oauth_consumer_key:credentials.key,oauth_nonce:nonce,oauth_signature_method:'HMAC-SHA1',oauth_timestamp:timestamp,oauth_token:credentials.token,oauth_version:'1.0'};
  const entries=[...Object.entries(oauth),...target.searchParams.entries()].map(([k,v])=>[encode(k),encode(v)]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:a[1]<b[1]?-1:a[1]>b[1]?1:0);
  const params=entries.map(([k,v])=>`${k}=${v}`).join('&');
  const base=[method.toUpperCase(),`${target.origin}${target.pathname}`,params].map(encode).join('&');
  oauth.oauth_signature=createHmac('sha1',`${encode(credentials.secret)}&${encode(credentials.tokenSecret)}`).update(base).digest('base64');
  return 'OAuth '+Object.entries(oauth).map(([k,v])=>`${encode(k)}="${encode(v)}"`).join(', ');
}

export function credentials(){return {key:process.env.X_API_KEY,secret:process.env.X_API_SECRET,token:process.env.X_ACCESS_TOKEN,tokenSecret:process.env.X_ACCESS_SECRET};}
export async function providerRequest(path,method='GET',body,request=fetch,keys=credentials()){
 if(Object.values(keys).some(v=>!v))throw new SocialError('x_credentials_missing');
 const url='https://api.x.com/2/'+path;
 const r=await request(url,{method,headers:{Authorization:oauthHeader(method,url,keys),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(20000)});
 if(!r.ok){
  if(method==='POST'&&[400,401,403,422,429].includes(r.status)){
   let detail='';try{const p=await r.json();detail=[p?.title,p?.detail,...(Array.isArray(p?.errors)?p.errors.slice(0,3).flatMap(e=>[Number.isSafeInteger(e?.code)?'code '+e.code:undefined,e?.message]):[])].filter(s=>typeof s==='string'&&s.trim()).filter((s,i,a)=>a.indexOf(s)===i).join('; ');for(const key of Object.values(keys))if(key)detail=detail.replaceAll(key,'[redacted]');detail=[...detail.replace(/https?:\/\/[^\s]+/gi,'[provider URL]').replace(/[\u0000-\u001f\u007f]/g,' ')].slice(0,800).join('');}catch{}
   let retryAt;const now=Date.now(),after=r.headers.get('retry-after'),reset=r.headers.get('x-rate-limit-reset');const ts=[after===null?NaN:/^\d+(?:\.\d+)?$/.test(after)?now+Number(after)*1000:Date.parse(after),reset===null?NaN:Number(reset)*1000].filter(n=>Number.isFinite(n)&&n>now&&n<8640000000000000);if(ts.length)retryAt=new Date(Math.max(...ts)).toISOString();
   throw new SocialError('x_http_'+r.status+'_not_published'+(detail?': '+detail:''),true,r.status===429?retryAt:undefined);
  }
  await r.body?.cancel();throw new SocialError('x_http_'+r.status);
 }
 return r.json();
}
