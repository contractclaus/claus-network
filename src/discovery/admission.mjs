import {createPrivateKey, randomBytes, sign} from 'node:crypto';
import {digest, requireThat} from '../shared/index.mjs';

export const SEARCH_SERVICE='prj_de70d4aa-0804-4a94-8097-7a9a34f0a28a';
export const ADMISSION_DOMAIN='claus-semantic-admission/2\n';

// The existing operator key signs a separate protocol, never arbitrary bytes.
// Tickets carry no wallet, provider or project-administration authority.
export function createSearchAdmission({store,identity,signingKey,now=Date.now}) {
  const key=signingKey?createPrivateKey(signingKey):null;
  if(key)requireThat(key.asymmetricKeyType==='ed25519','search_admission_unavailable');
  return {
    async issue(actor,{projectId,path,bodyHash}) {
      requireThat(key,'search_admission_unavailable');
      requireThat(['/v1/search','/v1/embeddings'].includes(path)&&/^[a-f0-9]{64}$/.test(bodyHash),'invalid_input');
      const principal=await store.transaction(async tx=>{
        await identity.authorize(actor,'service.call',{projectId},tx);
        const who=await identity.credential(actor,tx);
        requireThat(who.kind!=='app','scope_denied');
        const owner=(await tx.read('projects',projectId))?.value.ownerId;
        requireThat(typeof owner==='string'&&/^[A-Za-z0-9_:.-]{1,160}$/.test(owner),'scope_denied');
        const id=digest({protocol:'search-admission/2',owner});
        const old=await tx.read('search-admission',id);
        const at=Math.max(now(),old?.value.at??0);
        const previous=old?.value.units??Math.round((old?.value.tokens??120)*1000);
        const available=Math.min(120000,previous+Math.max(0,at-(old?.value.at??at))*2);
        if(available<1000)throw Object.assign(Error('rate_limited'),{code:'rate_limited',retryAfterSeconds:1});
        await tx.write('search-admission',id,{units:available-1000,at},old?.revision??0);
        return {sub:who.principalId,owner};
      });
      const at=now();
      const claims={v:2,aud:SEARCH_SERVICE,...principal,path,bodyHash,iat:at,exp:at+20000,nonce:randomBytes(16).toString('hex')};
      const bytes=Buffer.from(JSON.stringify(claims));
      const signature=sign(null,Buffer.concat([Buffer.from(ADMISSION_DOMAIN),bytes]),key);
      return {ticket:bytes.toString('base64url')+'.'+signature.toString('base64url'),expiresAt:claims.exp,service:SEARCH_SERVICE};
    }
  };
}
