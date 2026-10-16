import {authorized} from '../policy.js';
import {createNetworkAccess} from '../jobs-wallet/network.js';
import {walletRepository} from '../wallet-store.js';
import {createPartnerGateway} from './service.mjs';

const str={type:'string',minLength:1,maxLength:256};
const route=(method,path,properties)=>({method,path,inputSchema:{type:'object',properties,required:Object.keys(properties),additionalProperties:false}});
export function productionPartnerGateway(env=process.env){
 const network=createNetworkAccess({extraRoutes:{
  partner_launch_prepare:route('GET','/v1/projects/{projectId}/partner-launches/reviews/{caseId}/prepare',{projectId:str,caseId:str}),
  partner_launch_evidence:route('GET','/v1/projects/{projectId}/partner-launches/reviews/{caseId}',{projectId:str,caseId:str}),
  public_source:{...route('GET','/v1/public/sources/{sourceId}',{sourceId:str}),public:true}
 }});
 return createPartnerGateway({network,repository:walletRepository(),pins:env.CLAUS_PARTNER_LAUNCH_ASSIGNMENT,
  key:()=>env.PROGRAMMABLE_PARTNER_API_KEY});
}
export function installPartnerGateway(app,{env=process.env,service=()=>productionPartnerGateway(env)}={}){
 app.post('/api/partner-launch',async c=>{
  if(env.SERVICE_ROLE!=='operator'||!authorized(c.req.header('authorization'),env.CAPITAL_EXECUTION_SECRET))return c.json({error:'unauthorized'},401);
  try{
   const raw=await c.req.text();if(Buffer.byteLength(raw)>2048)return c.json({error:'request_too_large'},413);
   const body=JSON.parse(raw);
   if(!body||Object.keys(body).sort().join(',')!=='input,operation'||!['profile','stage','preflight','submit','admit','status'].includes(body.operation))return c.json({error:'partner_gateway_invalid_operation'},400);
   const expected=body.operation==='profile'?[]:body.operation==='stage'?['caseId','projectId']:body.operation==='admit'?['operationId','receiptId']:body.operation==='status'?['operationId']:['receiptId'];
   if(!body.input||Array.isArray(body.input)||Object.keys(body.input).sort().join(',')!==expected.join(','))return c.json({error:'partner_gateway_invalid_input'},400);
   return c.json(await service()[body.operation](body.input));
  }catch(e){return c.json({error:/^partner_gateway_[a-z_]+$/.test(e?.message)?e.message:'partner_gateway_unavailable',outcome:'inspect_original'},409);}
 });
}
