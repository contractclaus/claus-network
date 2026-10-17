import {isolatedHealth} from '../src/isolated/bridge.mjs';
import {contractIntakeHealth} from './contract-intake-config.mjs';
export async function runtimeHealth({app,store,intakePorts,databaseBoundary},env=process.env){
      const boundary = await databaseBoundary();
      const names=['review','chain','collaboration','wallets','vaults','portability'];
      const roles=['review','controller','executor','services','wallets','vaults'];
      const [,caps,health]=await Promise.all([store.read('network','authority'),store.readMany('network-capabilities',names),store.readMany('worker-health',roles)]);
      const review=caps.get('review')?.value,worker=health.get('review')?.value;
      const enabled=review?.enabled===true,recent=worker?.observedAt>Date.now()-300000;
      const chain=caps.get('chain')?.value,controller=health.get('controller')?.value,executor=health.get('executor')?.value;
      const collaboration=caps.get('collaboration')?.value,wallets=caps.get('wallets')?.value,serviceWorker=health.get('services')?.value,walletWorker=health.get('wallets')?.value;
      const vaults=caps.get('vaults')?.value,vaultWorker=health.get('vaults')?.value,portability=caps.get('portability')?.value;
      const publicAccess = await app.access.discovery();
      const intakeState = await contractIntakeHealth(store, intakePorts);
      return Response.json({ service: 'Claus Network', status: 'ok', databaseBoundary:boundary, isolatedAnalysis:await isolatedHealth(),
        release: env.CLAUS_NETWORK_RELEASE ?? null,
        sourceStorage:{profile:app.sourceFiles.enabled?'private-r2-with-inline-small-files':'database', inlineMaxBytes:4096},
        capabilities: ['identity', 'project.registry', 'source.snapshot', 'build.compile', 'public.projection'],
        projectAccess: publicAccess.projectAccess,
        admission: publicAccess,
        reviewExecution: enabled ? recent ? publicAccess.reviews.admission : 'worker_unavailable' : 'not_enabled',
        testnetExecution: chain?.enabled === true ? controller?.observedAt > Date.now() - 300000 && executor?.observedAt > Date.now() - 300000 ? publicAccess.chainProfiles[0].admission : 'worker_unavailable' : 'not_enabled',
        collaborationExecution: collaboration?.enabled === true ? serviceWorker?.observedAt > Date.now() - 300000 ? publicAccess.collaboration.admission : 'worker_unavailable' : 'not_enabled',
        walletExecution: wallets?.enabled === true ? walletWorker?.observedAt > Date.now() - 300000 ? 'restricted_pilot' : 'worker_unavailable' : 'not_enabled',
        vaultExecution: vaults?.enabled === true ? vaultWorker?.observedAt > Date.now() - 300000 ? 'restricted_pilot' : 'worker_unavailable' : 'not_enabled',
        portabilityExecution: portability?.enabled === true ? publicAccess.collaboration.admission : 'not_enabled',
        applications: { enabled: app.apps.enabled, profile: 'managed-records-and-tasks-v1', limits: app.apps.limits },
        inferenceExecution: publicAccess.publicInference,
        contractIntakeExecution: intakeState,
        mainnetContractIntakeExecution: await contractIntakeHealth(store, intakePorts, Date.now(), 1),
        mainnetExecution: publicAccess.mainnet === 'public_readonly' ?
          controller?.chains?.includes(1) && executor?.chains?.includes(1) &&
          controller.observedAt > Date.now() - 300000 && executor.observedAt > Date.now() - 300000 ? 'public_readonly' : 'worker_unavailable' : 'not_enabled' });
}
