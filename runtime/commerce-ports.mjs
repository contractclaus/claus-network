import {commerceChain,address} from '../adapters/commerce-chain.mjs';
import {requireThat} from '../src/shared/index.mjs';
export function commercePorts(env=process.env){return {
 enabled:env.CLAUS_COMMERCE_ENABLED==='true'&&address(env.CLAUS_MERCHANT_ADDRESS)&&typeof env.CLAUS_MERCHANT_SECRET==='string'&&env.CLAUS_MERCHANT_SECRET.length>=40,
 merchant:env.CLAUS_MERCHANT_ADDRESS,chain:commerceChain(),
 settle:async input=>{const r=await fetch('https://claus-ecosystem-payments.vercel.app/api/merchant/settlement',{method:'POST',headers:{authorization:'Bearer '+env.CLAUS_MERCHANT_SECRET,'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(45000),redirect:'error'});const b=await r.json();requireThat(r.ok&&b.profile==='claus-merchant-settlement/1','commerce_settlement_unavailable');return b;}
};}
