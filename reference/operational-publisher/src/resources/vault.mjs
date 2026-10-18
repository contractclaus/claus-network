import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
const key=()=>{const value=process.env.RESOURCE_VAULT_KEY;if(!/^[a-f0-9]{64}$/.test(value??''))throw Error('resource_vault_unavailable');return Buffer.from(value,'hex');};
export function sealSecret(value,binding,master=key()){
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',master,iv);cipher.setAAD(Buffer.from(binding));
 const ciphertext=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return {version:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};
}
export function openSecret(envelope,binding,master=key()){
 if(envelope?.version!==1)throw Error('resource_secret_version');const cipher=createDecipheriv('aes-256-gcm',master,Buffer.from(envelope.iv,'base64'));cipher.setAAD(Buffer.from(binding));cipher.setAuthTag(Buffer.from(envelope.tag,'base64'));return Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext,'base64')),cipher.final()]).toString('utf8');
}
export function secretMetadata(value){return {id:value.id,name:value.name,kind:value.kind,revision:value.revision,version:value.version,status:value.status,createdAt:value.createdAt,updatedAt:value.updatedAt,expiresAt:value.expiresAt??null};}
export function newSecretValue(){return randomBytes(32).toString('base64url');}
