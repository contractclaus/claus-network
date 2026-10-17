import {amount,digest,requireThat,text} from '../shared/index.mjs';
import {balance} from '../billing/index.mjs';
import {operatingProject} from '../operating-access/index.mjs';

// Host-only reconciliation. Balances and permissions are not deposits.
export function createFundingReconciler({store,ports,now=()=>Date.now()}) {
  return async function reconcileFunding() {
    const id='runpod',row=await store.read('infrastructure-funding',id);
    if(!row?.value.enabled||typeof ports.fundingHistory!=='function')return {state:'not_configured'};
    const config=row.value;
    if(config.nextAt>now())return {state:'scheduled',nextAt:config.nextAt};
    const from=Math.max(config.startedAt,(config.through??config.startedAt)-86400000);
    const to=Math.min(now(),from+7*86400000);
    const result=await ports.fundingHistory({profileId:config.profileId,from,to});
    requireThat(result.provider==='runpod'&&result.accountId===config.accountId&&result.providerAccountId===config.providerAccountId&&result.from===from&&result.to===to,'infrastructure_funding_account_mismatch');
    requireThat(Number.isSafeInteger(result.observedAt)&&Math.abs(now()-result.observedAt)<300000&&Array.isArray(result.receipts)&&result.receipts.length<=500,'infrastructure_funding_observation_invalid');
    amount(result.balanceMicroUsd);
    return store.transaction(async tx=>{
      const current=await tx.read('infrastructure-funding',id);
      requireThat(current?.revision===row.revision&&current.value.enabled,'infrastructure_funding_changed');
      const funds=await balance(tx,config.fundingAccount,'USD');
      const previousTotal=amount(config.fundedTotal);
      requireThat(amount(funds.available)+amount(funds.reserved)+amount(funds.spent)===previousTotal,'infrastructure_funding_ledger_mismatch');
      let added=0n,count=0;
      for(const receipt of result.receipts) {
        text(receipt.id);amount(receipt.amount);
        requireThat(receipt.type==='RELOAD'&&receipt.medium==='STRIPE'&&amount(receipt.amount)>0n&&Number.isSafeInteger(receipt.completedAt)&&receipt.completedAt>=from&&receipt.completedAt<=to,'infrastructure_funding_receipt_invalid');
        const receiptKey=digest({provider:'runpod',providerAccountId:result.providerAccountId,transactionId:receipt.id});
        const hash=digest(receipt),old=await tx.read('infrastructure-funding-receipts',receiptKey);
        if(old){requireThat(old.value.hash===hash&&old.value.fundingAccount===config.fundingAccount,'infrastructure_funding_receipt_conflict');continue;}
        const receiptId='runpod:'+receiptKey;
        requireThat(!await tx.read('funding-receipts',receiptId),'infrastructure_funding_receipt_conflict');
        const funding={account:config.fundingAccount,asset:'USD',amount:receipt.amount,receiptId};
        await tx.write('funding-receipts',receiptId,{...funding,hash:digest(funding)},0);
        await tx.write('infrastructure-funding-receipts',receiptKey,{hash,fundingAccount:config.fundingAccount,receiptId,receipt,observedAt:result.observedAt},0);
        added+=amount(receipt.amount);count++;
        await tx.event({type:'funding.recorded',...funding,provider:'runpod',at:now()});
      }
      const total=previousTotal+added;
      if(added>0n) {
        const key=digest({account:config.fundingAccount,asset:'USD'}),old=await tx.read('balances',key);
        await tx.write('balances',key,{...funds,available:(amount(funds.available)+added).toString()},old.revision);
        // Only enrolled own-project ceilings follow confirmed deposits.
        // Smaller deliberate limits and revoked grants remain untouched.
        for(const profileId of config.followProfiles) {
          const policy=await tx.read('infrastructure-controls',profileId),p=policy?.value;
          if(!p?.enabled||!p.pooledFunding||p.providerFundingId!==id||p.expiresAt!==null||p.fundingAccount!==config.fundingAccount||p.totalLimit!==config.fundedTotal||p.perProjectLimit!==config.fundedTotal)continue;
          let extra=0n,after='';
          for(;;){
            const grants=await tx.list('infrastructure-grants',{after,limit:100});
            for(const g of grants){
              if(g.value.profileId!==profileId||!g.value.enabled||g.value.expiresAt!==null||g.value.limit!==config.fundedTotal||!await operatingProject(tx,g.value.projectId))continue;
              await tx.write('infrastructure-grants',g.id,{...g.value,limit:total.toString(),updatedAt:now()},g.revision);extra+=added;
            }
            if(grants.length<100)break;after=grants.at(-1).id;
          }
          await tx.write('infrastructure-controls',profileId,{...p,totalLimit:total.toString(),perProjectLimit:total.toString(),allocated:(amount(p.allocated)+extra).toString()},policy.revision);
        }
      }
      const summary={state:'observed',observedAt:result.observedAt,added:added.toString(),receiptsAdded:count,fundedTotal:total.toString(),providerBalance:result.balanceMicroUsd};
      await tx.write('infrastructure-funding',id,{...config,through:to,nextAt:now()+300000,fundedTotal:total.toString(),last:summary},row.revision);
      return summary;
    });
  };
}
