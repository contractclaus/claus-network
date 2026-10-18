import exportScope from './runtime-export-scope.json' with {type:'json'};
import {createCipheriv,createHash,createPublicKey,publicEncrypt,randomBytes,timingSafeEqual,constants} from 'node:crypto';

// Runtime-only credentials are exported encrypted to the existing recovery key.
// The request cannot select a key, environment variable, destination or command.
export function runtimeExport(authorization,env=process.env,scope=exportScope){
 const secret=env.CONTINUITY_EXPORT_SECRET,recipient=env.CONTINUITY_EXPORT_PUBLIC_KEY;
 const reject=(status,error)=>Response.json({error},{status,headers:{'cache-control':'no-store'}});
 if(typeof secret!=='string'||secret.length<40||typeof recipient!=='string')return reject(503,'recovery_export_unavailable');
 const expected=Buffer.from('Bearer '+secret),supplied=Buffer.from(typeof authorization==='string'?authorization:'');
 if(expected.length!==supplied.length||!timingSafeEqual(expected,supplied))return reject(401,'unauthorized');
 if(!['native','custody','payer','web'].includes(scope.service)||!Array.isArray(scope.keys)||scope.keys.some(k=>!/^[_A-Z][_A-Z0-9]{1,100}$/.test(k)))return reject(503,'recovery_export_scope_invalid');
 const present=scope.keys.filter(k=>typeof env[k]==='string'),missing=scope.keys.filter(k=>typeof env[k]!=='string');
 const payload=Buffer.from(JSON.stringify({version:1,kind:'runtime-environment',service:scope.service,deployment:env.VERCEL_DEPLOYMENT_ID??null,capturedAt:new Date().toISOString(),scopeSha256:createHash('sha256').update(JSON.stringify(scope)).digest('hex'),environment:Object.fromEntries(present.map(k=>[k,env[k]])),missing}));
 const key=randomBytes(32),iv=randomBytes(12);
 try{
  const keyId=createHash('sha256').update(createPublicKey(recipient).export({type:'spki',format:'der'})).digest('hex');
  const wrapped=publicEncrypt({key:recipient,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},key);
  const header=Buffer.from(JSON.stringify({version:1,keyId,iv:iv.toString('base64'),wrapped:wrapped.toString('base64'),bytes:payload.length,sha256:createHash('sha256').update(payload).digest('hex'),metadata:{kind:'runtime-environment',service:scope.service,deployment:env.VERCEL_DEPLOYMENT_ID??null}}));
  const size=Buffer.alloc(4);size.writeUInt32BE(header.length);const prefix=Buffer.concat([Buffer.from('CLAUSBK1'),size,header]);
  const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(prefix);
  const sealed=Buffer.concat([prefix,cipher.update(payload),cipher.final(),cipher.getAuthTag()]);
  return new Response(sealed,{headers:{'content-type':'application/octet-stream','cache-control':'no-store','x-content-type-options':'nosniff'}});
 }finally{key.fill(0);payload.fill(0);}
}
