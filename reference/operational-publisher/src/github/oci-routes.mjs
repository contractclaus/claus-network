import {authorized} from '../policy.js';
import {publisherLedger} from '../publisher/repository.js';
import {createOciBroker} from './oci.mjs';
export function installOciRoutes(app){
  let broker;
  app.post('/api/oci-builds',async c=>{
    if(process.env.SERVICE_ROLE!=='operator')return c.json({error:'oci_not_configured'},503);
    if(!authorized(c.req.header('authorization'),process.env.CLAUS_OCI_NETWORK_SECRET))return c.json({error:'unauthorized'},401);
    try{const raw=await c.req.text();if(Buffer.byteLength(raw)>4096)return c.json({error:'request_too_large'},413);
      const result=await(broker??=createOciBroker({ledger:publisherLedger()}))(JSON.parse(raw));return c.json({result});
    }catch(e){return c.json({error:/^oci_[a-z0-9_]+$/.test(e?.message??'')?e.message:'oci_outcome_unknown'},409);}
  });
}
