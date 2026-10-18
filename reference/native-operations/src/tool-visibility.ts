// Public tool journals must not turn task-party messages or operating finances
// into public API data. Tool output still reaches Claus's private continuation.
export function privateNetworkTool(name:string,args:any,result?:any){
 if(name==='manage_resources'||name==='manage_website'||name==='external_tools')return true;
 if(name==='read_knowledge'&&args?.id==='runtime:current')return true;
 if(['recall','remember'].includes(name)&&result?.visibility==='private_network')return true;
 if(name==='partner_launch'||name==='capital_execution'||name==='investment_proposal'||name==='programmable_api')return true;
 if(name==='develop_project'||name==='stage_development')return true;
 if(name==='trade_program'||name==='work_wallet'||name==='network_work'||name==='run_network_program'||name==='resume_network_operation')return true;
 if(name==='network_care')return !['publish','announce','public','withdraw'].includes(args?.action);
 if(name==='build_network'){let input:any;try{input=JSON.parse(args?.input??'{}');}catch{return true;}return !(['project_publish','agent_publish','agent_work_profile_set','source_publish','app_publish'].includes(args?.operation)&&input.published===true);}
 return false;
}
