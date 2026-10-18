import {createRepositoryPublisher} from '../github/publication.mjs';
import {authorized} from '../policy.js';
import {OperationsHostError} from './host.js';
import {createPublisher} from './service.js';
import {publisherRepository,publisherLedger} from './repository.js';
let production,repositoryProduction;
export function installPublisherRoutes(app,{role=()=>process.env.SERVICE_ROLE,secret=()=>process.env.PUBLISHER_SECRET,enabled=()=>process.env.PUBLISHER_ENABLED==='true',service=()=>production??=(createPublisher({repository:publisherRepository(),ledger:publisherLedger()}))}={}){
 const handle=repositoryMode=>async c=>{
  if(role()!=='operator'||!enabled())return c.json({error:'publisher_disabled'},403);
  if(!authorized(c.req.header('authorization'),secret()))return c.json({error:'unauthorized'},401);
  try{
   const raw=await c.req.text();if(Buffer.byteLength(raw)>3500000)return c.json({error:'request_too_large'},413);
   const v=JSON.parse(raw);if(repositoryMode&&v?.scope!=='repository')return c.json({error:'publisher_scope_invalid'},400);
   if(!v||typeof v!=='object'||Object.keys(v).sort().join(',')!=='args,operation,scope')return c.json({error:'publisher_input_invalid'},400);
   return c.json({result:await (repositoryMode?(repositoryProduction??=createRepositoryPublisher({repository:publisherRepository(),ledger:publisherLedger()})):service()).call(v.operation,v.scope,v.args)});
  }catch(e){
   if(e instanceof OperationsHostError)return c.json({error:'publisher_provider_error',providerStatus:e.status,providerCode:e.code},502);
   return c.json({error:/^(publisher|operations|isolated)_[a-z_]+$/.test(e?.message??'')?e.message:'publisher_unavailable'},409);
  }
 };
 app.post('/api/publisher',handle(false));
 app.post('/api/repository-publisher',handle(true));
}
