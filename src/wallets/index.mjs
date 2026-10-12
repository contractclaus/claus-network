import { copy, digest, requireThat, text } from '../shared/index.mjs';

export function createWallets({ store, identity, jobs, services, chain, now = () => Date.now() }) {
  async function allowed(actor, projectId, scope, reader = store) {
    await identity.authorize(actor, scope, { projectId }, reader);
    const cap = (await reader.read('network-capabilities', 'wallets'))?.value;
    const pilot = (await reader.read('review-pilots', projectId))?.value;
    requireThat(cap?.enabled && cap.chainId === 11155111, 'wallets_not_enabled');
    requireThat(pilot?.enabled && pilot.expiresAt > now(), 'sponsor_not_enabled');
    return cap;
  }
  async function get(reader, collection, projectId, id) {
    const row = await reader.read(collection, text(id));
    requireThat(row?.value.projectId === projectId, 'not_found'); return row;
  }
  const visible = value => { const { actor, signature, ...rest } = value; return rest; };
  async function capacity(tx,kind,projectId,maximum) {
    const key=digest({kind,projectId,day:Math.floor(now()/86400000)});
    const old=await tx.read('wallet-capacity',key);
    requireThat((old?.value.count??0)<maximum,'capacity_reached');
    await tx.write('wallet-capacity',key,{count:(old?.value.count??0)+1},old?.revision??0);
  }
  async function enqueue(tx, actor, projectId, kind, request) {
    const id = digest({ kind, projectId, request });
    const old = await tx.read('wallet-actions', id); if (old) return visible(old.value);
    await capacity(tx,'actions',projectId,32);await capacity(tx,'actions','global',128);
    const job = await jobs.enqueue(tx, { projectId, kind, authority: { actor }, payload: { actionId: id }, idempotencyKey: id });
    const value = { id, projectId, kind, request: copy(request), actor, state: 'queued', jobId: job.id, createdAt: now() };
    await tx.write('wallet-actions', id, value, 0); return visible(value);
  }
  const api = {
    allowed,
    async wallet(actor, projectId) {
      await identity.authorize(actor, 'wallet.read', { projectId });
      return (await store.read('project-wallets', projectId))?.value ?? null;
    },
    async create(actor, projectId) {
      return store.transaction(async tx => {
        const cap = await allowed(actor, projectId, 'wallet.manage', tx);
        const old = await tx.read('project-wallets', projectId);
        if (old && !['blocked','cancelled','failed'].includes(old.value.state)) return old.value;
        const attempt=(old?.value.attempt??0)+1;
        const project = (await tx.read('projects', projectId)).value;
        const owner = (await tx.read('principals', project.ownerId)).value.address;
        const action = await enqueue(tx, actor, projectId, 'wallet-deploy', {
          owner, attempt, artifactProjectId: cap.artifactProjectId, artifactHash: cap.artifactHash, expiresAt: now() + 86400000 });
        const value = { projectId, owner, attempt, chainId: 11155111, profile: 'claus-project-wallet-v1', state: 'queued', actionId: action.id };
        await tx.write('project-wallets', projectId, value, old?.revision??0); return value;
      });
    },
    async action(actor, projectId, actionId) {
      await identity.authorize(actor, 'wallet.read', { projectId });
      return visible((await get(store, 'wallet-actions', projectId, actionId)).value);
    },
    async revokeRequest(actor, projectId, sessionId) {
      await identity.authorize(actor, 'wallet.revoke', { projectId });
      const wallet = (await get(store, 'project-wallets', projectId, projectId)).value;
      requireThat(wallet.state === 'verified', 'wallet_not_verified');
      return chain.revoke(wallet, sessionId);
    },
    async prepareSession(actor, projectId, input) {
      await allowed(actor, projectId, 'wallet.manage');
      const wallet = (await get(store, 'project-wallets', projectId, projectId)).value;
      requireThat(wallet.state === 'verified', 'wallet_not_verified');
      const typedData = await chain.session(wallet, input);
      const id = digest({ projectId, typedData, kind: 'wallet-session' });
      return store.transaction(async tx => {
        await allowed(actor, projectId, 'wallet.manage', tx);
        const value = { id, projectId, wallet: wallet.address, typedData, state: 'awaiting_signature', createdAt: now() };
        const old = await tx.read('wallet-sessions', id);
        if (!old) {
          await capacity(tx,'session-requests',projectId,16);
          await tx.write('wallet-sessions', id, value, 0);
        }
        return old?.value ?? value;
      });
    },
    async submitSession(actor, projectId, { sessionId, signature }) {
      const row = await get(store, 'wallet-sessions', projectId, sessionId);
      const wallet = (await get(store, 'project-wallets', projectId, projectId)).value;
      requireThat(await chain.verify(row.value.typedData, wallet.owner, signature), 'invalid_signature');
      return store.transaction(async tx => {
        await allowed(actor, projectId, 'wallet.manage', tx);
        requireThat(Number(row.value.typedData.message.deadline) * 1000 > now(), 'session_expired');
        const action = await enqueue(tx, actor, projectId, 'wallet-session', {
          wallet: wallet.address, sessionId, typedData: row.value.typedData, expiresAt: Number(row.value.typedData.message.deadline) * 1000 });
        const old = await tx.read('wallet-action-signatures', action.id);
        if (!old) await tx.write('wallet-action-signatures', action.id, { signature }, 0);
        return action;
      });
    },
    async preparePayment(actor, projectId, { orderId, sessionId }) {
      await allowed(actor, projectId, 'wallet.pay');
      const wallet = (await get(store, 'project-wallets', projectId, projectId)).value;
      requireThat(wallet.state === 'verified', 'wallet_not_verified');
      const request = await services.paymentRequest(actor, projectId, orderId);
      const typed = await chain.payment(wallet, sessionId, request);
      const id = digest({ projectId, orderId, sessionId, generation:typed.typedData.message.generation, kind: 'wallet-payment' });
      return store.transaction(async tx => {
        await allowed(actor, projectId, 'wallet.pay', tx);
        await services.paymentRequest(actor, projectId, orderId, tx);
        const old = await tx.read('wallet-payments', id);
        if (old) return old.value;
        const value = { id, projectId, orderId, wallet: wallet.address, ...typed, state: 'awaiting_signature', createdAt: now() };
        await tx.write('wallet-payments', id, value, 0); return value;
      });
    },
    async submitPayment(actor, projectId, { paymentId, signature }) {
      const payment = (await get(store, 'wallet-payments', projectId, paymentId)).value;
      requireThat(await chain.verify(payment.typedData, payment.signer, signature), 'invalid_signature');
      return store.transaction(async tx => {
        await allowed(actor, projectId, 'wallet.pay', tx);
        const existing = await tx.read('wallet-order-actions', payment.orderId);
        if (existing) {
          requireThat(existing.value.paymentId === paymentId, 'payment_already_pending');
          return visible((await get(tx, 'wallet-actions', projectId, existing.value.actionId)).value);
        }
        await services.paymentRequest(actor, projectId, payment.orderId, tx);
        requireThat(Number(payment.typedData.message.deadline) * 1000 > now(), 'payment_expired');
        const action = await enqueue(tx, actor, projectId, 'wallet-payment', {
          wallet: payment.wallet, paymentId, orderId: payment.orderId, typedData: payment.typedData,
          expiresAt: Number(payment.typedData.message.deadline) * 1000 });
        await tx.write('wallet-order-actions', payment.orderId, { paymentId, actionId: action.id }, 0);
        await tx.write('wallet-action-signatures', action.id, { signature }, 0);
        return action;
      });
    },
    async onCancel(tx, job) {
      if (!job.kind.startsWith('wallet-')) return;
      const row = await get(tx, 'wallet-actions', job.projectId, job.payload.actionId);
      await tx.write('wallet-actions', row.value.id, { ...row.value, state: 'cancelled' }, row.revision);
      if (job.kind === 'wallet-deploy') {
        const wallet = await tx.read('project-wallets', job.projectId);
        await tx.write('project-wallets', job.projectId, { ...wallet.value, state: 'cancelled' }, wallet.revision);
      }
    },
    async runOne(executor) {
      const claim = await jobs.claim({ kinds: ['wallet-deploy', 'wallet-session', 'wallet-payment'], leaseMs: 120000 });
      if (claim.idle) return claim;
      const row = await get(store, 'wallet-actions', claim.job.projectId, claim.job.payload.actionId), value = row.value;
      const authorize = async reader => {
        await jobs.assertCurrent(claim, reader);
        const cap = await allowed(claim.job.authority.actor, value.projectId, value.kind === 'wallet-payment' ? 'wallet.pay' : 'wallet.manage', reader);
        if (value.kind === 'wallet-deploy') requireThat(cap.artifactHash === value.request.artifactHash, 'wallet_profile_changed');
        if (value.kind === 'wallet-payment') await services.paymentRequest(claim.job.authority.actor, value.projectId, value.request.orderId, reader);
        return true;
      };
      try {
        if (claim.mode === 'dispatch') await jobs.beginEffect(claim, (_job, tx) => authorize(tx));
        const result = await executor.step({ value, authorize,
          signature: (await store.read('wallet-action-signatures', value.id))?.value.signature });
        const done = result.state === 'confirmed' || result.state === 'verified';
        const failed = ['failed', 'blocked'].includes(result.state);
        if (done && value.kind === 'wallet-payment') await services.paymentConfirmed(value.request.orderId, result.paymentEvidence);
        return jobs.finish(claim, { state: done ? 'complete' : failed ? result.state : 'waiting',
          retryAt: done || failed ? null : now() + 30000, result }, async tx => {
          const old = await get(tx, 'wallet-actions', value.projectId, value.id);
          await tx.write('wallet-actions', value.id, { ...old.value, ...result, updatedAt: now() }, old.revision);
          if (value.kind === 'wallet-deploy') {
            const wallet = await tx.read('project-wallets', value.projectId);
            requireThat(wallet.value.actionId===value.id,'wallet_action_changed');
            await tx.write('project-wallets', value.projectId, { ...wallet.value, ...result }, wallet.revision);
          }
        });
      } catch (error) {
        if (error.code === 'lease_lost') return { stale: true };
        const blocked = claim.mode === 'dispatch' && ['scope_denied', 'sponsor_not_enabled', 'wallets_not_enabled', 'payment_not_pending'].includes(error.code);
        return jobs.finish(claim, { state: blocked ? 'blocked' : 'waiting', retryAt: blocked ? null : now() + 60000,
          result: { error: error.code ?? 'wallet_execution_unavailable' } }, async tx=>{
          if(!blocked)return;
          const old=await get(tx,'wallet-actions',value.projectId,value.id);
          await tx.write('wallet-actions',value.id,{...old.value,state:'blocked',error:error.code},old.revision);
          if(value.kind==='wallet-deploy') {
            const wallet=await tx.read('project-wallets',value.projectId);
            await tx.write('project-wallets',value.projectId,{...wallet.value,state:'blocked'},wallet.revision);
          }
        });
      }
    }
  };
  return api;
}
