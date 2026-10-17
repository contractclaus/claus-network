import {createCipheriv,createDecipheriv,createHmac,randomBytes} from 'node:crypto';
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const check=(v,c)=>{if(!v)throw Object.assign(Error(c),{code:c});};
export function privateScope(work){
 const {id,projectId,planId,sourceHash}=work;
 check([id,planId,sourceHash].every(x=>/^sha256:[a-f0-9]{64}$/.test(x??''))&&typeof projectId==='string'&&projectId.length<=128,'oci_private_scope_invalid');
 return {id,projectId,planId,sourceHash,visibility:'private'};
}
export function privateContextKey(secret,work){check(typeof secret==='string'&&secret.length>=32,'oci_private_key_unavailable');return createHmac('sha256',secret).update('claus-private-context/1\n'+canonical(privateScope(work))).digest();}
export function sealPrivateContext(secret,work,payload){
 const scope=privateScope(work),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',privateContextKey(secret,scope),iv);
 const raw=Buffer.from(JSON.stringify(payload));check(raw.length<=3200000,'oci_source_too_large');cipher.setAAD(Buffer.from(canonical(scope)));
 const ciphertext=Buffer.concat([cipher.update(raw),cipher.final()]);
 return {profile:'claus-private-context/1',scope,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};
}
export function openPrivateContext(key,envelope){
 check(Buffer.isBuffer(key)&&key.length===32&&envelope?.profile==='claus-private-context/1','oci_private_context_invalid');
 const scope=privateScope(envelope.scope),iv=Buffer.from(envelope.iv??'','base64'),tag=Buffer.from(envelope.tag??'','base64'),ciphertext=Buffer.from(envelope.ciphertext??'','base64');
 check(iv.length===12&&tag.length===16&&ciphertext.length<=3200000,'oci_private_context_invalid');
 const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(Buffer.from(canonical(scope)));decipher.setAuthTag(tag);
 let payload;try{payload=JSON.parse(Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString('utf8'));}catch{check(false,'oci_private_context_invalid');}
 check(payload.buildId===scope.id&&payload.plan?.id===scope.planId&&payload.plan?.projectId===scope.projectId&&payload.plan?.sourceHash===scope.sourceHash,'oci_private_context_invalid');return payload;
}
