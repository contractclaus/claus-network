import type {Configuration} from './config.js';
import {externalStatus} from './external/providers.js';
const groups:Record<string,string[]>={
 external:['external_tools'],
 business:['capital_execution','investment_proposal','programmable_api','partner_launch'],
 development:['develop_project','stage_development','run_experiment','read_prototype'],
 network:['read_network','build_network','network_work','network_care','run_network_program','resume_network_operation'],
 publishing:['read_network_code','change_network_code','read_operational_code','change_operational_code','rollback_operational_code'],
 funds:['work_wallet','trade_program','wallet_execute','wallet_sign','wallet_replace'],
 research:['read_url','search_web','read_developments','read_reference','read_chain','read_contract_source','read_market'],
 social:['read_x','read_x_account','read_x_thread','publish_post','publish_reply'],
 media:['read_image','generate_image','review_image','prepare_gif']
};
export function runtimeAccess(config:Configuration,channel:'public'|'club',exposed:string[],permitted:(name:string)=>boolean,controls:any[]=[]){
 const names=[...new Set(exposed)].sort(),allowed=names.filter(permitted),blocked=names.filter(n=>!allowed.includes(n));
 const services=Object.fromEntries(Object.entries(groups).map(([group,tools])=>[group,{exposed:tools.filter(n=>names.includes(n)),executionGateOpen:tools.filter(n=>allowed.includes(n))}]));
 return {observedAt:new Date().toISOString(),channel,configurationRevision:(config as any).revision??null,
  externalProviders:channel==='club'?null:externalStatus(),exposedTools:names,executionGateOpen:allowed,executionGateClosed:blocked,services,
  operationalScopes:channel==='club'?[]:['web','api','native','repository'].map(scope=>{const c=controls.find(x=>x?.scope===scope);return c&&typeof c.enabled==='boolean'?{scope,observation:'available',enabled:c.enabled,revision:c.revision,deployment:c.deployment}:{scope,observation:'unavailable',enabled:null};}),
  costSources:channel==='club'?[]:[
   {service:'jobs',tool:'work_wallet',operation:'status',request:{operation:'status',input:'{}'},meaning:'Current separate ETH/CLAUS principal, gas, reservations and actual charges; balance is not revenue.'},
   {service:'projects',tool:'build_network',operation:'compute_grants',request:{operation:'compute_grants',describe:true},requiredInput:['profileId'],meaning:'Describe first, then use the existing policy profileId to read original grants and committed usage. Continue any cursor; a new API key does not reset the budget.'},
   {service:'programs',tool:'trade_program',operation:'overview',request:{operation:'overview',input:'{}'},meaning:'Read the active module, original program IDs and gas allowance first. Use status with an existing id for its original transactions. Independent review has its own quote and settlement.'},
   {service:'builder',tool:'network_care',action:'economics',request:{action:'economics'},meaning:'Current Builder usage is separate from wallet expenditure.'}
  ].filter(source=>allowed.includes(source.tool)),instructionAuthority:false,
  scope:'Exposed schemas and current local invocation gates, not proof of remote availability, authorization of a particular resource, successful execution or permission to spend. Service policy, quotas, review and original effects still apply. Unavailable scope observations are unknown, never enabled. Re-read after a configuration change. An unavailable execution adapter does not make an idea technically impossible: use available research and project development to assess it, retain concrete missing integration/authority in the original work, and do not promise an unsupported launch. Preparation grants no transaction authority.'};
}
