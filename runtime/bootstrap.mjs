import {Pool,neonConfig} from '@neondatabase/serverless';
import ws from 'ws';
import {createApplication} from './server.mjs';
import {openPostgresStore} from '../src/postgres/index.mjs';
import {openStore} from '../src/storage/index.mjs';
import {openAppPostgres} from '../src/app-storage/index.mjs';
import {readDatabaseBoundary} from './database-boundary.mjs';
import {sourceObjects} from './source-objects.mjs';
import {imageArchive} from './image-objects.mjs';
import {ociPorts} from './oci-ports.mjs';
import {infrastructurePorts} from './infrastructure-ports.mjs';
import {inferencePorts} from './inference-ports.mjs';
import {contractIntakePorts} from './contract-intake-config.mjs';
import {operatorConfig} from './operator-config.mjs';
import {readonlyPorts} from './readonly-ports.mjs';
import {dealPorts} from './deal-ports.mjs';
import {requireThat} from '../src/shared/index.mjs';

// One configuration path for the existing API host and portable HTTP server.
// Constructing a runtime never starts a worker, creates a resource or migrates.
export async function openRuntime({env=process.env,allowLocal=false}={}){
 let pool,store,closed=false;
 const close=async()=>{if(closed)return;closed=true;if(store)await store.close();else if(pool)await pool.end();};
 try{
  let databaseBoundary;
  if(env.CLAUS_NETWORK_DATABASE_URL){
   requireThat(env.CLAUS_NETWORK_ORIGIN,'runtime_unconfigured');
   neonConfig.webSocketConstructor=ws;
   pool=new Pool({connectionString:env.CLAUS_NETWORK_DATABASE_URL,max:3,connectionTimeoutMillis:8000});
   pool.on('error',()=>{});
   databaseBoundary=()=>readDatabaseBoundary(pool);
   await databaseBoundary();
   store=await openPostgresStore({pool});
  }else{
   requireThat(allowLocal&&env.CLAUS_NETWORK_LOCAL==='1','database_required');
   requireThat(env.CLAUS_APPS_ENABLED!=='1','local_app_storage_unavailable');
   store=openStore(env.CLAUS_NETWORK_LOCAL_FILE??'network-local.sqlite');
   databaseBoundary=async()=>{await store.read('network','authority');return {profile:'local-sqlite',verified:false};};
  }
  const intakePorts=contractIntakePorts(env),oci=ociPorts({env}),infrastructure=infrastructurePorts({env});
  const app=createApplication({
   store,origin:env.CLAUS_NETWORK_ORIGIN??'https://claus.si',rateSalt:env.CLAUS_NETWORK_RATE_SALT,
   imageArchive:await imageArchive(env),sourceObjects:await sourceObjects(env),
   infrastructurePorts:infrastructure.ports,infrastructureEnabled:infrastructure.enabled,
   ociBuildPorts:oci.ports,ociBuildEnabled:oci.enabled,inferencePorts:inferencePorts({env}),
   arbitrationEnabled:env.CLAUS_DEAL_ARBITRATION_ENABLED==='1',workersEnabled:env.CLAUS_WORKERS_ENABLED==='1',domainsEnabled:env.CLAUS_DOMAINS_ENABLED==='1',
   dealPorts:dealPorts(env),appWritesEnabled:env.CLAUS_APPS_WRITES_ENABLED!=='0',
   appStorage:env.CLAUS_APPS_ENABLED==='1'?await openAppPostgres({pool}):null,
   operatorPorts:operatorConfig(env),chainPorts:readonlyPorts(env),intakePorts,
   partnerLaunchAssignment:env.CLAUS_PARTNER_LAUNCH_ASSIGNMENT
  });
  return {app,store,intakePorts,databaseBoundary,close};
 }catch(error){await close().catch(()=>{});throw error;}
}
