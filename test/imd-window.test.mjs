import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/storage/index.mjs';
import { createSealer } from '../adapters/secrets.mjs';
import { createImdReviewProvider, IMD_REVIEW } from '../adapters/imd.mjs';
import { digest } from '../src/shared/index.mjs';

test('a shortening IMD challenge window preserves the exact quote and never enlarges payment authority', async t => {
  const store=openStore(':memory:');t.after(()=>store.close());
  const now=Date.now(), seconds=Math.floor(now/1000);
  let request, quote, timeout=161, payTo=IMD_REVIEW.payTo;
  const provider=createImdReviewProvider({store,sealer:createSealer('12'.repeat(32)),now:()=>now,
    resolveInput:async()=>({repoUrl:'https://github.com/example/contracts',baseCommit:'a'.repeat(40),contracts:['src/Example.sol'],sourceHash:digest('source'),buildHash:digest('build')}),
    fetch:async(url,options)=>{
      if(url.endsWith('/quote')){
        request=JSON.parse(options.body);
        quote={v:1,id:'bounded-window',action:'job.open',policyVersion:'job-1',issuedAt:seconds-439,expiresAt:seconds+161,
          inputHash:digest(request.input).slice(7),quoteHash:'b'.repeat(64),
          payment:{scheme:'exact',network:IMD_REVIEW.network,asset:IMD_REVIEW.asset,payTo:IMD_REVIEW.payTo,decimals:18,amount:IMD_REVIEW.maximum},
          terms:{purchase:'action-admission',resultGuaranteed:false}};
        return Response.json({order:{requestKey:request.requestKey,quote}});
      }
      const resourceUrl=IMD_REVIEW.origin+'/requests/bounded-window';
      return Response.json({quote,input:request.input,x402Version:2,resourceUrl,resource:{url:resourceUrl},requesterScopeHash:'c'.repeat(64),
        accepts:[{...quote.payment,payTo,maxTimeoutSeconds:timeout,extra:{assetTransferMethod:'permit2'}}]}, {status:402});
    }});
  await provider.quote({projectId:'project',inputHash:digest('input'),quoteId:'quote'});
  assert.equal((await provider.challenge('bounded-window')).accepts[0].maxTimeoutSeconds,161);
  for (timeout of [300,1]) await provider.challenge('bounded-window');
  for (timeout of [0,301,1.5,'161']) await assert.rejects(provider.challenge('bounded-window'),{code:'provider_terms_changed'});
  timeout=161;payTo='0x'+'1'.repeat(40);
  await assert.rejects(provider.challenge('bounded-window'),{code:'provider_terms_changed'});
});
