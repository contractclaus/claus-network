import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {createHash} from 'node:crypto';
const digest=(kind,b)=>createHash(kind).update(b).digest('hex');
export function publicIPv4(a){const x=a.split('.').map(Number);return x.length===4&&x.every(n=>Number.isInteger(n)&&n>=0&&n<=255)&&x[0]!==0&&x[0]!==10&&x[0]!==127&&x[0]<224&&!(x[0]===100&&x[1]>=64&&x[1]<=127)&&!(x[0]===169&&x[1]===254)&&!(x[0]===172&&x[1]>=16&&x[1]<=31)&&!(x[0]===192&&(x[1]===168||x[1]===0||x[1]===88))&&!(x[0]===198&&(x[1]===18||x[1]===19||x[1]===51))&&!(x[0]===203&&x[1]===0&&x[2]===113);}
export async function downloadPublicAsset(url,redirects=0){
 const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||isIP(u.hostname)||u.hostname==='localhost'||/\.(?:internal|localhost|local)$/.test(u.hostname))throw Error('website_asset_url_denied');
 const addresses=await lookup(u.hostname,{family:4,all:true});if(!addresses.length||addresses.some(x=>!publicIPv4(x.address)))throw Error('website_asset_address_denied');const address=addresses[0].address;
 return new Promise((resolve,reject)=>{const req=https.get(u,{lookup:(_h,options,done)=>done(null,options?.all?[{address,family:4}]:address,4),headers:{accept:'*/*'},timeout:25000},res=>{
  if(res.statusCode>=300&&res.statusCode<400&&res.headers.location){res.resume();if(redirects>=3)return reject(Error('website_asset_redirect_limit'));downloadPublicAsset(new URL(res.headers.location,u).href,redirects+1).then(resolve,reject);return;}
  if(res.statusCode!==200||Number(res.headers['content-length']??0)>25000000){res.resume();return reject(Error('website_asset_download_failed'));}
  const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>25000000)req.destroy(Error('website_asset_too_large'));else chunks.push(chunk);});res.on('end',()=>resolve(Buffer.concat(chunks)));res.on('error',reject);
 });req.on('timeout',()=>req.destroy(Error('website_asset_timeout')));req.on('error',reject);});
}
export function websiteAssets({ledger,download=downloadPublicAsset,request=fetch,token=()=>process.env.OPERATIONS_WEB_TOKEN}){
 return {async stage(input,requestId){
  if(typeof input.url!=='string'||input.url.length>3000||input.sha256!==undefined&&!/^[a-f0-9]{64}$/.test(input.sha256))throw Error('website_asset_input_invalid');
  const id='asset_'+digest('sha256',requestId).slice(0,32),key='website-asset:'+id,old=await ledger.get(key);if(old){if(old.result?.url!==input.url||old.result?.expectedSha256!==(input.sha256??null))throw Error('website_asset_request_conflict');if(old.status==='completed')return old.result.asset;throw Error('website_asset_outcome_unknown');}
  const bytes=await download(input.url),sha=digest('sha1',bytes),sha256=digest('sha256',bytes);if(input.sha256&&input.sha256!==sha256)throw Error('website_asset_hash_mismatch');
  const asset={id,sha,sha256,size:bytes.length},reserved=await ledger.reserveOci(key,{url:input.url,expectedSha256:input.sha256??null},{url:input.url,expectedSha256:input.sha256??null,asset});if(!reserved.created)throw Error('website_asset_outcome_unknown');
  const r=await request('https://api.vercel.com/v2/files?teamId=team_uolDmrwvORBaI3V7q4JVMKNS',{method:'POST',headers:{authorization:'Bearer '+token(),'content-type':'application/octet-stream','x-vercel-digest':sha,'content-length':String(bytes.length)},body:bytes,redirect:'error',signal:AbortSignal.timeout(45000)});if(!r.ok)throw Error('website_asset_upload_unavailable');await ledger.complete(key,{url:input.url,expectedSha256:input.sha256??null,asset});return asset;
 },async read(id){if(!/^asset_[a-f0-9]{32}$/.test(id??''))throw Error('website_asset_id_invalid');const row=await ledger.get('website-asset:'+id);if(row?.status!=='completed')throw Error('website_asset_not_ready');return row.result.asset;}};
}
